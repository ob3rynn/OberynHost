const express = require("express");

const { getQuery, runQuery } = require("../../db/queries");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { listPublicPlans } = require("../../services/catalog");

const router = express.Router();

const waitlistLimiter = createRateLimiter({
    windowMs: 1000 * 60 * 10,
    max: 8,
    message: "Too many waitlist attempts. Please wait a moment and try again."
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeText(value, maxLength) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized.slice(0, maxLength);
}

router.post("/waitlist", waitlistLimiter, async (req, res) => {
    const email = normalizeText(req.body?.email, 320).toLowerCase();
    const name = normalizeText(req.body?.name, 120);
    const note = normalizeText(req.body?.note, 1000);
    const planKey = normalizeText(req.body?.planKey || req.body?.planType, 80);
    const source = normalizeText(req.body?.source, 80) || "storefront";

    if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: "Enter a valid email address." });
    }

    if (!planKey) {
        return res.status(400).json({ error: "Choose a server option before joining the waitlist." });
    }

    try {
        const plans = await listPublicPlans();
        const plan = plans.find(entry => entry.definition.planKey === planKey);

        if (!plan || !plan.active || !plan.storefrontVisible) {
            return res.status(404).json({ error: "That server option is not available for the waitlist right now." });
        }

        if (plan.available > 0) {
            return res.status(409).json({ error: "This server option has openings right now. Checkout is available." });
        }

        const existing = await getQuery(
            `SELECT id
             FROM waitlistEntries
             WHERE email = ?
               AND planKey = ?
               AND status IN ('waiting', 'notified')
             LIMIT 1`,
            [email, planKey]
        );

        if (existing) {
            return res.json({
                success: true,
                message: "You're on the waitlist. We'll contact you when a slot opens."
            });
        }

        const now = Date.now();

        await runQuery(
            `INSERT INTO waitlistEntries
                (
                    email,
                    name,
                    note,
                    planKey,
                    productCode,
                    inventoryBucketCode,
                    source,
                    status,
                    createdAt,
                    updatedAt
                )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                email,
                name || null,
                note || null,
                planKey,
                plan.definition.productCode,
                plan.definition.inventory.bucketCode,
                source,
                "waiting",
                now,
                now
            ]
        );

        return res.json({
            success: true,
            message: "You're on the waitlist. We'll contact you when a slot opens."
        });
    } catch (err) {
        console.error("Waitlist submission failed:", err);
        return res.status(500).json({ error: "Could not join the waitlist right now." });
    }
});

module.exports = router;
