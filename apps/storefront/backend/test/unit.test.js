const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseCookies, serializeCookie, clearCookie } = require("../utils/cookies");
const { generateOpaqueToken, isOpaqueToken, timingSafeEqualString } = require("../utils/tokens");
const { createRateLimiter } = require("../middleware/rateLimit");
const { getPurchasePolicyState } = require("../services/policyRules");
const BACKEND_ROOT = path.resolve(__dirname, "..");

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

test("relative DATABASE_PATH resolves from the backend directory, not cwd", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oberynn-db-path-"));
    const databaseFile = path.join(tempDir, "relative-test.db");
    const relativeToBackend = path.relative(BACKEND_ROOT, databaseFile);
    const previousCwd = process.cwd();
    const previousDatabasePath = process.env.DATABASE_PATH;
    const previousNodeEnv = process.env.NODE_ENV;
    const dbModulePath = require.resolve("../db");

    delete require.cache[dbModulePath];

    process.env.DATABASE_PATH = relativeToBackend;
    process.env.NODE_ENV = "test";
    process.chdir(os.tmpdir());

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
        os.tmpdir(),
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
