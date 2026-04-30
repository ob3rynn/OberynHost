const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const sqlite3 = require("sqlite3").verbose();

const {
    OPERATOR_HARNESS_CONTAINER_MEMORY_MB,
    OPERATOR_HARNESS_JVM_MEMORY_MB,
    createOperatorHarnessMarker,
    dbGet,
    dbRun,
    isMarkedOperatorHarnessPurchase,
    validateOperatorHarnessTargetConfig
} = require("../scripts/lib/operatorHarness");
const { buildOperatorHarnessAuditReport, summarize } = require("../scripts/audit-operator-harness");
const { buildCandidate } = require("../scripts/build-operator-pelican-target");
const {
    isClientResourcesNotReadyError,
    shouldRunOperatorHarness
} = require("../scripts/run-operator-fulfillment-smoke");
const {
    applyLocalCleanup,
    formatCleanupResult,
    parseOptions
} = require("../scripts/cleanup-operator-harness");

const BACKEND_ROOT = path.resolve(__dirname, "..");

function createMemoryDatabase() {
    return new sqlite3.Database(":memory:");
}

function closeMemoryDatabase(database) {
    return new Promise((resolve, reject) => {
        database.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

async function createCleanupSchema(database) {
    await dbRun(database, `
        CREATE TABLE purchases (
            id INTEGER PRIMARY KEY,
            serverId INTEGER,
            status TEXT,
            setupStatus TEXT,
            fulfillmentStatus TEXT,
            updatedAt INTEGER,
            lastStateOwner TEXT,
            stripeCustomerId TEXT,
            pelicanServerId TEXT,
            pelicanServerIdentifier TEXT,
            pelicanAllocationId TEXT,
            email TEXT,
            serverName TEXT,
            hostname TEXT
        )
    `);
    await dbRun(database, `
        CREATE TABLE servers (
            id INTEGER PRIMARY KEY,
            status TEXT,
            reservationKey TEXT,
            reservedAt INTEGER,
            allocatedAt INTEGER
        )
    `);
    await dbRun(database, `
        CREATE TABLE customerPelicanLinks (
            stripeCustomerId TEXT PRIMARY KEY,
            pelicanUserId TEXT,
            pelicanUsername TEXT
        )
    `);
}

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
            startup: `java -Xms128M -Xmx${OPERATOR_HARNESS_JVM_MEMORY_MB}M -jar {{SERVER_JARFILE}}`,
            environment: {
                SERVER_JARFILE: "server.jar",
                MINECRAFT_VERSION: "{{minecraftVersion}}",
                BUILD_NUMBER: "latest"
            },
            limits: {
                memory: OPERATOR_HARNESS_CONTAINER_MEMORY_MB,
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

test("operator harness smoke exits safely without the explicit run gate", () => {
    assert.equal(shouldRunOperatorHarness({}), false);
    assert.equal(shouldRunOperatorHarness({ OBERYNHOST_RUN_OPERATOR_HARNESS: "1" }), true);

    const result = spawnSync(process.execPath, ["scripts/run-operator-fulfillment-smoke.js"], {
        cwd: BACKEND_ROOT,
        env: {
            ...process.env,
            OBERYNHOST_RUN_OPERATOR_HARNESS: ""
        },
        encoding: "utf8"
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /OPERATOR_HARNESS_SKIPPED/);
});

test("operator harness target validation enforces Paper 2 GB resource truth", () => {
    const valid = validateOperatorHarnessTargetConfig(createTargetJson());
    assert.equal(valid.ok, true);

    const wrongMemory = validateOperatorHarnessTargetConfig(createTargetJson({
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

    const missingJvm = validateOperatorHarnessTargetConfig(createTargetJson({
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

test("operator harness reusable user client resources treats Pelican install 409 as retryable", () => {
    assert.equal(isClientResourcesNotReadyError(new Error(
        "Pelican API GET /api/client/servers/example/resources failed with HTTP 409. This server has not yet completed its installation process, please try again later."
    )), true);
    assert.equal(isClientResourcesNotReadyError(new Error("HTTP 409 different conflict")), false);
    assert.equal(isClientResourcesNotReadyError(new Error("HTTP 500")), false);
});

test("operator harness audit fails product/env drift and warns for missing external harness config in safe mode", async () => {
    const report = await buildOperatorHarnessAuditReport({
        loadEnv: false,
        env: {
            BASE_URL: "http://127.0.0.1:3000",
            STRIPE_SECRET_KEY: "sk_test_example",
            STRIPE_WEBHOOK_SECRET: "whsec_example",
            STRIPE_PRICE_PAPER_2GB: "price_test_example",
            EMAIL_PROVIDER: "log",
            PELICAN_PROVISIONING_TARGETS_JSON: createTargetJson(),
            DATABASE_PATH: "/tmp/oberynn-operator-harness-test-does-not-exist.sqlite3"
        },
        strict: false
    });
    const counts = summarize(report);

    assert.equal(counts.fail, 0);
    assert.ok(counts.warn >= 1);
});

test("operator harness cleanup helpers only recognize marked artifacts", () => {
    const marker = createOperatorHarnessMarker("unit");

    assert.equal(isMarkedOperatorHarnessPurchase({ serverName: marker }), true);
    assert.equal(isMarkedOperatorHarnessPurchase({ email: `${marker}@example.com` }), true);
    assert.equal(isMarkedOperatorHarnessPurchase({ serverName: "customer-server" }), false);

    assert.deepEqual(parseOptions(["node", "script"]), {
        applyLocal: false,
        cancelStripe: false,
        forceReleaseLocalCapacityWithoutPelicanCleanup: false,
        json: false
    });
    assert.deepEqual(parseOptions(["node", "script", "--apply-local", "--json"]), {
        applyLocal: true,
        cancelStripe: false,
        forceReleaseLocalCapacityWithoutPelicanCleanup: false,
        json: true
    });
    assert.deepEqual(parseOptions(["node", "script", "--force-release-local-capacity-without-pelican-cleanup"]), {
        applyLocal: false,
        cancelStripe: false,
        forceReleaseLocalCapacityWithoutPelicanCleanup: true,
        json: false
    });
});

test("operator harness local cleanup preserves capacity when Pelican linkage still exists", async () => {
    const database = createMemoryDatabase();

    try {
        await createCleanupSchema(database);
        await dbRun(
            database,
            "INSERT INTO servers (id, status, reservationKey, reservedAt, allocatedAt) VALUES (1, 'allocated', 'operator-harness-hold', 1, 2)"
        );
        await dbRun(
            database,
            `INSERT INTO purchases
                (id, serverId, status, setupStatus, fulfillmentStatus, stripeCustomerId,
                 pelicanServerId, pelicanServerIdentifier, pelicanAllocationId, email, serverName)
             VALUES
                (1, 1, 'paid', 'setup_submitted', 'pending_activation', 'cus_operator-harness',
                 '123', 'srv_operator-harness', '9001', 'operator-harness-test@example.com', 'operator-harness-test')`
        );
        await dbRun(
            database,
            "INSERT INTO customerPelicanLinks (stripeCustomerId, pelicanUserId, pelicanUsername) VALUES ('cus_operator-harness', '456', 'operator-harnessuser')"
        );

        const result = await applyLocalCleanup(database, [
            {
                id: 1,
                serverId: 1,
                stripeCustomerId: "cus_operator-harness",
                pelicanServerId: "123",
                pelicanServerIdentifier: "srv_operator-harness",
                pelicanAllocationId: "9001",
                serverName: "operator-harness-test"
            }
        ], {
            applyLocal: true
        });

        const purchase = await dbGet(database, "SELECT status, lastStateOwner FROM purchases WHERE id = 1");
        const server = await dbGet(database, "SELECT status, reservationKey FROM servers WHERE id = 1");
        const link = await dbGet(database, "SELECT * FROM customerPelicanLinks WHERE stripeCustomerId = 'cus_operator-harness'");

        assert.equal(purchase.status, "cancelled");
        assert.equal(purchase.lastStateOwner, "operator_harness_cleanup");
        assert.equal(server.status, "allocated");
        assert.equal(server.reservationKey, "operator-harness-hold");
        assert.equal(link, null);
        assert.equal(result.updatedPurchases, 1);
        assert.equal(result.releasedServers, 0);
        assert.equal(result.removedLinks, 1);
        assert.equal(result.manualPelicanCleanupRequired.length, 1);
        assert.equal(result.forcedCapacityReleaseWithoutPelicanCleanup.length, 0);
    } finally {
        await closeMemoryDatabase(database);
    }
});

test("operator harness local cleanup force flag releases marked capacity without Pelican cleanup confirmation", async () => {
    const database = createMemoryDatabase();

    try {
        await createCleanupSchema(database);
        await dbRun(
            database,
            "INSERT INTO servers (id, status, reservationKey, reservedAt, allocatedAt) VALUES (2, 'allocated', 'operator-harness-force', 1, 2)"
        );
        await dbRun(
            database,
            `INSERT INTO purchases
                (id, serverId, status, setupStatus, fulfillmentStatus, stripeCustomerId,
                 pelicanServerId, pelicanServerIdentifier, pelicanAllocationId, email, serverName)
             VALUES
                (2, 2, 'paid', 'setup_submitted', 'pending_activation', 'cus_force',
                 '222', 'srv_force', '9002', 'operator-harness-force@example.com', 'operator-harness-force')`
        );

        const result = await applyLocalCleanup(database, [
            {
                id: 2,
                serverId: 2,
                stripeCustomerId: "cus_force",
                pelicanServerId: "222",
                pelicanServerIdentifier: "srv_force",
                pelicanAllocationId: "9002",
                serverName: "operator-harness-force"
            }
        ], {
            applyLocal: true,
            forceReleaseLocalCapacityWithoutPelicanCleanup: true
        });

        const server = await dbGet(database, "SELECT status, reservationKey, allocatedAt FROM servers WHERE id = 2");
        const formatted = formatCleanupResult({
            dryRun: false,
            forceReleaseLocalCapacityWithoutPelicanCleanup: true,
            localCleanup: result,
            stripeCancelled: [],
            candidates: [
                {
                    id: 2,
                    serverName: "operator-harness-force",
                    status: "paid",
                    fulfillmentStatus: "pending_activation"
                }
            ]
        });

        assert.equal(server.status, "available");
        assert.equal(server.reservationKey, null);
        assert.equal(server.allocatedAt, null);
        assert.equal(result.releasedServers, 1);
        assert.equal(result.manualPelicanCleanupRequired.length, 0);
        assert.equal(result.forcedCapacityReleaseWithoutPelicanCleanup.length, 1);
        assert.match(formatted, /WARNING: forced local capacity release/);
    } finally {
        await closeMemoryDatabase(database);
    }
});
