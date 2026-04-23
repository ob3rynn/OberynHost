const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { parseCookies, serializeCookie, clearCookie } = require("../utils/cookies");
const { generateOpaqueToken, isOpaqueToken, timingSafeEqualString } = require("../utils/tokens");
const { createRateLimiter } = require("../middleware/rateLimit");
const { getPurchasePolicyState } = require("../services/policyRules");
const {
    buildRuntimeConfig,
    findPlaceholderEnvNames
} = require("../config/validation");
const BACKEND_ROOT = path.resolve(__dirname, "..");
const TEST_TMP_ROOT = process.env.TEST_TMP_ROOT || "/tmp";

function createRuntimeEnv(overrides = {}) {
    return {
        PORT: "3000",
        HOST: "0.0.0.0",
        BASE_URL: "http://127.0.0.1:3000",
        ALLOWED_ORIGINS: "http://localhost:3000",
        ADMIN_KEY: "test-admin-key",
        STRIPE_SECRET_KEY: "sk_test_live_123456",
        STRIPE_API_VERSION: "2026-02-25.clover",
        STRIPE_WEBHOOK_SECRET: "whsec_live_123456",
        STRIPE_PRICE_3GB: "price_live_3gb",
        ...overrides
    };
}

function createPelicanTargetsJson(overrides = {}) {
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
            startup: "java -Xms128M -XX:MaxRAMPercentage=95.0 -jar {{SERVER_JARFILE}}",
            environment: {
                SERVER_JARFILE: "server.jar",
                MINECRAFT_VERSION: "{{minecraftVersion}}",
                BUILD_NUMBER: "latest"
            },
            limits: {
                memory: 3072,
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

test("cookie helpers parse, serialize, and clear cookies", () => {
    const header = serializeCookie("session", "abc 123", {
        maxAgeMs: 5_000,
        sameSite: "Strict",
        secure: true,
        priority: "High"
    });

    assert.match(header, /^session=abc%20123;/);
    assert.equal(parseCookies(header).session, "abc 123");
    assert.match(clearCookie("session"), /Max-Age=0/);
});

test("token helpers generate valid opaque values and compare safely", () => {
    const token = generateOpaqueToken();

    assert.equal(isOpaqueToken(token), true);
    assert.equal(isOpaqueToken("bad token"), false);
    assert.equal(timingSafeEqualString("abc", "abc"), true);
    assert.equal(timingSafeEqualString("abc", "def"), false);
});

test("rate limiter blocks requests after the configured threshold", () => {
    const limiter = createRateLimiter({
        windowMs: 60_000,
        max: 2,
        message: "Too many requests"
    });

    const responses = [];

    function createResponse() {
        return {
            statusCode: 200,
            headers: {},
            setHeader(name, value) {
                this.headers[name] = value;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                responses.push({ statusCode: this.statusCode, payload, headers: this.headers });
                return this;
            }
        };
    }

    const req = { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } };
    let passes = 0;
    const next = () => { passes += 1; };

    limiter(req, createResponse(), next);
    limiter(req, createResponse(), next);
    limiter(req, createResponse(), next);

    assert.equal(passes, 2);
    assert.equal(responses[0].statusCode, 429);
    assert.equal(responses[0].payload.error, "Too many requests");
    assert.ok(Number(responses[0].headers["Retry-After"]) >= 1);
});

test("runtime config accepts localhost base and allowed origins", () => {
    const config = buildRuntimeConfig(createRuntimeEnv());

    assert.equal(config.baseUrl, "http://127.0.0.1:3000");
    assert.deepEqual(config.allowedOrigins, [
        "http://127.0.0.1:3000",
        "http://localhost:3000"
    ]);
    assert.equal(config.secureCookies, false);
});

test("runtime config parses optional Pelican provisioning targets", () => {
    const config = buildRuntimeConfig(createRuntimeEnv({
        PELICAN_PANEL_URL: "https://panel.oberyn.net/",
        PELICAN_APPLICATION_API_KEY: "ptla_test_key",
        PELICAN_PROVISIONING_TARGETS_JSON: createPelicanTargetsJson()
    }));

    assert.equal(config.pelican.configured, true);
    assert.equal(config.pelican.panelUrl, "https://panel.oberyn.net");
    assert.equal(config.pelican.provisioningTargets["paper-launch-default"].allocationIds[0], 9001);
    assert.equal(config.pelican.provisioningTargets["paper-launch-default"].egg.byRuntimeProfile["paper-java21"], 21);
    assert.equal(config.pelican.provisioningTargets["paper-launch-default"].limits.memory, 3072);
});

test("runtime config rejects malformed Pelican target JSON when provided", () => {
    assert.throws(
        () => buildRuntimeConfig(createRuntimeEnv({
            PELICAN_PROVISIONING_TARGETS_JSON: "[]"
        })),
        /PELICAN_PROVISIONING_TARGETS_JSON must be an object/
    );

    assert.throws(
        () => buildRuntimeConfig(createRuntimeEnv({
            PELICAN_PROVISIONING_TARGETS_JSON: createPelicanTargetsJson({
                allocationIds: []
            })
        })),
        /allocationIds must be a non-empty array/
    );
});

test("runtime config rejects shipped placeholder values", () => {
    assert.throws(
        () => buildRuntimeConfig(createRuntimeEnv({
            BASE_URL: "https://storefront.example.com",
            ADMIN_KEY: "replace-with-a-long-random-secret",
            STRIPE_SECRET_KEY: "sk_test_replace_me",
            STRIPE_WEBHOOK_SECRET: "whsec_replace_me",
            STRIPE_PRICE_3GB: "price_replace_me"
        })),
        /Replace placeholder configuration values before startup: BASE_URL, ADMIN_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/
    );
});

test("placeholder detection flags example-domain allowed origins", () => {
    assert.deepEqual(
        findPlaceholderEnvNames(createRuntimeEnv({
            ALLOWED_ORIGINS: "https://storefront.example.com, http://localhost:3000"
        })),
        ["ALLOWED_ORIGINS"]
    );
});

test("runtime config preserves existing PORT and ALLOWED_ORIGINS validation", () => {
    assert.throws(
        () => buildRuntimeConfig(createRuntimeEnv({ PORT: "0" })),
        /PORT must be an integer between 1 and 65535/
    );

    assert.throws(
        () => buildRuntimeConfig(createRuntimeEnv({ ALLOWED_ORIGINS: "not-a-url" })),
        /ALLOWED_ORIGINS must be a valid absolute URL/
    );
});

test("relative DATABASE_PATH resolves from the backend directory, not cwd", async () => {
    const tempDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "oberynn-db-path-"));
    const databaseFile = path.join(tempDir, "relative-test.db");
    const relativeToBackend = path.relative(BACKEND_ROOT, databaseFile);
    const previousCwd = process.cwd();
    const previousDatabasePath = process.env.DATABASE_PATH;
    const previousNodeEnv = process.env.NODE_ENV;
    const dbModulePath = require.resolve("../db");

    delete require.cache[dbModulePath];

    process.env.DATABASE_PATH = relativeToBackend;
    process.env.NODE_ENV = "test";
    process.chdir(TEST_TMP_ROOT);

    const db = require("../db");

    await new Promise((resolve, reject) => {
        db.run("CREATE TABLE IF NOT EXISTS smoke (id INTEGER)", err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });

    await new Promise((resolve, reject) => {
        db.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });

    process.chdir(previousCwd);

    if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
    } else {
        process.env.DATABASE_PATH = previousDatabasePath;
    }

    if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
    } else {
        process.env.NODE_ENV = previousNodeEnv;
    }

    delete require.cache[dbModulePath];

    assert.equal(fs.existsSync(databaseFile), true);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("DATABASE_PATH fails fast when the parent directory does not exist", () => {
    const missingDatabaseFile = path.join(
        TEST_TMP_ROOT,
        `oberynn-db-missing-${Date.now()}`,
        "nested",
        "missing.db"
    );
    const relativeToBackend = path.relative(BACKEND_ROOT, missingDatabaseFile);
    const previousDatabasePath = process.env.DATABASE_PATH;
    const previousNodeEnv = process.env.NODE_ENV;
    const dbModulePath = require.resolve("../db");

    delete require.cache[dbModulePath];
    process.env.DATABASE_PATH = relativeToBackend;
    process.env.NODE_ENV = "test";

    assert.throws(
        () => require("../db"),
        /SQLite database directory does not exist/
    );

    if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
    } else {
        process.env.DATABASE_PATH = previousDatabasePath;
    }

    if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
    } else {
        process.env.NODE_ENV = previousNodeEnv;
    }

    delete require.cache[dbModulePath];
});

test("policy rules compute refund, grace, suspension, and purge windows", () => {
    const now = 1_800_000_000_000;

    const preFulfillment = getPurchasePolicyState({
        status: "paid",
        createdAt: now - 1_000
    }, now);
    assert.equal(preFulfillment.preFulfillmentRefundEligible, true);
    assert.equal(preFulfillment.originalPurchaseRefundEligible, false);

    const refundWindow = getPurchasePolicyState({
        status: "completed",
        createdAt: now - (1000 * 60 * 60 * 24)
    }, now);
    assert.equal(refundWindow.originalPurchaseRefundEligible, true);

    const grace = getPurchasePolicyState({
        status: "completed",
        stripeSubscriptionStatus: "past_due",
        subscriptionDelinquentAt: now - (1000 * 60 * 60 * 24)
    }, now);
    assert.equal(grace.inGracePeriod, true);
    assert.equal(grace.suspensionRequired, false);

    const suspend = getPurchasePolicyState({
        status: "completed",
        stripeSubscriptionStatus: "past_due",
        subscriptionDelinquentAt: now - (1000 * 60 * 60 * 24 * 8)
    }, now);
    assert.equal(suspend.inGracePeriod, false);
    assert.equal(suspend.suspensionRequired, true);

    const purge = getPurchasePolicyState({
        status: "completed",
        stripeSubscriptionStatus: "past_due",
        subscriptionDelinquentAt: now - (1000 * 60 * 60 * 24 * 40),
        serviceSuspendedAt: now - (1000 * 60 * 60 * 24 * 31)
    }, now);
    assert.equal(purge.purgeRequired, true);
});
