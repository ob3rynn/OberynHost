const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    assertCoreBusinessInvariants,
    getStorefrontCounts
} = require("./helpers/invariants");

function checkoutRequest(app, index, options = {}) {
    const headers = {
        "content-type": "application/json",
        origin: app.baseUrl,
        "x-forwarded-for": options.ip || `198.51.100.${index + 1}`
    };

    if (options.cookie) {
        headers.cookie = options.cookie;
    }

    return app.request("/api/create-checkout", {
        method: "POST",
        headers,
        body: JSON.stringify({ planType: "paper-2gb" }),
        userAgent: options.userAgent || `StormActor/${index}`
    });
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

test("fresh-browser checkout storm cannot oversell the 25-slot Paper launch inventory", async t => {
    let createCount = 0;
    const app = await createTestApp(t, {
        trustProxy: true,
        stripe: {
            createSession: async () => {
                createCount += 1;
                return {
                    id: `cs_test_storm_${String(createCount).padStart(2, "0")}`,
                    url: `https://checkout.stripe.test/storm/${createCount}`
                };
            },
            retrieveSession: async id => ({
                id,
                status: "open",
                payment_status: "unpaid",
                url: `https://checkout.stripe.test/resume/${id}`
            })
        }
    });
    const { allQuery, getQuery } = app.queries;

    const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => checkoutRequest(app, index))
    );
    const statuses = responses.map(response => response.status);

    assert.equal(statuses.filter(status => status === 200).length, 25);
    assert.equal(statuses.filter(status => status === 400).length, 25);
    assert.equal(statuses.filter(status => status === 429).length, 0);
    assert.equal(createCount, 25);

    const purchases = await allQuery(
        "SELECT id, serverId, status, stripeSessionId FROM purchases ORDER BY id ASC"
    );
    assert.equal(purchases.length, 25);
    assert.equal(new Set(purchases.map(purchase => purchase.serverId)).size, 25);
    assert.ok(purchases.every(purchase => purchase.status === "checkout_pending"));
    assert.ok(purchases.every(purchase => purchase.stripeSessionId));

    const counts = await getStorefrontCounts(app.queries);
    assert.equal(counts.held, 25);
    assert.equal(counts.available || 0, 0);
    assert.equal((await getQuery("SELECT COUNT(*) AS count FROM servers")).count, 25);

    await assertCoreBusinessInvariants(app.queries);
});

test("same-browser repeated checkout attempts resume one held slot instead of multiplying reservations", async t => {
    let createCount = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                createCount += 1;
                return {
                    id: "cs_test_same_browser_storm",
                    url: "https://checkout.stripe.test/same-browser"
                };
            },
            retrieveSession: async id => ({
                id,
                status: "open",
                payment_status: "unpaid",
                url: "https://checkout.stripe.test/same-browser"
            })
        }
    });
    const { getQuery } = app.queries;

    const first = await checkoutRequest(app, 0);
    assert.equal(first.status, 200);
    const cookie = app.parseSetCookie(first);

    const retries = await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
            checkoutRequest(app, index + 1, { cookie, userAgent: "SameBrowser/1.0" })
        )
    );
    const payloads = await Promise.all(retries.map(readJson));

    assert.ok(retries.every(response => response.status === 200));
    assert.ok(payloads.every(payload => payload?.resumed === true));
    assert.equal(createCount, 1);

    const purchaseCount = await getQuery("SELECT COUNT(*) AS count FROM purchases");
    const heldCount = await getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = 'held'");
    assert.equal(purchaseCount.count, 1);
    assert.equal(heldCount.count, 1);

    await assertCoreBusinessInvariants(app.queries);
});

test("Stripe checkout failures during a storm roll back reservations without orphaning capacity", async t => {
    let createCount = 0;
    const app = await createTestApp(t, {
        trustProxy: true,
        stripe: {
            createSession: async () => {
                createCount += 1;

                if (createCount % 5 === 0) {
                    throw new Error("Stripe storm failure");
                }

                return {
                    id: `cs_test_flaky_storm_${createCount}`,
                    url: `https://checkout.stripe.test/flaky/${createCount}`
                };
            }
        }
    });
    const { getQuery } = app.queries;

    const responses = await Promise.all(
        Array.from({ length: 30 }, (_, index) => checkoutRequest(app, index))
    );
    const statuses = responses.map(response => response.status);
    const successes = statuses.filter(status => status === 200).length;
    const stripeFailures = statuses.filter(status => status === 500).length;

    assert.equal(successes, 24);
    assert.equal(stripeFailures, 6);
    assert.equal(statuses.filter(status => status === 429).length, 0);

    const held = await getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = 'held'");
    const available = await getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = 'available'");
    const activePurchases = await getQuery(
        "SELECT COUNT(*) AS count FROM purchases WHERE status NOT IN ('cancelled', 'expired')"
    );
    assert.equal(held.count, successes);
    assert.equal(available.count, 25 - successes);
    assert.equal(activePurchases.count, successes);

    await assertCoreBusinessInvariants(app.queries);
});
