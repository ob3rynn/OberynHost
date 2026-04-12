const express = require("express");
const config = require("../../config");
const { PURCHASE_STATUS } = require("../../constants/status");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { getQuery, runQuery } = require("../../db/queries");
const { parseCookies } = require("../../utils/cookies");
const { isOpaqueToken } = require("../../utils/tokens");

const router = express.Router();
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

router.post("/setup-status", setupStatusLimiter, async (req, res) => {
    const setupToken = getSetupToken(req);

    if (!isOpaqueToken(setupToken)) {
        return res.status(400).json({
            ready: false,
            editable: false,
            status: "invalid",
            message: "We couldn't find an active setup session for this browser."
        });
    }

    try {
        const purchase = await getQuery(
            "SELECT id, status, serverName, setupTokenExpiresAt FROM purchases WHERE setupToken = ?",
            [setupToken]
        );

        if (!purchase) {
            return res.status(404).json({
                ready: false,
                editable: false,
                status: "missing",
                message: "We could not find a purchase for this setup link."
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
        const result = await runQuery(
        `UPDATE purchases
         SET serverName = ?
         WHERE setupToken = ?
           AND (setupTokenExpiresAt IS NULL OR setupTokenExpiresAt >= ?)
           AND (
                (status = ? AND (serverName IS NULL OR TRIM(serverName) = ''))
                OR (status = ? AND (serverName IS NULL OR TRIM(serverName) = ''))
           )`,
        [
            serverName,
            setupToken,
            Date.now(),
            PURCHASE_STATUS.PAID,
            PURCHASE_STATUS.COMPLETED
        ]
        );

        if (result.changes === 0) {
            return res.status(400).json({
                error: "Setup is not available for this purchase state"
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Setup completion failed:", err);
        res.status(500).json({ error: "Could not save setup" });
    }
});

module.exports = router;
