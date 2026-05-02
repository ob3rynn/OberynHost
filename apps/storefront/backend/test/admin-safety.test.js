const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const { assertCoreBusinessInvariants } = require("./helpers/invariants");

async function adminLogin(app) {
    const response = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ key: "test-admin-key" }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(response.status, 200);
    return app.parseSetCookie(response);
}

async function seedPendingActivation(app, overrides = {}) {
    const now = Date.now();
    const serverId = overrides.serverId || 1;
    const artifact = {
        kind: "haproxy_desired_mapping",
        version: 1,
        hostname: overrides.artifactHostname || "admin-safety.oberyn.net",
        provisioningTargetCode: "paper-launch-default",
        purchaseId: 1,
        pelicanServerIdentifier: overrides.artifactServerIdentifier || "srv_admin_safety",
        pelicanAllocationId: overrides.artifactAllocationId || "9001",
        generatedAt: now
    };

    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeSessionId, stripeCustomerId,
                stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd,
                stripeCancelAtPeriodEnd, stripePriceId, createdAt, setupToken,
                setupTokenExpiresAt, paidAt, setupStatus, fulfillmentStatus,
                hostname, hostnameReservationKey, pelicanUserId, pelicanUsername,
                pelicanServerId, pelicanServerIdentifier, pelicanAllocationId,
                desiredRoutingArtifactJson, desiredRoutingArtifactGeneratedAt, updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            serverId,
            "admin-safety@example.com",
            "Admin Safety",
            "paid",
            "cs_test_admin_safety",
            "cus_admin_safety",
            "sub_admin_safety",
            "active",
            now + 86_400_000,
            0,
            "price_test_paper_2gb",
            now,
            "setup_token_admin_safety_abcdefghijklmnopqrstuvwxyz",
            now + 60_000,
            now,
            "setup_submitted",
            "pending_activation",
            "admin-safety.oberyn.net",
            "admin-safety",
            "pelican-user-admin-safety",
            "admin_safety_customer",
            "pelican-server-admin-safety",
            "srv_admin_safety",
            "9001",
            JSON.stringify(artifact),
            now,
            now
        ]
    );
    await app.queries.runQuery(
        "UPDATE servers SET status = ?, allocatedAt = ? WHERE id = ?",
        ["allocated", now, serverId]
    );
}

test("admin mutations require a valid same-origin authenticated session", async t => {
    const app = await createTestApp(t);
    await seedPendingActivation(app);

    const missingSession = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({})
    });
    assert.equal(missingSession.status, 401);

    const adminCookie = await adminLogin(app);
    const badOrigin = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: "https://evil.example"
        },
        body: JSON.stringify({})
    });
    assert.equal(badOrigin.status, 403);

    const logout = await app.request("/api/admin/logout", {
        method: "POST",
        headers: {
            cookie: adminCookie,
            origin: app.baseUrl
        },
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(logout.status, 200);

    const expiredSession = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({}),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(expiredSession.status, 401);

    await assertCoreBusinessInvariants(app.queries);
});

test("routing verification rejects a desired artifact that does not match local Pelican linkage", async t => {
    const app = await createTestApp(t);
    await seedPendingActivation(app, {
        artifactHostname: "wrong-host.oberyn.net",
        artifactServerIdentifier: "wrong_server",
        artifactAllocationId: "wrong_allocation"
    });
    const adminCookie = await adminLogin(app);

    const response = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ adminNote: "Trying mismatched routing" }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /desired routing artifact/i);

    const purchase = await app.queries.getQuery(
        "SELECT routingVerifiedAt, status, fulfillmentStatus FROM purchases WHERE id = ?",
        [1]
    );
    assert.equal(purchase.routingVerifiedAt, null);
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.fulfillmentStatus, "pending_activation");
});

test("double-click release ready cannot queue duplicate ready email or audit actions", async t => {
    const app = await createTestApp(t, {
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.net"
        }
    });
    await seedPendingActivation(app);
    const adminCookie = await adminLogin(app);

    const verify = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ adminNote: "Routing applied" }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(verify.status, 200);

    const firstRelease = await app.request("/api/complete", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ purchaseId: 1, adminNote: "Release" }),
        userAgent: "AdminSafety/1.0"
    });
    const secondRelease = await app.request("/api/complete", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ purchaseId: 1, adminNote: "Release again" }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(firstRelease.status, 200);
    assert.equal(secondRelease.status, 400);

    const readyEmailCount = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [1, "ready_access"]
    );
    const releaseAuditCount = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE purchaseId = ? AND actionType = ?",
        [1, "release_ready"]
    );
    assert.equal(readyEmailCount.count, 1);
    assert.equal(releaseAuditCount.count, 1);

    await assertCoreBusinessInvariants(app.queries);
});

test("admin recovery actions reject invalid states and Pelican-linked setup reopen attempts", async t => {
    const app = await createTestApp(t);
    await seedPendingActivation(app);
    const adminCookie = await adminLogin(app);

    const invalidRequeue = await app.request("/api/admin/purchases/1/requeue-fulfillment", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ adminNote: "Wrong state" }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(invalidRequeue.status, 400);
    assert.match((await invalidRequeue.json()).error, /requeued/i);

    await app.queries.runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 1]);
    await app.queries.runQuery(
        "UPDATE purchases SET fulfillmentStatus = ?, setupStatus = ? WHERE id = ?",
        ["needs_admin_review", "setup_submitted", 1]
    );

    const reopenLinked = await app.request("/api/admin/purchases/1/reopen-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ adminNote: "Try reopening linked setup" }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(reopenLinked.status, 400);
    assert.match((await reopenLinked.json()).error, /Pelican linkage already exists/i);
});

test("manual override cannot release active subscription capacity from a completed purchase", async t => {
    const app = await createTestApp(t);
    const now = Date.now();
    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeSessionId,
                stripeCustomerId, stripeSubscriptionId, stripeSubscriptionStatus,
                stripeCurrentPeriodEnd, stripeCancelAtPeriodEnd, stripePriceId,
                createdAt, setupToken, setupTokenExpiresAt, paidAt, completedAt,
                setupStatus, fulfillmentStatus, serviceStatus
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            2,
            "active-override@example.com",
            "Active Override",
            "completed",
            "cs_test_active_override",
            "cus_active_override",
            "sub_active_override",
            "active",
            now + 86_400_000,
            0,
            "price_test_paper_2gb",
            now,
            "setup_token_active_override_abcdefghijklmnopqrstuvwxyz",
            now + 60_000,
            now,
            now,
            "setup_submitted",
            "ready",
            "active"
        ]
    );
    await app.queries.runQuery(
        "UPDATE servers SET status = ?, allocatedAt = ? WHERE id = ?",
        ["allocated", now, 2]
    );
    const adminCookie = await adminLogin(app);

    const response = await app.request("/api/admin/purchases/1", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverStatus: "available",
            adminNote: "Do not allow active capacity release"
        }),
        userAgent: "AdminSafety/1.0"
    });
    assert.equal(response.status, 400);

    const server = await app.queries.getQuery("SELECT status FROM servers WHERE id = ?", [2]);
    assert.equal(server.status, "allocated");
});
