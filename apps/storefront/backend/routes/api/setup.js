const express = require("express");
const config = require("../../config");
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

const router = express.Router();
const stripe = createStripeClient(config.stripeSecretKey, config.stripeApiVersion);
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
        `SELECT id, status, serverName, setupToken, setupTokenExpiresAt
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

router.post("/setup-status", setupStatusLimiter, async (req, res) => {
    try {
        const setupToken = getSetupToken(req);
        let purchase = null;

        if (isOpaqueToken(setupToken)) {
            purchase = await getQuery(
                "SELECT id, status, serverName, setupTokenExpiresAt FROM purchases WHERE setupToken = ?",
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

        const hasServerName = Boolean((purchase.serverName || "").trim());
        const canEdit =
            (purchase.status === PURCHASE_STATUS.PAID && !hasServerName) ||
            (purchase.status === PURCHASE_STATUS.COMPLETED && !hasServerName);

        let message = "Payment verified. You can choose your server name.";

        if (purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING) {
            message = "Payment is still being verified by Stripe. Please wait a moment.";
        } else if (
            purchase.status === PURCHASE_STATUS.EXPIRED ||
            purchase.status === PURCHASE_STATUS.CANCELLED
        ) {
            message = "This checkout is no longer valid for server setup.";
        } else if (hasServerName) {
            message = "Server setup has already been submitted for this order.";
        }

        res.json({
            ready: canEdit,
            editable: canEdit,
            status: purchase.status,
            serverName: purchase.serverName || "",
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
    const serverName = typeof req.body?.serverName === "string"
        ? req.body.serverName.trim()
        : "";

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

        const now = Date.now();
        const nextPurchase = mergeLifecycleState(purchase, {
            serverName,
            fulfillmentFailureClass: null,
            needsAdminReviewReason: null,
            lastProvisioningError: null,
            lastProvisioningAttemptAt: null,
            lastStateOwner: "web_app"
        });
        const result = await runQuery(
            `UPDATE purchases
             SET serverName = ?,
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
                serverName
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
