const express = require("express");
const Stripe = require("stripe");

const requireAdmin = require("../../middleware/auth");
const config = require("../../config");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { PURCHASE_STATUS, SERVER_STATUS } = require("../../constants/status");
const { createAdminSession, destroyAdminSession } = require("../../services/adminSessions");
const { markPurchasePaid, expirePurchase } = require("../../services/purchases");
const { clearCookie, parseCookies, serializeCookie } = require("../../utils/cookies");
const { allQuery, getQuery, runQuery } = require("../../db/queries");
const { rollbackTransaction } = require("../../db/transactions");
const {
    generateOpaqueToken,
    isOpaqueToken,
    timingSafeEqualString
} = require("../../utils/tokens");

const stripe = new Stripe(config.stripeSecretKey);
const router = express.Router();
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
const STALE_PENDING_CHECKOUT_MS = 1000 * 60 * 30;
const loginLimiter = createRateLimiter({
    windowMs: 1000 * 60 * 15,
    max: 5,
    message: "Too many login attempts. Please wait before trying again."
});
const adminApiLimiter = createRateLimiter({
    windowMs: 1000 * 60,
    max: 60,
    message: "Too many admin requests. Please slow down."
});

const PURCHASE_STATUSES = new Set(Object.values(PURCHASE_STATUS));
const SERVER_STATUSES = new Set(Object.values(SERVER_STATUS));

function inferServerStatus(purchase) {
    if (
        purchase.status === PURCHASE_STATUS.COMPLETED &&
        purchase.stripeSubscriptionStatus &&
        TERMINAL_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus)
    ) {
        return SERVER_STATUS.AVAILABLE;
    }

    switch (purchase.status) {
        case PURCHASE_STATUS.COMPLETED:
            return SERVER_STATUS.ALLOCATED;
        case PURCHASE_STATUS.EXPIRED:
        case PURCHASE_STATUS.CANCELLED:
            return SERVER_STATUS.AVAILABLE;
        case PURCHASE_STATUS.CHECKOUT_PENDING:
        case PURCHASE_STATUS.PAID:
        default:
            return SERVER_STATUS.HELD;
    }
}

function addIssue(issues, condition, message) {
    if (condition) {
        issues.push(message);
    }
}

function buildDiagnostics(purchase) {
    const issues = [];
    const recommendedServerStatus = inferServerStatus(purchase);
    const createdAt = Number(purchase.createdAt) || 0;
    const tokenExpired = Boolean(
        purchase.setupTokenExpiresAt &&
        Number(purchase.setupTokenExpiresAt) < Date.now()
    );
    const stalePendingCheckout = Boolean(
        purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING &&
        purchase.stripeSessionId &&
        createdAt > 0 &&
        (Date.now() - createdAt) >= STALE_PENDING_CHECKOUT_MS
    );

    addIssue(
        issues,
        !purchase.stripeSessionId && purchase.status !== PURCHASE_STATUS.CANCELLED,
        "Purchase has no Stripe session ID."
    );
    addIssue(
        issues,
        purchase.serverStatus !== recommendedServerStatus,
        `Server status is ${purchase.serverStatus || "unknown"}, expected ${recommendedServerStatus}.`
    );
    addIssue(
        issues,
        !purchase.email && (
            purchase.status === PURCHASE_STATUS.PAID ||
            purchase.status === PURCHASE_STATUS.COMPLETED
        ),
        "Customer email is missing on a verified purchase."
    );
    addIssue(
        issues,
        !purchase.setupToken && purchase.status !== PURCHASE_STATUS.CANCELLED,
        "Setup token is missing."
    );
    addIssue(
        issues,
        (purchase.status === PURCHASE_STATUS.PAID || purchase.status === PURCHASE_STATUS.COMPLETED) &&
        !purchase.stripeSubscriptionId,
        "Stripe subscription ID is missing."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED &&
        !purchase.stripeSubscriptionStatus,
        "Subscription runtime has not been synced onto this fulfilled order."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED &&
        purchase.stripeSubscriptionStatus &&
        TERMINAL_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus) &&
        purchase.serverStatus !== SERVER_STATUS.AVAILABLE,
        "Subscription is no longer active, but the server is still allocated."
    );
    addIssue(
        issues,
        tokenExpired && (
            purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING ||
            purchase.status === PURCHASE_STATUS.PAID ||
            purchase.status === PURCHASE_STATUS.COMPLETED
        ),
        "Setup token is expired."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED && !purchase.serverName,
        "Completed purchase has no saved server name."
    );
    addIssue(
        issues,
        stalePendingCheckout,
        "Pending checkout has been held for over 30 minutes without payment confirmation."
    );

    return {
        issues,
        issueCount: issues.length,
        recommendedServerStatus,
        tokenExpired,
        stalePendingCheckout,
        stripeSyncAvailable: Boolean(purchase.stripeSessionId),
        activeSubscription: Boolean(
            purchase.stripeSubscriptionStatus &&
            ACTIVE_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus)
        ),
        terminalSubscription: Boolean(
            purchase.stripeSubscriptionStatus &&
            TERMINAL_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus)
        )
    };
}

function parseAuditDetails(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function serializePurchase(purchase, stripeState = null, auditLog = []) {
    return {
        ...purchase,
        auditLog: auditLog.map(entry => ({
            ...entry,
            details: parseAuditDetails(entry.detailsJson)
        })),
        diagnostics: {
            ...buildDiagnostics(purchase),
            stripe: stripeState
        }
    };
}

function normalizeOptionalText(value, maxLength = 255) {
    if (value === undefined) {
        return { present: false, value: undefined };
    }

    if (value === null) {
        return { present: true, value: "" };
    }

    if (typeof value !== "string") {
        throw new Error("Expected a string value.");
    }

    const normalized = value.trim();

    if (normalized.length > maxLength) {
        throw new Error(`Value must be ${maxLength} characters or fewer.`);
    }

    return { present: true, value: normalized };
}

async function getPurchaseRecord(purchaseId) {
    return getQuery(
        `SELECT
            p.*,
            s.status AS serverStatus,
            s.type AS serverType,
            s.price AS serverPrice
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.id = ?`,
        [purchaseId]
    );
}

async function getAuditLogMap(purchaseIds) {
    if (!purchaseIds.length) {
        return new Map();
    }

    const placeholders = purchaseIds.map(() => "?").join(", ");
    const rows = await allQuery(
        `SELECT *
         FROM adminAuditLog
         WHERE purchaseId IN (${placeholders})
         ORDER BY createdAt DESC, id DESC`,
        purchaseIds
    );
    const map = new Map();

    for (const row of rows) {
        if (!map.has(row.purchaseId)) {
            map.set(row.purchaseId, []);
        }

        const entries = map.get(row.purchaseId);

        if (entries.length < 8) {
            entries.push(row);
        }
    }

    return map;
}

async function loadSerializedPurchase(purchaseId, stripeState = null) {
    const purchase = await getPurchaseRecord(purchaseId);

    if (!purchase) {
        return null;
    }

    const auditMap = await getAuditLogMap([purchaseId]);
    return serializePurchase(purchase, stripeState, auditMap.get(purchaseId) || []);
}

async function recordAdminAction(req, purchaseId, actionType, note = "", details = null) {
    await runQuery(
        `INSERT INTO adminAuditLog
            (purchaseId, actionType, note, detailsJson, userAgent, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            purchaseId,
            actionType,
            note || "",
            details ? JSON.stringify(details) : null,
            req.headers["user-agent"] || "",
            Date.now()
        ]
    );
}

router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

router.post("/admin/login", loginLimiter, (req, res) => {
    const submittedKey = typeof req.body?.key === "string"
        ? req.body.key.trim()
        : "";

    if (!submittedKey || !timingSafeEqualString(submittedKey, config.adminKey)) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    const session = createAdminSession({
        userAgent: req.headers["user-agent"]
    });

    res.setHeader("Set-Cookie", serializeCookie(config.adminSessionCookieName, session.token, {
        httpOnly: true,
        maxAgeMs: config.adminSessionTtlMs,
        path: "/",
        priority: "High",
        sameSite: "Strict",
        secure: config.secureCookies
    }));

    res.json({ success: true });
});

router.post("/admin/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.adminSessionCookieName];

    if (token) {
        destroyAdminSession(token);
    }

    res.setHeader("Set-Cookie", clearCookie(config.adminSessionCookieName, {
        httpOnly: true,
        path: "/",
        priority: "High",
        sameSite: "Strict",
        secure: config.secureCookies
    }));

    res.json({ success: true });
});

router.use(adminApiLimiter);
router.use(requireAdmin);

router.get("/purchases", async (req, res) => {
    try {
        const purchases = await allQuery(
            `SELECT
                p.*,
                s.status AS serverStatus,
                s.type AS serverType,
                s.price AS serverPrice
             FROM purchases p
             LEFT JOIN servers s ON s.id = p.serverId
             ORDER BY COALESCE(p.createdAt, 0) DESC, p.id DESC`
        );
        const auditMap = await getAuditLogMap(purchases.map(purchase => purchase.id));

        res.json(
            purchases.map(purchase => serializePurchase(
                purchase,
                null,
                auditMap.get(purchase.id) || []
            ))
        );
    } catch (err) {
        console.error("Admin purchase list failed:", err);
        res.status(500).json({ error: "Could not load purchases" });
    }
});

router.post("/admin/purchases/:purchaseId/reconcile-stripe", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    const adminNote = normalizeOptionalText(req.body?.adminNote, 500);

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            return res.status(404).json({ error: "Purchase not found" });
        }

        if (!purchase.stripeSessionId) {
            return res.status(400).json({ error: "Purchase has no Stripe session ID to check." });
        }

        const session = await stripe.checkout.sessions.retrieve(purchase.stripeSessionId);
        const subscriptionId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        const subscription = subscriptionId
            ? await stripe.subscriptions.retrieve(subscriptionId)
            : null;
        let action = "no_change";

        if (session.payment_status === "paid") {
            await markPurchasePaid(session, subscription);
            action = "marked_paid";
        } else if (session.status === "expired") {
            await expirePurchase(session);
            action = "marked_expired";
        }

        await recordAdminAction(req, purchaseId, "reconcile_stripe", adminNote.value || "", {
            action,
            stripeSessionId: session.id,
            stripeSubscriptionId: subscription?.id || subscriptionId || "",
            stripeStatus: session.status,
            stripePaymentStatus: session.payment_status
        });

        const serialized = await loadSerializedPurchase(purchaseId, {
            id: session.id,
            status: session.status,
            paymentStatus: session.payment_status,
            customerEmail: session.customer_details?.email || session.customer_email || "",
            subscriptionId: subscription?.id || subscriptionId || "",
            subscriptionStatus: subscription?.status || "",
            currentPeriodEnd: subscription?.items?.data?.[0]?.current_period_end
                ? subscription.items.data[0].current_period_end * 1000
                : subscription?.current_period_end
                    ? subscription.current_period_end * 1000
                    : null,
            cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end)
        });

        res.json({
            success: true,
            action,
            purchase: serialized
        });
    } catch (err) {
        console.error("Stripe reconcile failed:", err);
        res.status(500).json({ error: "Could not reconcile purchase with Stripe" });
    }
});

router.patch("/admin/purchases/:purchaseId", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    let emailInput;
    let serverNameInput;
    let stripeSessionInput;
    let adminNote;

    try {
        emailInput = normalizeOptionalText(req.body?.email, 320);
        serverNameInput = normalizeOptionalText(req.body?.serverName, 64);
        stripeSessionInput = normalizeOptionalText(req.body?.stripeSessionId, 255);
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const nextStatus = req.body?.status;
    const nextServerStatus = req.body?.serverStatus;
    const setupTokenAction = typeof req.body?.setupTokenAction === "string"
        ? req.body.setupTokenAction.trim()
        : "keep";

    if (nextStatus !== undefined && !PURCHASE_STATUSES.has(nextStatus)) {
        return res.status(400).json({ error: "Invalid purchase status override" });
    }

    if (nextServerStatus !== undefined && !SERVER_STATUSES.has(nextServerStatus)) {
        return res.status(400).json({ error: "Invalid server status override" });
    }

    if (!["keep", "refresh", "regenerate", "clear"].includes(setupTokenAction)) {
        return res.status(400).json({ error: "Invalid setup token action" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        const status = nextStatus || purchase.status;
        const serverStatus = nextServerStatus || inferServerStatus({
            ...purchase,
            status
        });
        const email = emailInput.present ? emailInput.value : (purchase.email || "");
        const serverName = serverNameInput.present ? serverNameInput.value : (purchase.serverName || "");
        const stripeSessionId = stripeSessionInput.present
            ? (stripeSessionInput.value || null)
            : (purchase.stripeSessionId || null);

        let setupToken = purchase.setupToken || null;
        let setupTokenExpiresAt = purchase.setupTokenExpiresAt || null;

        if (setupTokenAction === "clear") {
            setupToken = null;
            setupTokenExpiresAt = null;
        } else if (setupTokenAction === "regenerate" || !setupToken) {
            setupToken = generateOpaqueToken();
            setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;
        } else if (setupTokenAction === "refresh") {
            setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;
        }

        if (setupToken && !isOpaqueToken(setupToken)) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Generated setup token was invalid" });
        }

        await runQuery(
            `UPDATE purchases
             SET status = ?,
                 email = ?,
                 serverName = ?,
                 stripeSessionId = ?,
                 setupToken = ?,
                 setupTokenExpiresAt = ?
             WHERE id = ?`,
            [
                status,
                email,
                serverName,
                stripeSessionId,
                setupToken,
                setupTokenExpiresAt,
                purchaseId
            ]
        );

        if (purchase.serverId) {
            await runQuery(
                "UPDATE servers SET status = ? WHERE id = ?",
                [serverStatus, purchase.serverId]
            );
        }

        await recordAdminAction(req, purchaseId, "manual_override", adminNote.value || "", {
            from: {
                status: purchase.status,
                serverStatus: purchase.serverStatus,
                email: purchase.email || "",
                serverName: purchase.serverName || "",
                stripeSessionId: purchase.stripeSessionId || "",
                setupTokenPresent: Boolean(purchase.setupToken)
            },
            to: {
                status,
                serverStatus,
                email,
                serverName,
                stripeSessionId: stripeSessionId || "",
                setupTokenAction
            }
        });

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            purchase: serialized,
            overrideSummary: {
                status,
                serverStatus,
                setupTokenAction
            }
        });
    } catch (err) {
        await rollbackTransaction();

        if (String(err.message || "").includes("UNIQUE constraint failed")) {
            return res.status(400).json({
                error: "That Stripe session or setup token is already attached elsewhere."
            });
        }

        console.error("Purchase override failed:", err);
        res.status(500).json({ error: "Could not apply purchase override" });
    }
});

router.post("/complete", async (req, res) => {
    const purchaseId = Number(req.body?.purchaseId);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Purchase not found" });
        }

        if (
            purchase.status === PURCHASE_STATUS.EXPIRED ||
            purchase.status === PURCHASE_STATUS.CANCELLED
        ) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Expired purchases cannot be completed" });
        }

        if (purchase.status === PURCHASE_STATUS.COMPLETED) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Purchase already completed" });
        }

        if (purchase.status !== PURCHASE_STATUS.PAID) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Only paid purchases can be completed" });
        }

        await runQuery(
            "UPDATE purchases SET status = ? WHERE id = ? AND status = ?",
            [PURCHASE_STATUS.COMPLETED, purchaseId, PURCHASE_STATUS.PAID]
        );
        await runQuery(
            "UPDATE servers SET status = ? WHERE id = ? AND status IN (?, ?)",
            [
                SERVER_STATUS.ALLOCATED,
                purchase.serverId,
                SERVER_STATUS.HELD,
                SERVER_STATUS.AVAILABLE
            ]
        );
        await recordAdminAction(req, purchaseId, "mark_complete", adminNote.value || "", {
            serverId: purchase.serverId,
            fromStatus: purchase.status,
            toStatus: PURCHASE_STATUS.COMPLETED
        });
        await runQuery("COMMIT");

        console.log(`Admin completed purchase ${purchaseId} for server ${purchase.serverId}`);
        res.json({ success: true });
    } catch (err) {
        await rollbackTransaction();
        console.error("Admin completion failed:", err);
        res.status(500).json({ error: "Could not complete purchase" });
    }
});

module.exports = router;
