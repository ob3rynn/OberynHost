const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    assertCoreBusinessInvariants,
    seedPaidSetupPurchase,
    setupCookie,
    tokenFor
} = require("./helpers/abuseFixtures");

async function postJson(app, path, body, options = {}) {
    return app.request(path, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.headers || {})
        },
        body: JSON.stringify(body),
        userAgent: options.userAgent || "RateLimitAbuse/1.0"
    });
}

test("bad admin-key spray is rate limited without creating sessions or audit actions", async t => {
    const app = await createTestApp(t);
    const responses = [];

    for (let index = 0; index < 6; index += 1) {
        responses.push(await postJson(app, "/api/admin/login", {
            key: `wrong-${index}`
        }, {
            userAgent: "AdminSpray/1.0"
        }));
    }

    assert.deepEqual(responses.slice(0, 5).map(response => response.status), [401, 401, 401, 401, 401]);
    assert.equal(responses[5].status, 429);
    assert.ok(Number(responses[5].headers.get("retry-after")) >= 1);

    const audit = await app.queries.getQuery("SELECT COUNT(*) AS count FROM adminAuditLog");
    assert.equal(audit.count, 0);
    await assertCoreBusinessInvariants(app.queries);
});

test("setup-status spam is rate limited by client identity", async t => {
    const app = await createTestApp(t, { trustProxy: true });
    const responses = [];

    for (let index = 0; index < 21; index += 1) {
        responses.push(await postJson(app, "/api/setup-status", {
            setupToken: tokenFor("missing_setup_status", index)
        }, {
            headers: {
                "x-forwarded-for": "198.51.100.10"
            },
            userAgent: "SetupStatusSpam/1.0"
        }));
    }

    assert.ok(responses.slice(0, 20).every(response => response.status === 400));
    assert.equal(responses[20].status, 429);
    assert.ok(Number(responses[20].headers.get("retry-after")) >= 1);

    const purchases = await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases");
    assert.equal(purchases.count, 0);
    await assertCoreBusinessInvariants(app.queries);
});

test("complete-setup spam is rate limited and does not create provisioning work", async t => {
    const app = await createTestApp(t);
    const responses = [];

    for (let index = 0; index < 11; index += 1) {
        responses.push(await postJson(app, "/api/complete-setup", {
            setupToken: tokenFor("missing_complete_setup", index),
            serverName: "Spam Setup",
            minecraftVersion: "1.21.11",
            pelicanUsername: `spam_setup_${index}`,
            pelicanPassword: "spam-setup-password"
        }, {
            userAgent: "CompleteSetupSpam/1.0"
        }));
    }

    assert.ok(responses.slice(0, 10).every(response => response.status === 400));
    assert.equal(responses[10].status, 429);

    const jobs = await app.queries.getQuery("SELECT COUNT(*) AS count FROM fulfillmentQueue");
    const purchases = await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases");
    assert.equal(jobs.count, 0);
    assert.equal(purchases.count, 0);
    await assertCoreBusinessInvariants(app.queries);
});

test("checkout spam is rate limited before reservations are created", async t => {
    const app = await createTestApp(t);
    const responses = [];

    for (let index = 0; index < 11; index += 1) {
        responses.push(await postJson(app, "/api/create-checkout", {
            planType: "bad-plan"
        }, {
            userAgent: "CheckoutSpam/1.0"
        }));
    }

    assert.ok(responses.slice(0, 10).every(response => response.status === 400));
    assert.equal(responses[10].status, 429);
    assert.equal(app.stripeState.lastCreatedSessionParams, null);

    const purchases = await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases");
    const held = await app.queries.getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = ?", ["held"]);
    assert.equal(purchases.count, 0);
    assert.equal(held.count, 0);
    await assertCoreBusinessInvariants(app.queries);
});

test("billing portal spam is rate limited without opening extra Stripe sessions", async t => {
    const app = await createTestApp(t, {
        stripeBillingPortalConfigurationId: "bpc_test_rate_limit"
    });
    const paid = await seedPaidSetupPurchase(app, {
        serverId: 1,
        setupToken: tokenFor("setup_token_billing_spam", 1),
        stripeCustomerId: "cus_billing_spam"
    });
    const responses = [];

    for (let index = 0; index < 9; index += 1) {
        responses.push(await postJson(app, "/api/create-billing-portal-session", {}, {
            cookie: setupCookie(paid.setupToken),
            userAgent: "BillingPortalSpam/1.0"
        }));
    }

    assert.ok(responses.slice(0, 8).every(response => response.status === 200));
    assert.equal(responses[8].status, 429);
    assert.equal(app.stripeState.lastCreatedPortalSessionParams.customer, "cus_billing_spam");

    const purchase = await app.queries.getQuery(
        "SELECT status, stripeCustomerId FROM purchases WHERE id = ?",
        [paid.purchase.id]
    );
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.stripeCustomerId, "cus_billing_spam");
    await assertCoreBusinessInvariants(app.queries);
});
