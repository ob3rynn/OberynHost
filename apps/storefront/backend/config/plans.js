const PLAN_DEFINITIONS = {
    "3GB": {
        code: "minecraft-paper-3gb",
        displayName: "3GB Paper Server",
        price: 11.98,
        launchSlotCount: 25,
        productFamily: "minecraft",
        runtimeFamily: "paper",
        inventoryBucketCode: "paper-3gb-launch-bucket",
        nodeGroupCode: "paper-launch-group",
        provisioningTargetCode: "paper-launch-default",
        runtimeTemplate: "paper-launch-default",
        features: [
            "3GB RAM",
            "Paper server software",
            "Fixed monthly resources",
            "Curated supported versions",
            "Post-payment guided setup",
            "Best for launch-scope Minecraft hosting"
        ]
    }
};

const VALID_PLAN_TYPES = new Set(Object.keys(PLAN_DEFINITIONS));

module.exports = {
    PLAN_DEFINITIONS,
    VALID_PLAN_TYPES
};
