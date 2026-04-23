const SUPPORTED_MINECRAFT_VERSIONS = [
    { minecraftVersion: "26.1.2", javaVersion: 25, runtimeProfileCode: "paper-java25" },
    { minecraftVersion: "26.1.1", javaVersion: 25, runtimeProfileCode: "paper-java25" },
    { minecraftVersion: "1.21.11", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.10", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.9", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.8", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.7", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.6", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.5", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.4", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.3", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21.1", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.21", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.20.6", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.20.5", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.20.4", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.20.2", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.20.1", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.20", javaVersion: 21, runtimeProfileCode: "paper-java21" },
    { minecraftVersion: "1.19.4", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.19.3", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.19.2", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.19.1", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.19", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.18.2", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.18.1", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.18", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.17.1", javaVersion: 17, runtimeProfileCode: "paper-java17" },
    { minecraftVersion: "1.17", javaVersion: 17, runtimeProfileCode: "paper-java17" }
];

const VERSION_MAP = new Map(
    SUPPORTED_MINECRAFT_VERSIONS.map(entry => [entry.minecraftVersion, entry])
);

function listSupportedMinecraftVersions() {
    return SUPPORTED_MINECRAFT_VERSIONS.map(entry => ({ ...entry }));
}

function resolveMinecraftRuntimeProfile(minecraftVersion, planDefinition) {
    const normalizedVersion = String(minecraftVersion || "").trim();
    const match = VERSION_MAP.get(normalizedVersion);

    if (!match) {
        return null;
    }

    return {
        ...match,
        runtimeFamily: planDefinition?.runtimeFamily || "paper",
        runtimeTemplate: planDefinition?.runtimeTemplate || "paper-launch-default",
        provisioningTargetCode: planDefinition?.provisioningTargetCode || "paper-launch-default"
    };
}

module.exports = {
    listSupportedMinecraftVersions,
    resolveMinecraftRuntimeProfile
};
