const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    adminLogin,
    assertCoreBusinessInvariants,
    assertSetupPurchaseUnchanged,
    completeSetup,
    seedPaidSetupPurchase,
    seedPendingActivationPurchase,
    setupCookie,
    tokenFor
} = require("./helpers/abuseFixtures");

test("hostile setup field payloads are rejected without provisioning work or secret storage", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        serverId: 1,
        setupToken: tokenFor("setup_token_payload_fields", 1)
    });
    const badUsernames = [
        "<script>alert(1)</script>",
        "line\r\nBcc: victim@example.com",
        "Robert'); DROP TABLE purchases;--",
        "../../admin",
        "аdmin"
    ];
    const badVersions = [
        "<script>alert(1)</script>",
        "1.21.11\r\nX-Header: yes",
        "Robert'); DROP TABLE purchases;--",
        "../../server.jar",
        "а.21.11"
    ];

    for (const [index, pelicanUsername] of badUsernames.entries()) {
        const response = await completeSetup(app, seeded.setupToken, {
            serverName: "Payload Username",
            pelicanUsername
        }, {
            userAgent: `PayloadUsername/${index}`
        });
        assert.equal(response.status, 400, `expected username payload ${pelicanUsername} to be rejected`);
    }

    for (const [index, minecraftVersion] of badVersions.entries()) {
        const response = await completeSetup(app, seeded.setupToken, {
            serverName: "Payload Version",
            minecraftVersion,
            pelicanUsername: `payload_version_${index}`
        }, {
            userAgent: `PayloadVersion/${index}`
        });
        assert.equal(response.status, 400, `expected version payload ${minecraftVersion} to be rejected`);
    }

    await assertSetupPurchaseUnchanged(app, seeded.purchase.id);
    await assertCoreBusinessInvariants(app.queries);
});

test("accepted setup never writes raw hostile password text into queue payloads", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        serverId: 2,
        setupToken: tokenFor("setup_token_payload_password", 2)
    });
    const hostilePassword = "<script>alert(1)</script>\r\nBcc: victim@example.com";

    const response = await completeSetup(app, seeded.setupToken, {
        serverName: "Password Payload",
        pelicanUsername: "password_payload",
        pelicanPassword: hostilePassword
    });
    assert.equal(response.status, 200);

    const purchase = await app.queries.getQuery(
        `SELECT pelicanPasswordCiphertext, pelicanPasswordIv, pelicanPasswordAuthTag,
                pelicanPasswordStoredAt
         FROM purchases
         WHERE id = ?`,
        [seeded.purchase.id]
    );
    assert.ok(purchase.pelicanPasswordCiphertext);
    assert.ok(purchase.pelicanPasswordIv);
    assert.ok(purchase.pelicanPasswordAuthTag);
    assert.ok(purchase.pelicanPasswordStoredAt);

    const job = await app.queries.getQuery(
        "SELECT payloadJson FROM fulfillmentQueue WHERE purchaseId = ?",
        [seeded.purchase.id]
    );
    assert.ok(job);
    assert.doesNotMatch(job.payloadJson, /<script>|Bcc:|victim@example\.com/);

    await assertCoreBusinessInvariants(app.queries);
});

test("admin notes store hostile text inertly and reject overlong notes without mutation", async t => {
    const app = await createTestApp(t);
    await seedPendingActivationPurchase(app, {
        purchaseId: 1,
        serverId: 3
    });
    const login = await adminLogin(app, {
        userAgent: "PayloadAdmin/1.0"
    });
    const hostileNote = "Reviewed <script>alert(1)</script>\r\nAudit: still text";

    const verify = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: login.cookie
        },
        body: JSON.stringify({ adminNote: hostileNote }),
        userAgent: "PayloadAdmin/1.0"
    });
    assert.equal(verify.status, 200);

    const audit = await app.queries.getQuery(
        "SELECT note FROM adminAuditLog WHERE purchaseId = ? AND actionType = ?",
        [1, "verify_routing"]
    );
    assert.equal(audit.note, hostileNote);
    assert.equal(verify.headers.get("bcc"), null);
    assert.equal(verify.headers.get("audit"), null);

    const overlong = await app.request("/api/admin/purchases/1/verify-routing", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: login.cookie
        },
        body: JSON.stringify({ adminNote: "a".repeat(501) }),
        userAgent: "PayloadAdmin/1.0"
    });
    assert.equal(overlong.status, 400);

    const auditCount = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE purchaseId = ?",
        [1]
    );
    assert.equal(auditCount.count, 1);

    await assertCoreBusinessInvariants(app.queries);
});

test("admin email override rejects raw and encoded CRLF header-injection payloads", async t => {
    const app = await createTestApp(t);
    await seedPendingActivationPurchase(app, {
        purchaseId: 1,
        serverId: 4
    });
    const login = await adminLogin(app, {
        userAgent: "PayloadEmailAdmin/1.0"
    });
    const payloads = [
        "buyer@example.com\r\nBcc: victim@example.com",
        "buyer@example.com%0d%0aBcc:%20victim@example.com",
        "buyer@example.com%0D%0ABcc:%20victim@example.com"
    ];

    for (const email of payloads) {
        const response = await app.request("/api/admin/purchases/1", {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                origin: app.baseUrl,
                cookie: login.cookie
            },
            body: JSON.stringify({
                email,
                adminNote: "try header injection"
            }),
            userAgent: "PayloadEmailAdmin/1.0"
        });
        assert.equal(response.status, 400, `expected ${email} to be rejected`);
    }

    const purchase = await app.queries.getQuery(
        "SELECT email FROM purchases WHERE id = ?",
        [1]
    );
    const audit = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE purchaseId = ?",
        [1]
    );
    assert.equal(purchase.email, "ready-4@example.com");
    assert.equal(audit.count, 0);

    await assertCoreBusinessInvariants(app.queries);
});

test("email outbox builders reject unsafe recipient and sender email values", async t => {
    const app = await createTestApp(t, {
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.net"
        }
    });
    const {
        buildReadyEmailMessage,
        buildSetupReminderEmailMessage,
        buildSuspensionDeleteWarningEmailMessage,
        EMAIL_KIND
    } = require("../services/emailOutbox");
    const purchase = {
        id: 99,
        email: "buyer@example.com",
        serverName: "Safe Server",
        pelicanUsername: "safe_user",
        hostname: "safe.oberyn.net",
        stripeSessionId: "cs_test_email_safety",
        planType: "paper-2gb",
        purgeEligibleAt: Date.now() + 86_400_000
    };

    assert.equal(buildReadyEmailMessage(purchase).recipientEmail, "buyer@example.com");
    assert.throws(
        () => buildReadyEmailMessage({
            ...purchase,
            email: "buyer@example.com\r\nBcc: victim@example.com"
        }),
        /line breaks/i
    );
    assert.throws(
        () => buildSetupReminderEmailMessage({
            ...purchase,
            email: "buyer@example.com%0d%0aBcc:%20victim@example.com"
        }),
        /line breaks/i
    );
    assert.throws(
        () => buildSuspensionDeleteWarningEmailMessage({
            ...purchase,
            email: "buyer@example.com%0D%0ABcc:%20victim@example.com"
        }, EMAIL_KIND.SUSPENSION_DELETE_WARNING_72H),
        /line breaks/i
    );

    await assertCoreBusinessInvariants(app.queries);
});

test("email outbox builders reject unsafe configured sender email values", async t => {
    const app = await createTestApp(t, {
        outboundEmailFrom: "support@oberynn.com%0d%0aBcc:%20victim@example.com",
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.net"
        }
    });
    const { buildReadyEmailMessage } = require("../services/emailOutbox");

    assert.throws(
        () => buildReadyEmailMessage({
            id: 100,
            email: "buyer@example.com",
            serverName: "Unsafe Sender",
            pelicanUsername: "unsafe_sender",
            hostname: "unsafe-sender.oberyn.net"
        }),
        /line breaks/i
    );

    await assertCoreBusinessInvariants(app.queries);
});
