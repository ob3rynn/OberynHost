const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const {
    LIVEISH_CONTAINER_MEMORY_MB,
    LIVEISH_JVM_MEMORY_MB,
    createLiveishMarker,
    isMarkedLiveishPurchase,
    validateLiveishTargetConfig
} = require("../scripts/lib/liveishHarness");
const { buildLiveishAuditReport, summarize } = require("../scripts/audit-liveish-harness");
const { buildCandidate } = require("../scripts/build-liveish-pelican-target");
const { shouldRunLiveish } = require("../scripts/run-liveish-fulfillment-smoke");
const { parseOptions } = require("../scripts/cleanup-liveish-harness");

const BACKEND_ROOT = path.resolve(__dirname, "..");

function createTargetJson(overrides = {}) {
    return JSON.stringify({
        "paper-launch-default": {
            egg: {
                byRuntimeProfile: {
                    "paper-java17": 17,
                    "paper-java21": 21,
                    "paper-java25": 25
                }
            },
            allocationIds: [9001, 9002],
            dockerImage: {
                byRuntimeProfile: {
                    "paper-java17": "ghcr.io/pelican-eggs/yolks:java_17",
                    "paper-java21": "ghcr.io/pelican-eggs/yolks:java_21",
                    "paper-java25": "ghcr.io/pelican-eggs/yolks:java_25"
                }
            },
            startup: `java -Xms128M -Xmx${LIVEISH_JVM_MEMORY_MB}M -jar {{SERVER_JARFILE}}`,
            environment: {
                SERVER_JARFILE: "server.jar",
                MINECRAFT_VERSION: "{{minecraftVersion}}",
                BUILD_NUMBER: "latest"
            },
            limits: {
                memory: LIVEISH_CONTAINER_MEMORY_MB,
                swap: 0,
                disk: 10240,
                io: 500,
                cpu: 0,
                threads: null
            },
            featureLimits: {
                databases: 0,
                allocations: 0,
                backups: 1
            },
            skipScripts: false,
            startOnCompletion: false,
            oomKiller: true,
            ...overrides
        }
    });
}

test("live-ish smoke exits safely without the explicit run gate", () => {
    assert.equal(shouldRunLiveish({}), false);
    assert.equal(shouldRunLiveish({ OBERYNHOST_RUN_LIVEISH: "1" }), true);

    const result = spawnSync(process.execPath, ["scripts/run-liveish-fulfillment-smoke.js"], {
        cwd: BACKEND_ROOT,
        env: {
            ...process.env,
            OBERYNHOST_RUN_LIVEISH: ""
        },
        encoding: "utf8"
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /LIVEISH_HARNESS_SKIPPED/);
});

test("live-ish target validation enforces Paper 2 GB resource truth", () => {
    const valid = validateLiveishTargetConfig(createTargetJson());
    assert.equal(valid.ok, true);

    const wrongMemory = validateLiveishTargetConfig(createTargetJson({
        limits: {
            memory: 3072,
            swap: 0,
            disk: 10240,
            io: 500,
            cpu: 0,
            threads: null
        }
    }));
    assert.equal(wrongMemory.ok, false);
    assert.match(wrongMemory.errors.join(" "), /limits\.memory must be 2424/);

    const missingJvm = validateLiveishTargetConfig(createTargetJson({
        startup: "java -Xms128M -jar {{SERVER_JARFILE}}"
    }));
    assert.equal(missingJvm.ok, false);
    assert.match(missingJvm.errors.join(" "), /JVM target 2024/);
});

test("target builder prints only validated operator-provided target JSON", async () => {
    const candidate = await buildCandidate({
        rawTargetJson: createTargetJson(),
        env: {}
    });

    assert.equal(candidate.ok, true);
    assert.match(candidate.json, /paper-launch-default/);
    assert.match(candidate.messages.join(" "), /memory=2424/);
});

test("live-ish audit fails product/env drift and warns for missing external harness config in safe mode", async () => {
    const report = await buildLiveishAuditReport({
        loadEnv: false,
        env: {
            BASE_URL: "http://127.0.0.1:3000",
            STRIPE_SECRET_KEY: "sk_test_example",
            STRIPE_WEBHOOK_SECRET: "whsec_example",
            STRIPE_PRICE_PAPER_2GB: "price_test_example",
            EMAIL_PROVIDER: "log",
            PELICAN_PROVISIONING_TARGETS_JSON: createTargetJson(),
            DATABASE_PATH: "/tmp/oberynn-liveish-test-does-not-exist.sqlite3"
        },
        strict: false
    });
    const counts = summarize(report);

    assert.equal(counts.fail, 0);
    assert.ok(counts.warn >= 1);
});

test("live-ish cleanup helpers only recognize marked artifacts", () => {
    const marker = createLiveishMarker("unit");

    assert.equal(isMarkedLiveishPurchase({ serverName: marker }), true);
    assert.equal(isMarkedLiveishPurchase({ email: `${marker}@example.com` }), true);
    assert.equal(isMarkedLiveishPurchase({ serverName: "customer-server" }), false);

    assert.deepEqual(parseOptions(["node", "script"]), {
        applyLocal: false,
        cancelStripe: false,
        json: false
    });
    assert.deepEqual(parseOptions(["node", "script", "--apply-local", "--json"]), {
        applyLocal: true,
        cancelStripe: false,
        json: true
    });
});
