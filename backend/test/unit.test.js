const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCookies, serializeCookie, clearCookie } = require("../utils/cookies");
const { generateOpaqueToken, isOpaqueToken, timingSafeEqualString } = require("../utils/tokens");
const { createRateLimiter } = require("../middleware/rateLimit");

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
