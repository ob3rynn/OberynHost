const express = require("express");

const { listPublicPlans } = require("../../services/catalog");

const router = express.Router();

router.get("/plans", async (req, res) => {
    try {
        const plans = await listPublicPlans();

        res.json(plans.map(plan => {
            const definition = plan.definition;

            return {
                type: definition.planKey,
                planKey: definition.planKey,
                code: definition.productCode,
                displayName: definition.public.name,
                description: definition.public.description,
                price: definition.public.priceAmount,
                priceLabel: definition.public.priceLabel,
                available: plan.available,
                soldOut: plan.soldOut,
                canCheckout: plan.canCheckout,
                canJoinWaitlist: plan.canJoinWaitlist,
                features: definition.public.features || [],
                runtimeFamily: definition.runtime.family,
                supportedVersions: definition.runtime.supportedVersions || []
            };
        }));
    } catch (err) {
        console.error("Plan list failed:", err);
        res.status(500).json({ error: "Could not load plans" });
    }
});

module.exports = router;
