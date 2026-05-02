const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const { assertCoreBusinessInvariants } = require("./helpers/invariants");

async function createCheckout(app) {
    const response = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "paper-2gb" })
    });
    assert.equal(response.status, 200);
    return response;
}

function completedEvent(sessionId, purchase, overrides = {}) {
    return {
        id: overrides.eventId || `evt_${sessionId}`,
        type: "checkout.session.completed",
        data: {
            object: {
                id: sessionId,
                metadata: {
                    purchaseId: String(purchase.id),
                    serverId: String(purchase.serverId),
                    planType: "paper-2gb",
                    productCode: "minecraft-paper-2gb",
                    ...overrides.metadata
                },
                subscription: overrides.subscription === undefined
                    ? `sub_${sessionId}`
                    : overrides.subscription,
                customer: overrides.customer || `cus_${sessionId}`,
                customer_details: {
                    email: overrides.email || `${sessionId}@example.com`
                }
            }
        }
    };
}

async function postWebhook(app, event) {
    return app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify(event)
    });
}

test("duplicate checkout completion deliveries are idempotent for purchase and inventory state", async t => {
    let checkoutNumber = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                checkoutNumber += 1;
                return {
                    id: `cs_test_replay_${checkoutNumber}`,
                    url: `https://checkout.stripe.test/replay/${checkoutNumber}`
                };
            },
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: `cus_${id}`,
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_000,
                            price: { id: "price_test_paper_2gb" }
                        }
                    ]
                }
            })
        }
    });
    const { getQuery, allQuery } = app.queries;

    await createCheckout(app);
    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_replay_1"
    ]);
    const event = completedEvent("cs_test_replay_1", purchase, {
        eventId: "evt_test_replay_same"
    });

    const first = await postWebhook(app, event);
    const replay = await postWebhook(app, event);
    const duplicateDifferentId = await postWebhook(app, {
        ...event,
        id: "evt_test_replay_different"
    });

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(duplicateDifferentId.status, 200);

    const paidPurchase = await getQuery("SELECT * FROM purchases WHERE id = ?", [purchase.id]);
    assert.equal(paidPurchase.status, "paid");
    assert.equal(paidPurchase.stripeSubscriptionId, "sub_cs_test_replay_1");
    assert.equal(paidPurchase.email, "cs_test_replay_1@example.com");

    const purchases = await allQuery("SELECT id, serverId, status FROM purchases");
    assert.deepEqual(purchases.map(row => row.id), [purchase.id]);
    assert.equal(new Set(purchases.map(row => row.serverId)).size, 1);

    await assertCoreBusinessInvariants(app.queries);
});

test("malformed or mismatched checkout completion metadata cannot mutate the wrong purchase", async t => {
    let checkoutNumber = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                checkoutNumber += 1;
                return {
                    id: `cs_test_mismatch_${checkoutNumber}`,
                    url: `https://checkout.stripe.test/mismatch/${checkoutNumber}`
                };
            },
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: `cus_${id}`,
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_000,
                            price: { id: "price_test_paper_2gb" }
                        }
                    ]
                }
            })
        }
    });
    const { getQuery } = app.queries;

    await createCheckout(app);
    await createCheckout(app);
    const firstPurchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_mismatch_1"
    ]);
    const secondPurchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_mismatch_2"
    ]);

    const mismatched = completedEvent("cs_test_mismatch_2", secondPurchase, {
        metadata: {
            purchaseId: String(firstPurchase.id),
            serverId: String(firstPurchase.serverId),
            planType: "paper-2gb"
        },
        subscription: "sub_test_mismatched_metadata"
    });
    const response = await postWebhook(app, mismatched);
    assert.equal(response.status, 200);

    const firstAfter = await getQuery("SELECT status, stripeSubscriptionId, email FROM purchases WHERE id = ?", [
        firstPurchase.id
    ]);
    const secondAfter = await getQuery("SELECT status, stripeSubscriptionId, email FROM purchases WHERE id = ?", [
        secondPurchase.id
    ]);
    assert.equal(firstAfter.status, "checkout_pending");
    assert.equal(firstAfter.stripeSubscriptionId, null);
    assert.equal(firstAfter.email, "");
    assert.equal(secondAfter.status, "checkout_pending");
    assert.equal(secondAfter.stripeSubscriptionId, null);
    assert.equal(secondAfter.email, "");

    await assertCoreBusinessInvariants(app.queries);
});

test("checkout completion without a subscription or with an unknown price is ignored safely", async t => {
    let checkoutNumber = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                checkoutNumber += 1;
                return {
                    id: `cs_test_bad_runtime_${checkoutNumber}`,
                    url: `https://checkout.stripe.test/bad-runtime/${checkoutNumber}`
                };
            },
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: `cus_${id}`,
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_000,
                            price: { id: "price_unknown_not_local" }
                        }
                    ]
                }
            })
        }
    });
    const { getQuery } = app.queries;

    await createCheckout(app);
    await createCheckout(app);
    const missingSubPurchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_bad_runtime_1"
    ]);
    const unknownPricePurchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_bad_runtime_2"
    ]);

    const missingSub = await postWebhook(app, completedEvent(
        "cs_test_bad_runtime_1",
        missingSubPurchase,
        { subscription: null }
    ));
    const unknownPrice = await postWebhook(app, completedEvent(
        "cs_test_bad_runtime_2",
        unknownPricePurchase,
        { subscription: "sub_test_unknown_price" }
    ));
    assert.equal(missingSub.status, 200);
    assert.equal(unknownPrice.status, 200);

    const missingAfter = await getQuery("SELECT status, stripeSubscriptionId FROM purchases WHERE id = ?", [
        missingSubPurchase.id
    ]);
    const unknownAfter = await getQuery("SELECT status, stripePriceId FROM purchases WHERE id = ?", [
        unknownPricePurchase.id
    ]);
    assert.equal(missingAfter.status, "checkout_pending");
    assert.equal(missingAfter.stripeSubscriptionId, null);
    assert.equal(unknownAfter.status, "checkout_pending");
    assert.equal(unknownAfter.stripePriceId, null);

    await assertCoreBusinessInvariants(app.queries);
});

test("out-of-order invoices and impossible local state do not corrupt checkout inventory", async t => {
    let checkoutNumber = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                checkoutNumber += 1;
                return {
                    id: `cs_test_impossible_${checkoutNumber}`,
                    url: `https://checkout.stripe.test/impossible/${checkoutNumber}`
                };
            },
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: `cus_${id}`,
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_000,
                            price: { id: "price_test_paper_2gb" }
                        }
                    ]
                }
            })
        }
    });
    const { getQuery, runQuery } = app.queries;

    await createCheckout(app);
    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_impossible_1"
    ]);

    const invoicePaid = await postWebhook(app, {
        id: "evt_test_invoice_before_checkout",
        type: "invoice.paid",
        data: {
            object: {
                subscription: "sub_not_attached_yet",
                customer: "cus_not_attached_yet",
                lines: { data: [{ price: { id: "price_test_paper_2gb" } }] }
            }
        }
    });
    assert.equal(invoicePaid.status, 200);

    await runQuery("UPDATE purchases SET status = ? WHERE id = ?", ["expired", purchase.id]);
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["available", purchase.serverId]);

    const impossibleCompletion = await postWebhook(app, completedEvent(
        "cs_test_impossible_1",
        purchase,
        { subscription: "sub_test_after_expired" }
    ));
    assert.equal(impossibleCompletion.status, 200);

    const after = await getQuery(
        "SELECT status, stripeSubscriptionId, email FROM purchases WHERE id = ?",
        [purchase.id]
    );
    const server = await getQuery("SELECT status FROM servers WHERE id = ?", [purchase.serverId]);
    assert.equal(after.status, "expired");
    assert.equal(after.stripeSubscriptionId, null);
    assert.equal(after.email, "");
    assert.equal(server.status, "available");
});

test("Stripe retrieve failure during webhook processing returns an error without partial local mutation", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_retrieve_failure",
            url: "https://checkout.stripe.test/retrieve-failure"
        },
        stripe: {
            retrieveSubscription: async () => {
                throw new Error("Stripe retrieve timed out");
            }
        }
    });
    const { getQuery } = app.queries;

    await createCheckout(app);
    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_retrieve_failure"
    ]);
    const response = await postWebhook(app, completedEvent(
        "cs_test_retrieve_failure",
        purchase,
        { subscription: "sub_test_retrieve_failure" }
    ));
    assert.equal(response.status, 500);

    const after = await getQuery("SELECT status, stripeSubscriptionId, email FROM purchases WHERE id = ?", [
        purchase.id
    ]);
    const server = await getQuery("SELECT status FROM servers WHERE id = ?", [purchase.serverId]);
    assert.equal(after.status, "checkout_pending");
    assert.equal(after.stripeSubscriptionId, null);
    assert.equal(after.email, "");
    assert.equal(server.status, "held");

    await assertCoreBusinessInvariants(app.queries);
});
