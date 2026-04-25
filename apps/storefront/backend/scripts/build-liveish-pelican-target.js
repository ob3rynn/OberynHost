const fs = require("fs");
const path = require("path");

const {
    LIVEISH_CONTAINER_MEMORY_MB,
    LIVEISH_JVM_MEMORY_MB,
    getLiveishPlan,
    loadHarnessEnv,
    pelicanRequest,
    validateLiveishTargetConfig
} = require("./lib/liveishHarness");

function getArgValue(name, argv = process.argv) {
    const index = argv.indexOf(name);

    if (index === -1 || index + 1 >= argv.length) {
        return "";
    }

    return argv[index + 1];
}

function readTargetJson(argv = process.argv, env = process.env) {
    const inlineJson = getArgValue("--target-json", argv);
    if (inlineJson) {
        return inlineJson;
    }

    const filePath = getArgValue("--target-json-file", argv);
    if (filePath) {
        return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
    }

    return String(env.PELICAN_PROVISIONING_TARGETS_JSON || "").trim();
}

function findTargetAllocationIds(target) {
    return Array.isArray(target?.allocationIds)
        ? target.allocationIds.map(id => Number(id)).filter(Number.isInteger)
        : [];
}

function findTargetEggIds(target) {
    const values = new Set();
    const collect = value => {
        if (value === null || value === undefined || value === "") {
            return;
        }

        if (typeof value === "object") {
            Object.values(value).forEach(collect);
            return;
        }

        const number = Number(value);
        if (Number.isInteger(number) && number > 0) {
            values.add(number);
        }
    };

    collect(target?.egg);
    return Array.from(values).sort((a, b) => a - b);
}

async function validateAllocationsWithPelican({ target, env }) {
    const nodeId = String(env.LIVEISH_PELICAN_NODE_ID || "").trim();

    if (!nodeId) {
        return ["LIVEISH_PELICAN_NODE_ID is unset; allocation existence was not checked against Pelican."];
    }

    const payload = await pelicanRequest({
        panelUrl: env.PELICAN_PANEL_URL,
        apiKey: env.PELICAN_APPLICATION_API_KEY,
        path: `/api/application/nodes/${encodeURIComponent(nodeId)}/allocations`
    });
    const allocations = Array.isArray(payload?.data) ? payload.data.map(entry => entry.attributes || entry) : [];
    const allocationsById = new Map(allocations.map(allocation => [Number(allocation.id), allocation]));
    const missing = findTargetAllocationIds(target).filter(allocationId => !allocationsById.has(allocationId));

    if (missing.length > 0) {
        throw new Error(`Configured allocation IDs were not found on node ${nodeId}: ${missing.join(", ")}`);
    }

    const assigned = findTargetAllocationIds(target).filter(allocationId =>
        Boolean(allocationsById.get(allocationId)?.assigned)
    );

    if (assigned.length > 0) {
        throw new Error(`Configured allocation IDs are already assigned in Pelican: ${assigned.join(", ")}`);
    }

    return [`Validated ${findTargetAllocationIds(target).length} allocation(s) on Pelican node ${nodeId}.`];
}

async function validateEggsWithPelican({ target, env }) {
    const nestId = String(env.LIVEISH_PELICAN_NEST_ID || "").trim();

    if (!nestId) {
        return ["LIVEISH_PELICAN_NEST_ID is unset; egg existence was not checked against Pelican."];
    }

    const messages = [];
    for (const eggId of findTargetEggIds(target)) {
        await pelicanRequest({
            panelUrl: env.PELICAN_PANEL_URL,
            apiKey: env.PELICAN_APPLICATION_API_KEY,
            path: `/api/application/nests/${encodeURIComponent(nestId)}/eggs/${encodeURIComponent(String(eggId))}`
        });
        messages.push(`Validated egg ${eggId} in Pelican nest ${nestId}.`);
    }

    return messages;
}

async function buildCandidate(options = {}) {
    const env = options.env || process.env;
    const rawTargetJson = options.rawTargetJson || readTargetJson(options.argv || process.argv, env);
    const validation = validateLiveishTargetConfig(rawTargetJson);

    if (!rawTargetJson) {
        throw new Error(
            "Provide target JSON through --target-json, --target-json-file, or PELICAN_PROVISIONING_TARGETS_JSON."
        );
    }

    if (!validation.ok) {
        throw new Error(validation.errors.join("; "));
    }

    const plan = getLiveishPlan();
    const target = validation.parsed[plan.provisioningTargetCode];
    const messages = [
        `Validated Paper 2 GB target resources: memory=${LIVEISH_CONTAINER_MEMORY_MB}, jvm=${LIVEISH_JVM_MEMORY_MB}.`
    ];

    if (env.PELICAN_PANEL_URL && env.PELICAN_APPLICATION_API_KEY) {
        messages.push(...await validateAllocationsWithPelican({ target, env }));
        messages.push(...await validateEggsWithPelican({ target, env }));
    } else {
        messages.push("PELICAN_PANEL_URL or PELICAN_APPLICATION_API_KEY is unset; Pelican API validation was skipped.");
    }

    return {
        ok: true,
        messages,
        json: JSON.stringify(validation.parsed)
    };
}

async function main() {
    loadHarnessEnv();
    const candidate = await buildCandidate();

    for (const message of candidate.messages) {
        console.error(`live-ish harness: ${message}`);
    }

    process.stdout.write(`PELICAN_PROVISIONING_TARGETS_JSON=${candidate.json}\n`);
}

if (require.main === module) {
    main().catch(err => {
        console.error("LIVEISH_PELICAN_TARGET_BUILD_FAILED");
        console.error(err && err.stack ? err.stack : String(err));
        process.exit(1);
    });
}

module.exports = {
    buildCandidate,
    findTargetAllocationIds,
    findTargetEggIds,
    readTargetJson
};
