const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const {
    seedPaidSetupPurchase,
    seedPendingActivationPurchase,
    setupCookie,
    tokenFor
} = require("./helpers/abuseFixtures");

async function postJson(app, path, body = {}, options = {}) {
    return app.request(path, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.headers || {})
        },
        body: JSON.stringify(body),
        userAgent: options.userAgent || "SupportFramework/1.0"
    });
}

async function patchJson(app, path, body = {}, options = {}) {
    return app.request(path, {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            ...(options.cookie ? { cookie: options.cookie } : {})
        },
        body: JSON.stringify(body),
        userAgent: options.userAgent || "SupportFramework/1.0"
    });
}

async function adminLogin(app) {
    const response = await postJson(app, "/api/admin/login", {
        key: "test-admin-key"
    });

    assert.equal(response.status, 200);
    return app.parseSetCookie(response);
}

test("support hub serves and anonymous support context cannot create tickets", async t => {
    const app = await createTestApp(t);

    const supportPage = await app.request("/support");
    assert.equal(supportPage.status, 200);
    assert.match(await supportPage.text(), /Support for your server/i);

    const context = await postJson(app, "/api/support/context");
    assert.equal(context.status, 200);
    const contextPayload = await context.json();
    assert.equal(contextPayload.verified, false);

    const ticket = await postJson(app, "/api/support/tickets", {
        email: "anonymous@example.com",
        category: "service_not_ready",
        subject: "help",
        message: "I need help"
    });
    assert.equal(ticket.status, 401);

    const ticketCount = await app.queries.getQuery("SELECT COUNT(*) AS count FROM supportTickets");
    assert.equal(ticketCount.count, 0);
});

test("verified low-risk support ticket stores context, auto-guidance event, and acknowledgment email", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_low_risk", 1),
        email: "support-low@example.com",
        serverName: "Low Risk",
        setupStatus: "setup_submitted",
        fulfillmentStatus: "queued",
        serviceStatus: "inactive"
    });

    const response = await postJson(app, "/api/support/tickets", {
        email: "support-low@example.com",
        category: "customer_plugin_or_config",
        subject: "Plugin help",
        message: "<script>alert('x')</script> Can you configure plugins?",
        serviceReference: "Low Risk"
    }, {
        cookie: setupCookie(seeded.setupToken)
    });

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.match(payload.ticket.publicRef, /^OH-[A-Z0-9]{6}$/);
    assert.equal(payload.ticket.status, "waiting_on_customer");
    assert.equal(payload.ticket.scopeClassification, "customer_responsibility");
    assert.equal(payload.ticket.humanRequired, false);
    assert.match(payload.guidance, /self-managed/);

    const ticket = await app.queries.getQuery("SELECT * FROM supportTickets WHERE publicRef = ?", [
        payload.ticket.publicRef
    ]);
    assert.equal(ticket.purchaseId, seeded.purchase.id);
    assert.equal(ticket.message, "<script>alert('x')</script> Can you configure plugins?");
    assert.equal(ticket.humanRequired, 0);
    assert.notEqual(ticket.publicRef, String(seeded.purchase.id));
    assert.equal(ticket.publicRef.includes("support-low"), false);

    const events = await app.queries.allQuery(
        "SELECT eventType, actorType, body FROM supportTicketEvents WHERE ticketId = ? ORDER BY id",
        [ticket.id]
    );
    assert.deepEqual(events.map(event => event.eventType), ["created", "auto_guidance_sent"]);
    assert.equal(events[1].actorType, "system");

    const snapshot = await app.queries.getQuery(
        "SELECT snapshotJson FROM supportTicketSnapshots WHERE ticketId = ?",
        [ticket.id]
    );
    const snapshotPayload = JSON.parse(snapshot.snapshotJson);
    assert.equal(snapshotPayload.purchase.id, seeded.purchase.id);
    assert.equal(snapshotPayload.purchase.stripeCustomerPresent, true);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotPayload.purchase, "setupToken"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotPayload.purchase, "pelicanPasswordCiphertext"), false);

    const email = await app.queries.getQuery(
        "SELECT kind, recipientEmail, bodyText FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [seeded.purchase.id, "support_ticket_received"]
    );
    assert.equal(email.recipientEmail, "support-low@example.com");
    assert.match(email.bodyText, /self-managed/);
});

test("support tickets reject mismatched verified purchase email and unknown categories", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_mismatch", 1),
        email: "owner@example.com"
    });

    const mismatch = await postJson(app, "/api/support/tickets", {
        email: "attacker@example.com",
        category: "service_not_ready",
        subject: "wrong email",
        message: "please help"
    }, {
        cookie: setupCookie(seeded.setupToken)
    });
    assert.equal(mismatch.status, 403);

    const unknown = await postJson(app, "/api/support/tickets", {
        email: "owner@example.com",
        category: "not_real",
        subject: "bad category",
        message: "please help"
    }, {
        cookie: setupCookie(seeded.setupToken)
    });
    assert.equal(unknown.status, 400);
});

test("support ticket creation is rate limited by verified session", async t => {
    const app = await createTestApp(t, {
        supportEnv: {
            SUPPORT_TICKET_RATE_LIMIT_PER_MINUTE: "2"
        }
    });
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_rate", 1),
        email: "support-rate@example.com"
    });
    const responses = [];

    for (let index = 0; index < 3; index += 1) {
        responses.push(await postJson(app, "/api/support/tickets", {
            email: "support-rate@example.com",
            category: "service_not_ready",
            subject: `Question ${index}`,
            message: "Is the service ready?"
        }, {
            cookie: setupCookie(seeded.setupToken),
            userAgent: "SupportRate/1.0"
        }));
    }

    assert.deepEqual(responses.map(response => response.status), [201, 201, 429]);

    const ticketCount = await app.queries.getQuery("SELECT COUNT(*) AS count FROM supportTickets");
    assert.equal(ticketCount.count, 2);
});

test("human-required support category defaults to needs_admin without auto-guidance", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_security", 1),
        email: "security@example.com"
    });

    const response = await postJson(app, "/api/support/tickets", {
        email: "security@example.com",
        category: "account_security",
        subject: "Account concern",
        message: "Someone may have access."
    }, {
        cookie: setupCookie(seeded.setupToken)
    });

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.ticket.status, "needs_admin");
    assert.equal(payload.ticket.humanRequired, true);

    const ticket = await app.queries.getQuery("SELECT id FROM supportTickets WHERE publicRef = ?", [
        payload.ticket.publicRef
    ]);
    const events = await app.queries.allQuery(
        "SELECT eventType FROM supportTicketEvents WHERE ticketId = ? ORDER BY id",
        [ticket.id]
    );
    assert.deepEqual(events.map(event => event.eventType), ["created"]);
});

test("ready-access resend is verified, ready-only, and cooldown limited", async t => {
    const app = await createTestApp(t, {
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.test"
        }
    });
    const seeded = await seedPendingActivationPurchase(app, {
        status: "completed",
        setupToken: tokenFor("setup_token_support_ready", 1),
        email: "ready-support@example.com",
        fulfillmentStatus: "ready",
        serviceStatus: "active"
    });

    const first = await postJson(app, "/api/support/resend-ready-email", {}, {
        cookie: setupCookie(seeded.purchase.setupToken)
    });
    assert.equal(first.status, 200);

    const outbox = await app.queries.getQuery(
        "SELECT kind, recipientEmail FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [seeded.purchase.id, "ready_access_resend"]
    );
    assert.equal(outbox.recipientEmail, "ready-support@example.com");

    const second = await postJson(app, "/api/support/resend-ready-email", {}, {
        cookie: setupCookie(seeded.purchase.setupToken)
    });
    assert.equal(second.status, 429);
});

test("support billing portal uses verified purchase context and falls back when unavailable", async t => {
    const unavailableApp = await createTestApp(t);
    const unavailableSeed = await seedPaidSetupPurchase(unavailableApp, {
        setupToken: tokenFor("setup_token_support_portal_missing", 1),
        email: "portal-missing@example.com"
    });

    const unavailable = await postJson(unavailableApp, "/api/support/billing-portal-session", {}, {
        cookie: setupCookie(unavailableSeed.setupToken)
    });
    assert.equal(unavailable.status, 503);

    const app = await createTestApp(t, {
        stripeBillingPortalConfigurationId: "bpc_test_support"
    });
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_portal", 1),
        email: "portal@example.com",
        stripeCustomerId: "cus_support_portal"
    });

    const response = await postJson(app, "/api/support/billing-portal-session", {}, {
        cookie: setupCookie(seeded.setupToken)
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.url, "https://billing.stripe.test/session");
    assert.equal(app.stripeState.lastCreatedPortalSessionParams.customer, "cus_support_portal");
});

test("admin support APIs require auth and record immutable reply/status/classification events", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_admin", 1),
        email: "admin-support@example.com"
    });

    const created = await postJson(app, "/api/support/tickets", {
        email: "admin-support@example.com",
        category: "service_not_ready",
        subject: "Where is it?",
        message: "Is my server ready?"
    }, {
        cookie: setupCookie(seeded.setupToken)
    });
    assert.equal(created.status, 201);

    const unauthorized = await app.request("/api/admin/support/tickets");
    assert.equal(unauthorized.status, 401);

    const adminCookieValue = await adminLogin(app);
    const list = await app.request("/api/admin/support/tickets", {
        headers: { cookie: adminCookieValue },
        userAgent: "SupportFramework/1.0"
    });
    assert.equal(list.status, 200);
    const listPayload = await list.json();
    assert.equal(listPayload.tickets.length, 1);
    const ticket = listPayload.tickets[0];

    const classification = await patchJson(app, `/api/admin/support/tickets/${ticket.id}/classification`, {
        scopeClassification: "oberynhost_responsibility",
        priority: "elevated",
        humanRequired: true,
        escalationReason: "manual_review",
        note: "Escalate this."
    }, {
        cookie: adminCookieValue
    });
    assert.equal(classification.status, 200);

    const reply = await postJson(app, `/api/admin/support/tickets/${ticket.id}/events`, {
        eventType: "reply",
        body: "We are checking the verified service state."
    }, {
        cookie: adminCookieValue
    });
    assert.equal(reply.status, 201);

    const status = await patchJson(app, `/api/admin/support/tickets/${ticket.id}/status`, {
        status: "resolved",
        note: "Resolved after reply."
    }, {
        cookie: adminCookieValue
    });
    assert.equal(status.status, 200);

    const events = await app.queries.allQuery(
        "SELECT eventType, actorType FROM supportTicketEvents WHERE ticketId = ? ORDER BY id",
        [ticket.id]
    );
    assert.deepEqual(events.map(event => event.eventType), [
        "created",
        "auto_guidance_sent",
        "classification_changed",
        "admin_reply",
        "status_changed",
        "status_changed"
    ]);
    assert.ok(events.every(event => event.actorType));

    const outbox = await app.queries.getQuery(
        "SELECT kind, bodyText FROM emailOutbox WHERE kind = ?",
        ["support_ticket_admin_reply"]
    );
    assert.match(outbox.bodyText, /checking the verified service state/);
});

test("support assistant stubs stay disabled", async () => {
    const assistant = require("../services/supportAssistant");

    assert.deepEqual(await assistant.classifyTicketDraft({}), {
        enabled: false,
        operation: "classifyTicketDraft",
        status: "disabled",
        reason: "support_assistant_disabled"
    });
});
