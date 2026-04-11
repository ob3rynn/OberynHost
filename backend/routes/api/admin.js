const express = require("express");
const config = require("../../config");
const db = require("../../db");
const requireAdmin = require("../../middleware/auth");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { PURCHASE_STATUS, SERVER_STATUS } = require("../../constants/status");
const { createAdminSession, destroyAdminSession } = require("../../services/adminSessions");
const { clearCookie, parseCookies, serializeCookie } = require("../../utils/cookies");
const { getQuery, runQuery } = require("../../db/queries");
const { rollbackTransaction } = require("../../db/transactions");
const { timingSafeEqualString } = require("../../utils/tokens");

const router = express.Router();
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
        db.all(
            "SELECT * FROM purchases ORDER BY COALESCE(createdAt, 0) DESC, id DESC",
            (err, rows) => {
                if (err) {
                    return res.status(500).json({ error: "Could not load purchases" });
                }

                res.json(rows);
            }
        );
    } catch {
        res.status(500).json({ error: "Could not load purchases" });
    }
});

router.post("/complete", async (req, res) => {
    const purchaseId = Number(req.body?.purchaseId);

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getQuery("SELECT * FROM purchases WHERE id = ?", [purchaseId]);

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
