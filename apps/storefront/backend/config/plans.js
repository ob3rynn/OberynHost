const PLAN_DEFINITIONS = {
    "paper-2gb": {
        code: "minecraft-paper-2gb",
        displayName: "Paper 2 GB",
        price: 11.98,
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
            "2 GB Paper server",
            "2424 MB container memory",
            "2024 MB JVM target",
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
