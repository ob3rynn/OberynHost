const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    assertCoreBusinessInvariants,
    seedCheckoutPendingPurchase,
    seedPaidSetupPurchase,
    tokenFor
} = require("./helpers/abuseFixtures");

function webhook(app, body, options = {}) {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    return app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": options.contentType || "application/json",
            ...(options.signature === false ? {} : { "stripe-signature": options.signature || "good-signature" })
        },
        body: rawBody,
        userAgent: options.userAgent || "WebhookParserAbuse/1.0"
    });
}

function captureConsoleWarn(t) {
    const originalWarn = console.warn;
    const calls = [];

    console.warn = (...args) => {
        calls.push(args);
    };
    t.after(() => {
        console.warn = originalWarn;
    });

    return calls;
}

test("webhook parser rejects missing signatures, invalid content type, malformed JSON, and oversized bodies", async t => {
    const app = await createTestApp(t);

    const missingSignature = await webhook(app, {
        id: "evt_missing_signature",
        type: "unknown.event",
        data: { object: {} }
    }, {
        signature: false
    });
    assert.equal(missingSignature.status, 400);

    const invalidContentType = await webhook(app, "not-json", {
        contentType: "text/plain"
    });
    assert.equal(invalidContentType.status, 400);

    const malformed = await webhook(app, "{\"type\":", {
        signature: "good-signature"
    });
    assert.equal(malformed.status, 400);

    const hugeBody = await webhook(app, {
        id: "evt_huge_body",
        type: "unknown.event",
        data: {
            object: {
                padding: "x".repeat(270 * 1024)
            }
        }
    });
    assert.equal(hugeBody.status, 413);

    const purchases = await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases");
    assert.equal(purchases.count, 0);
    await assertCoreBusinessInvariants(app.queries);
});

test("unknown webhook event types are accepted without mutating local state", async t => {
    const app = await createTestApp(t);
    const warnings = captureConsoleWarn(t);
    await seedPaidSetupPurchase(app, {
        serverId: 1,
        setupToken: tokenFor("setup_token_unknown_webhook", 1)
    });

    const response = await webhook(app, {
        id: "evt_unknown_type",
        type: "customer.source.expiring",
        data: {
            object: {
                id: "card_ignored"
            }
        }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    assert.deepEqual(warnings, []);

    const purchase = await app.queries.getQuery(
        "SELECT status, stripeSubscriptionStatus, fulfillmentStatus FROM purchases WHERE id = ?",
        [1]
    );
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.stripeSubscriptionStatus, "active");
    assert.equal(purchase.fulfillmentStatus, "not_started");
    await assertCoreBusinessInvariants(app.queries);
});

test("known webhook events with impossible object shapes do not corrupt checkout state", async t => {
    const app = await createTestApp(t);
    const warnings = captureConsoleWarn(t);
    await seedCheckoutPendingPurchase(app, {
        serverId: 2,
        setupToken: tokenFor("setup_token_shape_checkout", 2),
        stripeSessionId: "cs_test_shape_checkout"
    });

    const nullSession = await webhook(app, {
        id: "evt_null_session",
        type: "checkout.session.completed",
        data: {
            object: null
        }
    });
    assert.equal(nullSession.status, 200);

    const arraySession = await webhook(app, {
        id: "evt_array_session",
        type: "checkout.session.completed",
        data: {
            object: []
        }
    });
    assert.equal(arraySession.status, 200);
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0][0], "Stripe webhook event ignored because data.object was not usable.");
    assert.deepEqual(warnings[0][1], {
        eventId: "evt_null_session",
        eventType: "checkout.session.completed"
    });
    assert.deepEqual(warnings[1][1], {
        eventId: "evt_array_session",
        eventType: "checkout.session.completed"
    });

    const purchase = await app.queries.getQuery(
        "SELECT status, stripeSubscriptionId, email FROM purchases WHERE stripeSessionId = ?",
        ["cs_test_shape_checkout"]
    );
    assert.equal(purchase.status, "checkout_pending");
    assert.equal(purchase.stripeSubscriptionId, null);
    assert.equal(purchase.email || "", "");
    await assertCoreBusinessInvariants(app.queries);
});

test("unexpected nested Stripe object types are ignored without subscription corruption", async t => {
    const app = await createTestApp(t);
    await seedPaidSetupPurchase(app, {
        serverId: 3,
        setupToken: tokenFor("setup_token_nested_webhook", 3),
        stripeSubscriptionId: "sub_nested_webhook",
        stripeSubscriptionStatus: "active"
    });

    const response = await webhook(app, {
        id: "evt_nested_invoice",
        type: "invoice.paid",
        data: {
            object: {
                subscription: { id: "sub_nested_webhook" },
                customer: { id: "cus_nested_webhook" },
                lines: {
                    data: [
                        {
                            price: {
                                id: ["not", "a", "price"]
                            }
                        }
                    ]
                }
            }
        }
    });
    assert.equal(response.status, 200);

    const purchase = await app.queries.getQuery(
        "SELECT status, stripeSubscriptionStatus, stripePriceId FROM purchases WHERE stripeSubscriptionId = ?",
        ["sub_nested_webhook"]
    );
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.stripeSubscriptionStatus, "active");
    assert.equal(purchase.stripePriceId, "price_test_paper_2gb");
    await assertCoreBusinessInvariants(app.queries);
});

test("equivalent JSON replay with different whitespace remains idempotent", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSubscription: async id => ({
                id,
                status: "active",
                customer: "cus_encoded_replay",
                cancel_at_period_end: false,
                items: {
                    data: [
                        {
                            current_period_end: Math.floor(Date.now() / 1000) + 86400,
                            price: { id: "price_test_paper_2gb" }
                        }
                    ]
                }
            })
        }
    });
    await seedCheckoutPendingPurchase(app, {
        serverId: 4,
        setupToken: tokenFor("setup_token_encoded_replay", 4),
        stripeSessionId: "cs_test_encoded_replay"
    });
    const event = {
        id: "evt_encoded_replay",
        type: "checkout.session.completed",
        data: {
            object: {
                id: "cs_test_encoded_replay",
                customer: "cus_encoded_replay",
                customer_details: { email: "encoded@example.com" },
                subscription: "sub_encoded_replay",
                metadata: {
                    purchaseId: "1",
                    serverId: "4",
                    planType: "paper-2gb",
                    productCode: "minecraft-paper-2gb"
                }
            }
        }
    };

    const compact = await webhook(app, JSON.stringify(event));
    assert.equal(compact.status, 200);

    const pretty = await webhook(app, JSON.stringify(event, null, 2));
    assert.equal(pretty.status, 200);

    const purchase = await app.queries.getQuery(
        "SELECT status, stripeSubscriptionId, email FROM purchases WHERE stripeSessionId = ?",
        ["cs_test_encoded_replay"]
    );
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.stripeSubscriptionId, "sub_encoded_replay");
    assert.equal(purchase.email, "encoded@example.com");

    const purchaseCount = await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases");
    assert.equal(purchaseCount.count, 1);
    await assertCoreBusinessInvariants(app.queries);
});
