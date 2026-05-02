const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    adminCookie,
    adminLogin,
    assertCoreBusinessInvariants,
    assertSetupPurchaseUnchanged,
    completeSetup,
    seedPaidSetupPurchase,
    seedPendingActivationPurchase,
    setupCookie,
    setupStatus,
    tokenFor
} = require("./helpers/abuseFixtures");

test("setup and billing sessions reject tampered, malformed, and expired tokens without mutation", async t => {
    const app = await createTestApp(t, {
        stripeBillingPortalConfigurationId: "bpc_test_abuse"
    });
    const active = await seedPaidSetupPurchase(app, {
        serverId: 1,
        stripeCustomerId: "cus_active_session"
    });
    const expired = await seedPaidSetupPurchase(app, {
        serverId: 2,
        setupToken: tokenFor("setup_token_expired_abuse", 2),
        setupTokenExpiresAt: Date.now() - 1,
        stripeCustomerId: "cus_expired_session"
    });

    const malformedStatus = await setupStatus(app, "not a token");
    assert.equal(malformedStatus.status, 400);

    const tamperedToken = `${active.setupToken}x`;
    const tamperedStatus = await setupStatus(app, tamperedToken);
    assert.equal(tamperedStatus.status, 400);

    const tamperedComplete = await completeSetup(app, tamperedToken);
    assert.equal(tamperedComplete.status, 400);

    const expiredStatus = await setupStatus(app, expired.setupToken);
    assert.equal(expiredStatus.status, 410);

    const expiredComplete = await completeSetup(app, expired.setupToken);
    assert.equal(expiredComplete.status, 400);

    const tamperedPortal = await app.request("/api/create-billing-portal-session", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie(tamperedToken)
        },
        body: JSON.stringify({})
    });
    assert.equal(tamperedPortal.status, 401);

    const expiredPortal = await app.request("/api/create-billing-portal-session", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie(expired.setupToken)
        },
        body: JSON.stringify({})
    });
    assert.equal(expiredPortal.status, 410);

    await assertSetupPurchaseUnchanged(app, active.purchase.id);
    await assertSetupPurchaseUnchanged(app, expired.purchase.id);
    await assertCoreBusinessInvariants(app.queries);
});

test("cookie setup token wins over body token and scopes billing to the cookie owner", async t => {
    const app = await createTestApp(t, {
        stripeBillingPortalConfigurationId: "bpc_test_abuse"
    });
    const cookieOwner = await seedPaidSetupPurchase(app, {
        serverId: 3,
        setupToken: tokenFor("setup_token_cookie_owner", 3),
        stripeCustomerId: "cus_cookie_owner"
    });
    const bodyOwner = await seedPaidSetupPurchase(app, {
        serverId: 4,
        setupToken: tokenFor("setup_token_body_owner", 4),
        stripeCustomerId: "cus_body_owner"
    });

    const status = await setupStatus(app, cookieOwner.setupToken, {
        body: { setupToken: bodyOwner.setupToken }
    });
    assert.equal(status.status, 200);
    const statusPayload = await status.json();
    assert.equal(statusPayload.status, "paid");

    const complete = await completeSetup(
        app,
        cookieOwner.setupToken,
        {
            setupToken: bodyOwner.setupToken,
            serverName: "Cookie Owner",
            pelicanUsername: "cookie_owner"
        }
    );
    assert.equal(complete.status, 200);

    const cookiePurchase = await app.queries.getQuery(
        "SELECT serverName, pelicanUsername, fulfillmentStatus FROM purchases WHERE id = ?",
        [cookieOwner.purchase.id]
    );
    const bodyPurchase = await app.queries.getQuery(
        "SELECT serverName, pelicanUsername, fulfillmentStatus FROM purchases WHERE id = ?",
        [bodyOwner.purchase.id]
    );
    assert.equal(cookiePurchase.serverName, "Cookie Owner");
    assert.equal(cookiePurchase.pelicanUsername, "cookie_owner");
    assert.equal(cookiePurchase.fulfillmentStatus, "queued");
    assert.equal(bodyPurchase.serverName || "", "");
    assert.equal(bodyPurchase.pelicanUsername, null);
    assert.equal(bodyPurchase.fulfillmentStatus, "not_started");

    const portal = await app.request("/api/create-billing-portal-session", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie(cookieOwner.setupToken)
        },
        body: JSON.stringify({
            setupToken: bodyOwner.setupToken,
            purchaseId: bodyOwner.purchase.id,
            stripeCustomerId: "cus_body_owner"
        })
    });
    assert.equal(portal.status, 200);
    assert.equal(app.stripeState.lastCreatedPortalSessionParams.customer, "cus_cookie_owner");

    await assertCoreBusinessInvariants(app.queries);
});

test("admin sessions resist user-agent mismatch, logout reuse, and attacker-supplied fixation cookies", async t => {
    const app = await createTestApp(t);
    await seedPendingActivationPurchase(app);

    const firstLogin = await adminLogin(app, {
        userAgent: "LegitAdmin/1.0"
    });

    const wrongAgent = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: firstLogin.cookie
        },
        body: JSON.stringify({ adminNote: "wrong user agent" }),
        userAgent: "DifferentAdmin/1.0"
    });
    assert.equal(wrongAgent.status, 401);

    const originalAgentAfterMismatch = await app.request("/api/purchases", {
        headers: {
            cookie: firstLogin.cookie
        },
        userAgent: "LegitAdmin/1.0"
    });
    assert.equal(originalAgentAfterMismatch.status, 401);

    const secondLogin = await adminLogin(app, {
        userAgent: "LegitAdmin/2.0"
    });
    const logout = await app.request("/api/admin/logout", {
        method: "POST",
        headers: {
            origin: app.baseUrl,
            cookie: secondLogin.cookie
        },
        userAgent: "LegitAdmin/2.0"
    });
    assert.equal(logout.status, 200);

    const afterLogout = await app.request("/api/purchases", {
        headers: {
            cookie: secondLogin.cookie
        },
        userAgent: "LegitAdmin/2.0"
    });
    assert.equal(afterLogout.status, 401);

    const fixedCookie = adminCookie(tokenFor("attacker_fixed_admin_session", 1));
    const fixedLogin = await adminLogin(app, {
        cookie: fixedCookie,
        userAgent: "FixationVictim/1.0"
    });
    assert.notEqual(fixedLogin.cookie, fixedCookie);

    const attackerCookie = await app.request("/api/purchases", {
        headers: {
            cookie: fixedCookie
        },
        userAgent: "FixationVictim/1.0"
    });
    assert.equal(attackerCookie.status, 401);

    const realCookie = await app.request("/api/purchases", {
        headers: {
            cookie: fixedLogin.cookie
        },
        userAgent: "FixationVictim/1.0"
    });
    assert.equal(realCookie.status, 200);

    await assertCoreBusinessInvariants(app.queries);
});

test("state-changing API requests reject missing origin even with valid cookies", async t => {
    const app = await createTestApp(t);
    const setup = await seedPaidSetupPurchase(app, {
        serverId: 5,
        setupToken: tokenFor("setup_token_missing_origin", 5)
    });
    await seedPendingActivationPurchase(app, {
        purchaseId: 2,
        serverId: 6,
        hostnameReservationKey: "missing-origin-ready"
    });
    const login = await adminLogin(app, {
        userAgent: "MissingOriginAdmin/1.0"
    });

    const setupNoOrigin = await completeSetup(app, setup.setupToken, {}, {
        noOrigin: true
    });
    assert.equal(setupNoOrigin.status, 403);

    const adminNoOrigin = await app.request("/api/admin/purchases/2/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: login.cookie
        },
        body: JSON.stringify({ adminNote: "no origin" }),
        userAgent: "MissingOriginAdmin/1.0"
    });
    assert.equal(adminNoOrigin.status, 403);

    await assertSetupPurchaseUnchanged(app, setup.purchase.id);
    await assertCoreBusinessInvariants(app.queries);
});

test("state-changing API requests allow same-origin referer and fail closed on bad origin headers", async t => {
    const app = await createTestApp(t);
    const setup = await seedPaidSetupPurchase(app, {
        serverId: 7,
        setupToken: tokenFor("setup_token_referer_allowed", 7)
    });
    await seedPendingActivationPurchase(app, {
        purchaseId: 2,
        serverId: 8,
        hostnameReservationKey: "referer-ready"
    });
    const login = await adminLogin(app, {
        userAgent: "RefererAdmin/1.0"
    });

    const setupWithReferer = await completeSetup(app, setup.setupToken, {
        serverName: "Referer Allowed",
        pelicanUsername: "referer_allowed"
    }, {
        noOrigin: true,
        headers: {
            referer: `${app.baseUrl}/success`
        }
    });
    assert.equal(setupWithReferer.status, 200);

    const adminWithReferer = await app.request("/api/admin/purchases/2/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: login.cookie,
            referer: `${app.baseUrl}/admin`
        },
        body: JSON.stringify({ adminNote: "same-origin referer" }),
        userAgent: "RefererAdmin/1.0"
    });
    assert.equal(adminWithReferer.status, 200);

    const badReferers = [
        "not-a-url",
        "https://evil.example/%zz",
        "null"
    ];

    for (const [index, referer] of badReferers.entries()) {
        const response = await app.request("/api/admin/purchases/2/verify-routing", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                cookie: login.cookie,
                referer
            },
            body: JSON.stringify({ adminNote: `bad referer ${index}` }),
            userAgent: "RefererAdmin/1.0"
        });
        assert.equal(response.status, 403, `expected referer ${referer} to fail closed`);
    }

    const nullOrigin = await app.request("/api/admin/purchases/2/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: login.cookie,
            origin: "null"
        },
        body: JSON.stringify({ adminNote: "null origin" }),
        userAgent: "RefererAdmin/1.0"
    });
    assert.equal(nullOrigin.status, 403);

    await assertCoreBusinessInvariants(app.queries);
});

test("Stripe webhooks bypass browser-origin guard and rely on signature verification", async t => {
    const app = await createTestApp(t);

    const signedNoOrigin = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify({
            id: "evt_no_origin_webhook",
            type: "customer.source.expiring",
            data: { object: { id: "card_ignored" } }
        })
    });
    assert.equal(signedNoOrigin.status, 200);

    const badSignature = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "bad-signature"
        },
        body: JSON.stringify({
            id: "evt_bad_signature_no_origin",
            type: "customer.source.expiring",
            data: { object: { id: "card_ignored" } }
        })
    });
    assert.equal(badSignature.status, 400);

    await assertCoreBusinessInvariants(app.queries);
});
