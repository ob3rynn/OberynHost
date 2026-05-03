const crypto = require("crypto");

const config = require("../config");
const { allQuery, getQuery, runQuery } = require("../db/queries");
const { PURCHASE_STATUS } = require("../constants/status");
const { generateOpaqueToken, isOpaqueToken, sha256Hex } = require("../utils/tokens");
const { TERMINAL_SUBSCRIPTION_STATUSES } = require("./policyRules");

const SERVICE_ACCESS_PURPOSE = "service_support";
const TOKEN_PREFIX_LENGTH = 10;
const DEFAULT_PERIOD_MS = 1000 * 60 * 60 * 24 * 30;
const SERVICE_ACCESS_LINK_PLACEHOLDER = "{{SERVICE_ACCESS_LINK}}";

function getOverlapMs() {
    return Math.max(0, Number(config.serviceAccessLinks?.overlapDays || 14)) * 24 * 60 * 60 * 1000;
}

function isEnabled() {
    return config.serviceAccessLinks?.enabled !== false;
}

function hashToken(rawToken) {
    return sha256Hex(rawToken);
}

function tokenPrefix(rawToken) {
    return String(rawToken || "").slice(0, TOKEN_PREFIX_LENGTH);
}

function timingSafeEqualHex(a, b) {
    const left = Buffer.from(String(a || ""), "hex");
    const right = Buffer.from(String(b || ""), "hex");

    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function asTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function getPurchasePeriodBounds(purchase, now = Date.now()) {
    const previousEnd = asTimestamp(purchase?.stripeCurrentPeriodEnd);
    const start = asTimestamp(purchase?.stripeCurrentPeriodStart) ||
        previousEnd ||
        asTimestamp(purchase?.paidAt) ||
        asTimestamp(purchase?.createdAt) ||
        now;
    const end = previousEnd && previousEnd > start
        ? previousEnd
        : start + DEFAULT_PERIOD_MS;

    return {
        start,
        end,
        expiresAt: end + getOverlapMs()
    };
}

function buildServiceAccessUrl(rawToken) {
    if (!isOpaqueToken(rawToken)) {
        throw new Error("A valid service access token is required.");
    }

    return `${config.baseUrl}/support#accessToken=${encodeURIComponent(rawToken)}`;
}

function serializeServiceAccessLink(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        purchaseId: row.purchaseId,
        tokenPrefix: row.tokenPrefix || "",
        purpose: row.purpose || SERVICE_ACCESS_PURPOSE,
        billingPeriodStart: asTimestamp(row.billingPeriodStart),
        billingPeriodEnd: asTimestamp(row.billingPeriodEnd),
        expiresAt: asTimestamp(row.expiresAt),
        active: Boolean(row.active),
        createdAt: asTimestamp(row.createdAt),
        lastUsedAt: asTimestamp(row.lastUsedAt),
        revokedAt: asTimestamp(row.revokedAt),
        rotatedAt: asTimestamp(row.rotatedAt),
        rotatedFromId: row.rotatedFromId || null
    };
}

async function listServiceAccessLinksForPurchase(purchaseId) {
    const rows = await allQuery(
        `SELECT *
         FROM serviceAccessLinks
         WHERE purchaseId = ?
         ORDER BY createdAt DESC, id DESC`,
        [purchaseId]
    );

    return rows.map(serializeServiceAccessLink);
}

async function getCurrentServiceAccessLink(purchaseId, options = {}) {
    const now = Number(options.now || Date.now());

    return getQuery(
        `SELECT *
         FROM serviceAccessLinks
         WHERE purchaseId = ?
           AND purpose = ?
           AND active = 1
           AND revokedAt IS NULL
           AND expiresAt >= ?
         ORDER BY billingPeriodStart DESC, createdAt DESC, id DESC
         LIMIT 1`,
        [purchaseId, SERVICE_ACCESS_PURPOSE, now]
    );
}

async function createServiceAccessLinkForPurchase(purchase, options = {}) {
    if (!isEnabled()) {
        return null;
    }

    const now = Number(options.now || Date.now());
    const rawToken = generateOpaqueToken(48);
    const period = {
        ...getPurchasePeriodBounds(purchase, now),
        ...(options.period || {})
    };
    const active = options.active === undefined ? 1 : (options.active ? 1 : 0);

    const result = await runQuery(
        `INSERT INTO serviceAccessLinks
            (
                purchaseId,
                tokenHash,
                tokenPrefix,
                purpose,
                billingPeriodStart,
                billingPeriodEnd,
                expiresAt,
                active,
                createdAt,
                rotatedFromId
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            purchase.id,
            hashToken(rawToken),
            tokenPrefix(rawToken),
            SERVICE_ACCESS_PURPOSE,
            period.start,
            period.end,
            period.expiresAt,
            active,
            now,
            options.rotatedFromId || null
        ]
    );

    const row = await getQuery("SELECT * FROM serviceAccessLinks WHERE id = ?", [result.lastID]);

    return {
        rawToken,
        url: buildServiceAccessUrl(rawToken),
        link: serializeServiceAccessLink(row)
    };
}

async function createServiceAccessLinkForEmail(purchase, options = {}) {
    const existing = options.reuseExisting === true
        ? await getCurrentServiceAccessLink(purchase.id, options)
        : null;

    if (existing) {
        return null;
    }

    return createServiceAccessLinkForPurchase(purchase, options);
}

async function materializeServiceAccessLinkForEmail(purchaseId, options = {}) {
    if (!isEnabled() || !purchaseId) {
        return null;
    }

    const purchase = await getQuery("SELECT * FROM purchases WHERE id = ?", [purchaseId]);

    if (!purchase) {
        return null;
    }

    const created = await createServiceAccessLinkForEmail(purchase, options);

    if (created?.url) {
        return created.url;
    }

    return null;
}

async function verifyServiceAccessToken(rawToken, options = {}) {
    const now = Number(options.now || Date.now());

    if (!isEnabled() || !isOpaqueToken(rawToken)) {
        return {
            verified: false,
            reason: "missing_verified_context"
        };
    }

    const tokenHash = hashToken(rawToken);
    const row = await getQuery(
        `SELECT
            l.*,
            p.*,
            s.status AS serverStatus,
            s.type AS serverType,
            s.price AS serverPrice,
            COALESCE(p.planType, s.type) AS planType,
            l.id AS serviceAccessLinkId,
            l.createdAt AS serviceAccessLinkCreatedAt
         FROM serviceAccessLinks l
         JOIN purchases p ON p.id = l.purchaseId
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE l.tokenHash = ?
           AND l.purpose = ?
         ORDER BY l.id DESC
         LIMIT 1`,
        [tokenHash, SERVICE_ACCESS_PURPOSE]
    );

    if (!row || !timingSafeEqualHex(row.tokenHash, tokenHash)) {
        return {
            verified: false,
            reason: "unknown_verified_context"
        };
    }

    if (!row.active || row.revokedAt || Number(row.expiresAt || 0) < now) {
        return {
            verified: false,
            reason: "expired_verified_context"
        };
    }

    if (
        row.status === PURCHASE_STATUS.CANCELLED ||
        row.status === PURCHASE_STATUS.EXPIRED ||
        TERMINAL_SUBSCRIPTION_STATUSES.has(row.stripeSubscriptionStatus || "")
    ) {
        return {
            verified: false,
            reason: "expired_verified_context"
        };
    }

    await runQuery(
        "UPDATE serviceAccessLinks SET lastUsedAt = ? WHERE id = ? AND (lastUsedAt IS NULL OR lastUsedAt < ?)",
        [now, row.serviceAccessLinkId, now]
    );

    return {
        verified: true,
        purchase: row,
        purchaseId: row.purchaseId,
        serviceAccessLink: serializeServiceAccessLink({
            id: row.serviceAccessLinkId,
            purchaseId: row.purchaseId,
            tokenPrefix: row.tokenPrefix,
            purpose: row.purpose,
            billingPeriodStart: row.billingPeriodStart,
            billingPeriodEnd: row.billingPeriodEnd,
            expiresAt: row.expiresAt,
            active: row.active,
            createdAt: row.serviceAccessLinkCreatedAt,
            lastUsedAt: now,
            revokedAt: row.revokedAt,
            rotatedAt: row.rotatedAt,
            rotatedFromId: row.rotatedFromId
        })
    };
}

async function rotateServiceAccessLinkForPurchase(purchase, options = {}) {
    if (!isEnabled()) {
        return null;
    }

    const now = Number(options.now || Date.now());
    const current = await getCurrentServiceAccessLink(purchase.id, { now });

    if (options.revokeExisting === true) {
        await runQuery(
            `UPDATE serviceAccessLinks
             SET active = 0,
                 revokedAt = COALESCE(revokedAt, ?),
                 rotatedAt = COALESCE(rotatedAt, ?),
                 expiresAt = CASE WHEN expiresAt > ? THEN ? ELSE expiresAt END
             WHERE purchaseId = ?
               AND purpose = ?
               AND active = 1
               AND revokedAt IS NULL`,
            [now, now, now, now, purchase.id, SERVICE_ACCESS_PURPOSE]
        );
    }

    return createServiceAccessLinkForPurchase(purchase, {
        now,
        rotatedFromId: current?.id || null
    });
}

async function revokeServiceAccessLink(linkId, options = {}) {
    const now = Number(options.now || Date.now());
    const result = await runQuery(
        `UPDATE serviceAccessLinks
         SET active = 0,
             revokedAt = COALESCE(revokedAt, ?),
             expiresAt = CASE WHEN expiresAt > ? THEN ? ELSE expiresAt END
         WHERE id = ?`,
        [now, now, now, linkId]
    );

    return result.changes > 0;
}

async function syncServiceAccessLinkForBillingPeriod(purchase, options = {}) {
    if (!isEnabled() || !purchase?.id) {
        return null;
    }

    const now = Number(options.now || Date.now());
    const period = getPurchasePeriodBounds(purchase, now);
    const current = await getCurrentServiceAccessLink(purchase.id, { now });

    if (
        current &&
        Number(current.billingPeriodStart || 0) === period.start &&
        Number(current.billingPeriodEnd || 0) === period.end
    ) {
        return {
            rotated: false,
            link: serializeServiceAccessLink(current)
        };
    }

    if (current) {
        const overlapExpiry = period.start + getOverlapMs();

        await runQuery(
            `UPDATE serviceAccessLinks
             SET rotatedAt = COALESCE(rotatedAt, ?),
                 expiresAt = CASE
                    WHEN expiresAt > ? THEN ?
                    ELSE expiresAt
                 END
             WHERE purchaseId = ?
               AND purpose = ?
               AND active = 1
               AND revokedAt IS NULL
               AND billingPeriodStart < ?`,
            [
                now,
                overlapExpiry,
                overlapExpiry,
                purchase.id,
                SERVICE_ACCESS_PURPOSE,
                period.start
            ]
        );
    }

    return {
        rotated: true,
        previousLink: serializeServiceAccessLink(current),
        period
    };
}

module.exports = {
    SERVICE_ACCESS_LINK_PLACEHOLDER,
    SERVICE_ACCESS_PURPOSE,
    buildServiceAccessUrl,
    createServiceAccessLinkForEmail,
    createServiceAccessLinkForPurchase,
    getPurchasePeriodBounds,
    hashToken,
    listServiceAccessLinksForPurchase,
    materializeServiceAccessLinkForEmail,
    revokeServiceAccessLink,
    rotateServiceAccessLinkForPurchase,
    serializeServiceAccessLink,
    syncServiceAccessLinkForBillingPeriod,
    tokenPrefix,
    verifyServiceAccessToken
};
