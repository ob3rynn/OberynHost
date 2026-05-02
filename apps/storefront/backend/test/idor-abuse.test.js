const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    adminLogin,
    assertCoreBusinessInvariants,
    assertSetupPurchaseUnchanged,
    browserCookie,
    completeSetup,
    seedCheckoutPendingPurchase,
    seedPaidSetupPurchase,
    seedPendingActivationPurchase,
    setupCookie,
    setupStatus,
    tokenFor
} = require("./helpers/abuseFixtures");

test("unauthenticated admin purchase-id guesses cannot mutate purchases", async t => {
    const app = await createTestApp(t);
    await seedPendingActivationPurchase(app, {
        purchaseId: 1,
        serverId: 1
    });

    const guessedMutations = [
        app.request("/api/admin/purchases/1/verify-routing", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: app.baseUrl
            },
            body: JSON.stringify({ adminNote: "guess verify" })
        }),
        app.request("/api/admin/purchases/1/requeue-fulfillment", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: app.baseUrl
            },
            body: JSON.stringify({ adminNote: "guess requeue" })
        }),
        app.request("/api/admin/purchases/1", {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                origin: app.baseUrl
            },
            body: JSON.stringify({ status: "cancelled", adminNote: "guess patch" })
        }),
        app.request("/api/complete", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: app.baseUrl
            },
            body: JSON.stringify({ purchaseId: 1, adminNote: "guess release" })
        })
    ];

    for (const response of await Promise.all(guessedMutations)) {
        assert.equal(response.status, 401);
    }

    const purchase = await app.queries.getQuery(
        "SELECT status, routingVerifiedAt, fulfillmentStatus FROM purchases WHERE id = ?",
        [1]
    );
    const audit = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE purchaseId = ?",
        [1]
    );
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.routingVerifiedAt, null);
    assert.equal(purchase.fulfillmentStatus, "pending_activation");
    assert.equal(audit.count, 0);

    await assertCoreBusinessInvariants(app.queries);
});

test("customer setup token cannot be used to mutate another purchase through body IDs or tokens", async t => {
    const app = await createTestApp(t);
    const owner = await seedPaidSetupPurchase(app, {
        serverId: 2,
        setupToken: tokenFor("setup_token_idor_owner", 2),
        stripeCustomerId: "cus_idor_owner"
    });
    const victim = await seedPaidSetupPurchase(app, {
        serverId: 3,
        setupToken: tokenFor("setup_token_idor_victim", 3),
        stripeCustomerId: "cus_idor_victim"
    });

    const status = await setupStatus(app, owner.setupToken, {
        body: {
            purchaseId: victim.purchase.id,
            setupToken: victim.setupToken,
            sessionId: victim.purchase.stripeSessionId
        }
    });
    assert.equal(status.status, 200);

    const complete = await completeSetup(app, owner.setupToken, {
        purchaseId: victim.purchase.id,
        setupToken: victim.setupToken,
        serverName: "Owner Only",
        pelicanUsername: "owner_only"
    });
    assert.equal(complete.status, 200);

    const ownerAfter = await app.queries.getQuery(
        "SELECT serverName, pelicanUsername, fulfillmentStatus FROM purchases WHERE id = ?",
        [owner.purchase.id]
    );
    assert.equal(ownerAfter.serverName, "Owner Only");
    assert.equal(ownerAfter.pelicanUsername, "owner_only");
    assert.equal(ownerAfter.fulfillmentStatus, "queued");

    await assertSetupPurchaseUnchanged(app, victim.purchase.id);
    await assertCoreBusinessInvariants(app.queries);
});

test("billing portal creation ignores attacker-supplied purchase and customer IDs", async t => {
    const app = await createTestApp(t, {
        stripeBillingPortalConfigurationId: "bpc_test_idor"
    });
    const owner = await seedPaidSetupPurchase(app, {
        serverId: 4,
        setupToken: tokenFor("setup_token_portal_owner", 4),
        stripeCustomerId: "cus_portal_owner"
    });
    const victim = await seedPaidSetupPurchase(app, {
        serverId: 5,
        setupToken: tokenFor("setup_token_portal_victim", 5),
        stripeCustomerId: "cus_portal_victim"
    });

    const portal = await app.request("/api/create-billing-portal-session", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie(owner.setupToken)
        },
        body: JSON.stringify({
            purchaseId: victim.purchase.id,
            stripeCustomerId: "cus_portal_victim"
        })
    });
    assert.equal(portal.status, 200);
    assert.equal(app.stripeState.lastCreatedPortalSessionParams.customer, "cus_portal_owner");

    await assertCoreBusinessInvariants(app.queries);
});

test("setup-status session recovery does not let mismatched metadata clone another purchase", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSession: async id => ({
                id,
                status: "complete",
                payment_status: "paid",
                customer: "cus_recovery_owner",
                customer_details: { email: "owner@example.com" },
                subscription: "sub_recovery_owner",
                metadata: {
                    purchaseId: "999999",
                    serverId: "999999",
                    planType: "paper-2gb",
                    productCode: "minecraft-paper-2gb"
                }
            }),
            retrieveSubscription: async id => ({
                id,
                status: "active",
                customer: "cus_recovery_owner",
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
    const owner = await seedPaidSetupPurchase(app, {
        serverId: 6,
        setupToken: tokenFor("setup_token_recovery_owner", 6),
        stripeSessionId: "cs_test_recovery_owner",
        stripeSubscriptionId: "sub_recovery_owner"
    });

    const recovery = await app.request("/api/setup-status", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ sessionId: "cs_test_recovery_owner" })
    });
    assert.equal(recovery.status, 200);
    assert.equal(app.parseSetCookie(recovery), setupCookie(owner.setupToken));

    const purchaseCount = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM purchases"
    );
    assert.equal(purchaseCount.count, 1);

    await assertCoreBusinessInvariants(app.queries);
});

test("checkout resume is scoped to the browser session cookie and cannot see another browser checkout", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSession: async id => ({
                id,
                status: "open",
                payment_status: "unpaid",
                url: `https://checkout.stripe.test/${id}`,
                metadata: {}
            })
        }
    });
    const first = await seedCheckoutPendingPurchase(app, {
        serverId: 7,
        setupToken: tokenFor("setup_token_resume_first", 7),
        browserSessionId: tokenFor("browser_session_resume_first", 7),
        stripeSessionId: "cs_test_resume_first"
    });
    const second = await seedCheckoutPendingPurchase(app, {
        serverId: 8,
        setupToken: tokenFor("setup_token_resume_second", 8),
        browserSessionId: tokenFor("browser_session_resume_second", 8),
        stripeSessionId: "cs_test_resume_second"
    });

    const firstResume = await app.request("/api/resume-checkout", {
        headers: {
            cookie: browserCookie(first.browserSessionId)
        },
        userAgent: "ResumeFirst/1.0"
    });
    assert.equal(firstResume.status, 200);
    assert.equal((await firstResume.json()).url, "https://checkout.stripe.test/cs_test_resume_first");

    const secondResume = await app.request("/api/resume-checkout", {
        headers: {
            cookie: browserCookie(second.browserSessionId)
        },
        userAgent: "ResumeSecond/1.0"
    });
    assert.equal(secondResume.status, 200);
    assert.equal((await secondResume.json()).url, "https://checkout.stripe.test/cs_test_resume_second");

    await assertCoreBusinessInvariants(app.queries);
});
