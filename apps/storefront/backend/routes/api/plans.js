const express = require("express");
const db = require("../../db");
const { SERVER_STATUS } = require("../../constants/status");
const { PLAN_DEFINITIONS } = require("../../config/plans");

const router = express.Router();

router.get("/plans", (req, res) => {
    db.all(`
        SELECT
            productCode,
            MAX(price) as price,
            SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as available
        FROM servers
        WHERE productCode IS NOT NULL
        GROUP BY productCode
    `, [SERVER_STATUS.AVAILABLE], (err, rows) => {

        if (err) {
            return res.status(500).json({ error: "DB error" });
        }

        const rowsByProductCode = new Map(rows.map(row => [row.productCode, row]));
        const plans = Object.entries(PLAN_DEFINITIONS).map(([type, definition]) => {
            const row = rowsByProductCode.get(definition.code);

            return {
                type,
                code: definition.code,
                displayName: definition.displayName,
                price: row?.price ?? definition.price,
                available: row ? Number(row.available) : 0,
                features: definition.features || []
            };
        });

        res.json(plans);
    });
});

module.exports = router;
