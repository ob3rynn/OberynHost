const express = require("express");
const db = require("../../db");
const { SERVER_STATUS } = require("../../constants/status");
const { PLAN_DEFINITIONS } = require("../../config/plans");

const router = express.Router();

router.get("/plans", (req, res) => {
    db.all(`
        SELECT type, price, COUNT(*) as available
        FROM servers
        WHERE status = ?
        GROUP BY type, price
    `, [SERVER_STATUS.AVAILABLE], (err, rows) => {

        if (err) {
            return res.status(500).json({ error: "DB error" });
        }

        const plans = rows.map(row => ({
            type: row.type,
            price: row.price,
            available: row.available,
            features: PLAN_DEFINITIONS[row.type]?.features || []
        }));

        res.json(plans);
    });
});

module.exports = router;