const PLAN_DEFINITIONS = {
    "paper-2gb": {
        code: "minecraft-paper-2gb",
        displayName: "2GB Paper Minecraft Server",
        price: 11.97,
        launchSlotCount: 25,
        productFamily: "minecraft",
        runtimeFamily: "paper",
        containerMemoryMb: 2424,
        jvmMemoryMb: 2024,
        inventoryBucketCode: "paper-2gb-launch-bucket",
        nodeGroupCode: "paper-launch-group",
        provisioningTargetCode: "paper-launch-default",
        runtimeTemplate: "paper-launch-default",
        features: [
            "2GB Paper Minecraft server",
            "Paper server software",
            "Guided setup after checkout",
            "Panel access emailed when ready",
            "Fixed monthly resources",
            "Curated supported versions"
        ]
    }
};

const VALID_PLAN_TYPES = new Set(Object.keys(PLAN_DEFINITIONS));

module.exports = {
    PLAN_DEFINITIONS,
    VALID_PLAN_TYPES
};
