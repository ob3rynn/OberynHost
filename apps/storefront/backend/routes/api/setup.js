const express = require("express");
const config = require("../../config");
const { PLAN_DEFINITIONS } = require("../../config/plans");
const { listSupportedMinecraftVersions, resolveMinecraftRuntimeProfile } = require("../../config/minecraftVersions");
const { PURCHASE_STATUS, FULFILLMENT_STATUS } = require("../../constants/status");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { getQuery, runQuery } = require("../../db/queries");
const { rollbackTransaction } = require("../../db/transactions");
const { createStripeClient } = require("../../lib/stripeClient");
const { parseCookies, serializeCookie } = require("../../utils/cookies");
const { isOpaqueToken } = require("../../utils/tokens");
const { markPurchasePaid, getStripeObjectId } = require("../../services/purchases");
const { enqueueProvisioningJobForPurchase } = require("../../services/fulfillmentQueue");
const { mergeLifecycleState } = require("../../services/lifecycle");
const {
    findCustomerPelicanLinkByStripeCustomerId,
    findPendingPelicanIdentityByStripeCustomerId,
    findPelicanUsernameConflict
} = require("../../services/pelicanIdentities");
const { encryptSetupSecret } = require("../../services/setupSecrets");
const { validateCustomerHostnameSlug } = require("../../services/hostnames");

const router = express.Router();
const stripe = createStripeClient(config.stripeSecretKey, config.stripeApiVersion);
const DEFAULT_PLAN_DEFINITION = PLAN_DEFINITIONS["paper-2gb"] || Object.values(PLAN_DEFINITIONS)[0] || null;
const setupStatusLimiter = createRateLimiter({
    windowMs: 1000 * 60,
    max: 20,
    message: "Too many setup status checks. Please wait a moment."
});
const setupCompleteLimiter = createRateLimiter({
    windowMs: 1000 * 60,
    max: 10,
    message: "Too many setup attempts. Please wait a moment."
});
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,48}[A-Za-z0-9]$/;
const PELICAN_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const MIN_PELICAN_PASSWORD_LENGTH = 8;

function getPlanDefinitionForPurchase(purchase) {
    return PLAN_DEFINITIONS[purchase?.planType] || DEFAULT_PLAN_DEFINITION;
}

function getTrimmedBodyValue(value) {
    return typeof value === "string" ? value.trim() : "";
}

function hasSubmittedSetup(purchase) {
    return Boolean((purchase?.serverName || "").trim());
}

function isSetupEditablePurchase(purchase) {
    return (
        (purchase?.status === PURCHASE_STATUS.PAID || purchase?.status === PURCHASE_STATUS.COMPLETED) &&
        !hasSubmittedSetup(purchase)
    );
}

function getSetupToken(req) {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = typeof cookies[config.setupSessionCookieName] === "string"
        ? cookies[config.setupSessionCookieName].trim()
        : "";
    const bodyToken = typeof req.body?.setupToken === "string"
        ? req.body.setupToken.trim()
        : "";

    return cookieToken || bodyToken;
}

function getCheckoutSessionId(req) {
    const bodySessionId = typeof req.body?.sessionId === "string"
        ? req.body.sessionId.trim()
        : "";
    const querySessionId = typeof req.query?.session_id === "string"
        ? req.query.session_id.trim()
        : "";
    const sessionId = bodySessionId || querySessionId;

    return /^cs_[A-Za-z0-9_]+$/.test(sessionId) ? sessionId : "";
}

function isRecoverableCheckoutSession(session) {
    return session?.status === "complete" &&
        (session?.payment_status === "paid" || session?.payment_status === "no_payment_required");
}

async function recoverPurchaseFromSessionId(req, res) {
    const sessionId = getCheckoutSessionId(req);

    if (!sessionId) {
        return null;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!isRecoverableCheckoutSession(session)) {
        return null;
    }

    const subscriptionId = getStripeObjectId(session.subscription);
    const subscription = subscriptionId
        ? await stripe.subscriptions.retrieve(subscriptionId)
        : null;

    await markPurchasePaid(session, subscription);

    const purchaseId = Number(session.metadata?.purchaseId);
    const purchase = await getQuery(
        `SELECT id, status, serverName, hostname, setupToken, setupTokenExpiresAt, stripeCustomerId,
                minecraftVersion, pelicanUsername
         FROM purchases
         WHERE stripeSessionId = ?
            OR id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [session.id, purchaseId || 0]
    );

    if (!purchase || !isOpaqueToken(purchase.setupToken)) {
        return null;
    }

    res.setHeader("Set-Cookie", serializeCookie(config.setupSessionCookieName, purchase.setupToken, {
        httpOnly: true,
        maxAgeMs: config.setupTokenTtlMs,
        path: "/",
        priority: "High",
        sameSite: "Lax",
        secure: config.secureCookies
    }));

    return purchase;
}

async function getCustomerPelicanContext(purchase) {
    const customerLink = await findCustomerPelicanLinkByStripeCustomerId(purchase?.stripeCustomerId);
    const pendingIdentity = customerLink
        ? null
        : await findPendingPelicanIdentityByStripeCustomerId(purchase?.stripeCustomerId, {
            excludePurchaseId: purchase?.id
        });

    return {
        customerLink,
        pendingIdentity
    };
}

router.post("/setup-status", setupStatusLimiter, async (req, res) => {
    try {
        const setupToken = getSetupToken(req);
        let purchase = null;

        if (isOpaqueToken(setupToken)) {
            purchase = await getQuery(
                `SELECT id, status, serverName, hostname, setupTokenExpiresAt, stripeCustomerId,
                        minecraftVersion, pelicanUsername
                 FROM purchases
                 WHERE setupToken = ?`,
                [setupToken]
            );
        } else {
            purchase = await recoverPurchaseFromSessionId(req, res);
        }

        if (!purchase) {
            return res.status(400).json({
                ready: false,
                editable: false,
                status: "invalid",
                message: "We couldn't find an active setup session for this browser."
            });
        }

        if (
            purchase.setupTokenExpiresAt &&
            Number(purchase.setupTokenExpiresAt) < Date.now()
        ) {
            return res.status(410).json({
                ready: false,
                editable: false,
                status: "expired",
                message: "This setup link has expired."
            });
        }

        const { customerLink, pendingIdentity } = await getCustomerPelicanContext(purchase);
        const canEdit = isSetupEditablePurchase(purchase);

        let message = "Payment verified. You can choose your server details.";

        if (purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING) {
            message = "Payment is still being verified by Stripe. Please wait a moment.";
        } else if (
            purchase.status === PURCHASE_STATUS.EXPIRED ||
            purchase.status === PURCHASE_STATUS.CANCELLED
        ) {
            message = "This checkout is no longer valid for server setup.";
        } else if (hasSubmittedSetup(purchase)) {
            message = "Server setup has already been submitted for this order.";
        }

        res.json({
            ready: canEdit,
            editable: canEdit,
            status: purchase.status,
            serverName: purchase.serverName || "",
            hostname: purchase.hostname || "",
            customerHostnameRootDomain: config.customerHostnameRootDomain,
            minecraftVersion: purchase.minecraftVersion || "",
            minecraftVersions: listSupportedMinecraftVersions(),
            pelicanAccountMode: customerLink ? "reuse" : "create",
            pelicanUsername: customerLink?.pelicanUsername || pendingIdentity?.pelicanUsername || purchase.pelicanUsername || "",
            expiresAt: Number(purchase.setupTokenExpiresAt) || (Date.now() + config.setupTokenTtlMs),
            message
        });
    } catch (err) {
        console.error("Setup status lookup failed:", err);
        res.status(500).json({ error: "Could not load setup status" });
    }
});

router.post("/complete-setup", setupCompleteLimiter, async (req, res) => {
    const setupToken = getSetupToken(req);
    const serverName = getTrimmedBodyValue(req.body?.serverName);
    const minecraftVersion = getTrimmedBodyValue(req.body?.minecraftVersion);
    const requestedPelicanUsername = getTrimmedBodyValue(req.body?.pelicanUsername);
    const pelicanPassword = getTrimmedBodyValue(req.body?.pelicanPassword);

    if (!isOpaqueToken(setupToken)) {
        return res.status(400).json({ error: "Invalid setup token" });
    }

    if (!serverName) {
        return res.status(400).json({ error: "Server name required" });
    }

    if (!SERVER_NAME_PATTERN.test(serverName)) {
        return res.status(400).json({
            error: "Server name must be 3-50 characters and use only letters, numbers, spaces, hyphens, or underscores."
        });
    }

    if (!minecraftVersion) {
        return res.status(400).json({ error: "Minecraft version required" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getQuery(
            `SELECT *
             FROM purchases
             WHERE setupToken = ?
               AND (setupTokenExpiresAt IS NULL OR setupTokenExpiresAt >= ?)
               AND (
                    (status = ? AND (serverName IS NULL OR TRIM(serverName) = ''))
                    OR (status = ? AND (serverName IS NULL OR TRIM(serverName) = ''))
               )
             ORDER BY id DESC
             LIMIT 1`,
            [
                setupToken,
                Date.now(),
                PURCHASE_STATUS.PAID,
                PURCHASE_STATUS.COMPLETED
            ]
        );

        if (!purchase) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Setup is not available for this purchase state"
            });
        }

        const planDefinition = getPlanDefinitionForPurchase(purchase);
        const resolvedRuntime = resolveMinecraftRuntimeProfile(minecraftVersion, planDefinition);

        if (!resolvedRuntime) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Please choose a supported Minecraft version."
            });
        }

        const existingCustomerLink = await findCustomerPelicanLinkByStripeCustomerId(purchase.stripeCustomerId);
        const pendingIdentity = existingCustomerLink
            ? null
            : await findPendingPelicanIdentityByStripeCustomerId(purchase.stripeCustomerId, {
                excludePurchaseId: purchase.id
            });

        let effectivePelicanUsername = existingCustomerLink?.pelicanUsername || "";
        let effectivePelicanUserId = existingCustomerLink?.pelicanUserId || null;
        let encryptedPassword = null;

        if (!existingCustomerLink && pendingIdentity && pendingIdentity.pelicanUsername) {
            effectivePelicanUsername = pendingIdentity.pelicanUsername;
        }

        if (!effectivePelicanUsername) {
            if (!requestedPelicanUsername) {
                await rollbackTransaction();
                return res.status(400).json({ error: "Pelican username required" });
            }

            if (!PELICAN_USERNAME_PATTERN.test(requestedPelicanUsername)) {
                await rollbackTransaction();
                return res.status(400).json({
                    error: "Pelican username must be 3-32 characters and use only letters, numbers, dots, hyphens, or underscores."
                });
            }

            const usernameConflict = await findPelicanUsernameConflict(requestedPelicanUsername, {
                stripeCustomerId: purchase.stripeCustomerId,
                excludePurchaseId: purchase.id
            });

            if (usernameConflict) {
                await rollbackTransaction();
                return res.status(409).json({
                    error: "That Pelican username is already claimed. Please choose another."
                });
            }

            effectivePelicanUsername = requestedPelicanUsername;
        }

        if (!existingCustomerLink && pendingIdentity && pendingIdentity.pelicanUsername) {
            if (
                requestedPelicanUsername &&
                requestedPelicanUsername.toLowerCase() !== pendingIdentity.pelicanUsername.toLowerCase()
            ) {
                await rollbackTransaction();
                return res.status(409).json({
                    error: "This customer already has a Pelican username pending provisioning."
                });
            }
        }

        if (!effectivePelicanUserId) {
            if (!pelicanPassword) {
                await rollbackTransaction();
                return res.status(400).json({ error: "Pelican password required" });
            }

            if (pelicanPassword.length < MIN_PELICAN_PASSWORD_LENGTH) {
                await rollbackTransaction();
                return res.status(400).json({
                    error: `Pelican password must be at least ${MIN_PELICAN_PASSWORD_LENGTH} characters long.`
                });
            }

            encryptedPassword = encryptSetupSecret(pelicanPassword);
        }

        const hostnameValidation = validateCustomerHostnameSlug(serverName);

        if (!hostnameValidation.ok) {
            await rollbackTransaction();
            return res.status(400).json({ error: hostnameValidation.reason });
        }

        const hostnameConflict = await getQuery(
            `SELECT id, hostname
             FROM purchases
             WHERE id != ?
               AND hostnameReservationKey = ? COLLATE NOCASE
               AND hostnameReleasedAt IS NULL
               AND status NOT IN (?, ?)
             LIMIT 1`,
            [
                purchase.id,
                hostnameValidation.slug,
                PURCHASE_STATUS.CANCELLED,
                PURCHASE_STATUS.EXPIRED
            ]
        );

        if (hostnameConflict) {
            await rollbackTransaction();
            return res.status(409).json({
                error: "That server name creates a hostname that is already reserved. Please choose another server name."
            });
        }

        const now = Date.now();
        const nextPurchase = mergeLifecycleState(purchase, {
            serverName,
            hostname: hostnameValidation.hostname,
            hostnameReservationKey: hostnameValidation.slug,
            minecraftVersion: resolvedRuntime.minecraftVersion,
            runtimeProfileCode: resolvedRuntime.runtimeProfileCode,
            runtimeJavaVersion: resolvedRuntime.javaVersion,
            runtimeFamily: resolvedRuntime.runtimeFamily,
            runtimeTemplate: resolvedRuntime.runtimeTemplate,
            provisioningTargetCode: resolvedRuntime.provisioningTargetCode,
            pelicanUserId: effectivePelicanUserId,
            pelicanUsername: effectivePelicanUsername,
            fulfillmentFailureClass: null,
            needsAdminReviewReason: null,
            lastProvisioningError: null,
            lastProvisioningAttemptAt: null,
            lastStateOwner: "web_app"
        });
        const result = await runQuery(
            `UPDATE purchases
                 SET serverName = ?,
                 hostname = ?,
                 hostnameReservationKey = ?,
                 minecraftVersion = ?,
                 runtimeProfileCode = ?,
                 runtimeJavaVersion = ?,
                 runtimeFamily = ?,
                 runtimeTemplate = ?,
                 provisioningTargetCode = ?,
                 pelicanUserId = ?,
                 pelicanUsername = ?,
                 pelicanPasswordCiphertext = ?,
                 pelicanPasswordIv = ?,
                 pelicanPasswordAuthTag = ?,
                 pelicanPasswordStoredAt = ?,
                 setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 customerRiskStatus = ?,
                 fulfillmentFailureClass = NULL,
                 needsAdminReviewReason = NULL,
                 lastProvisioningError = NULL,
                 lastProvisioningAttemptAt = NULL,
                 hostnameReservedAt = COALESCE(hostnameReservedAt, ?),
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?`,
            [
                serverName,
                nextPurchase.hostname,
                nextPurchase.hostnameReservationKey,
                nextPurchase.minecraftVersion,
                nextPurchase.runtimeProfileCode,
                nextPurchase.runtimeJavaVersion,
                nextPurchase.runtimeFamily,
                nextPurchase.runtimeTemplate,
                nextPurchase.provisioningTargetCode,
                nextPurchase.pelicanUserId,
                nextPurchase.pelicanUsername,
                encryptedPassword?.ciphertext || null,
                encryptedPassword?.iv || null,
                encryptedPassword?.authTag || null,
                encryptedPassword ? now : null,
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                nextPurchase.customerRiskStatus,
                now,
                now,
                nextPurchase.lastStateOwner,
                purchase.id
            ]
        );

        if (result.changes === 0) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Setup is not available for this purchase state"
            });
        }

        if (nextPurchase.fulfillmentStatus === FULFILLMENT_STATUS.QUEUED) {
            await enqueueProvisioningJobForPurchase({
                ...purchase,
                ...nextPurchase,
                serverName,
                hostname: nextPurchase.hostname,
                hostnameReservationKey: nextPurchase.hostnameReservationKey,
                minecraftVersion: nextPurchase.minecraftVersion,
                runtimeProfileCode: nextPurchase.runtimeProfileCode,
                runtimeJavaVersion: nextPurchase.runtimeJavaVersion,
                runtimeFamily: nextPurchase.runtimeFamily,
                runtimeTemplate: nextPurchase.runtimeTemplate,
                provisioningTargetCode: nextPurchase.provisioningTargetCode,
                pelicanUserId: nextPurchase.pelicanUserId,
                pelicanUsername: nextPurchase.pelicanUsername
            }, { now });
        }
        await runQuery("COMMIT");

        res.json({ success: true });
    } catch (err) {
        await rollbackTransaction();
        console.error("Setup completion failed:", err);
        res.status(500).json({ error: "Could not save setup" });
    }
});

module.exports = router;
