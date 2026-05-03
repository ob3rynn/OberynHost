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

function extractAccessTokenFromBody(bodyText) {
    const match = String(bodyText || "").match(/\/support#accessToken=([A-Za-z0-9_-]+)/);
    return match ? decodeURIComponent(match[1]) : "";
}

test("support hub serves and anonymous support context cannot create tickets", async t => {
    const app = await createTestApp(t);

    const supportPage = await app.request("/support");
    assert.equal(supportPage.status, 200);
    const supportHtml = await supportPage.text();
    assert.match(supportHtml, /Support for your server/i);
    assert.match(supportHtml, /history\.replaceState/);

    const accessPage = await app.request(`/support/access/${encodeURIComponent(tokenFor("path_access_token", 1))}`);
    assert.equal(accessPage.status, 200);
    assert.match(await accessPage.text(), /getAccessTokenFromLocation/);

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

test("support context verifies setup cookie, setup body token, and private service access token", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_context", 1),
        email: "context-owner@example.com",
        serverName: "Context Server"
    });

    const cookieContext = await postJson(app, "/api/support/context", {}, {
        cookie: setupCookie(seeded.setupToken)
    });
    assert.equal(cookieContext.status, 200);
    assert.equal((await cookieContext.json()).verified, true);

    const bodyContext = await postJson(app, "/api/support/context", {
        setupToken: seeded.setupToken
    });
    assert.equal(bodyContext.status, 200);
    assert.equal((await bodyContext.json()).verified, true);

    const { createServiceAccessLinkForPurchase } = require("../services/serviceAccessLinks");
    const created = await createServiceAccessLinkForPurchase(seeded.purchase);
    const accessContext = await postJson(app, "/api/support/context", {
        accessToken: created.rawToken
    });
    assert.equal(accessContext.status, 200);
    const accessPayload = await accessContext.json();
    assert.equal(accessPayload.verified, true);
    assert.equal(accessPayload.purchaseId, seeded.purchase.id);

    const stored = await app.queries.getQuery("SELECT tokenHash, tokenPrefix FROM serviceAccessLinks WHERE purchaseId = ?", [
        seeded.purchase.id
    ]);
    assert.ok(stored.tokenHash);
    assert.equal(stored.tokenHash.includes(created.rawToken), false);
    assert.equal(stored.tokenPrefix, created.rawToken.slice(0, 10));
});

test("private service access tokens fail closed when invalid, revoked, expired, or outside overlap", async t => {
    const app = await createTestApp(t);
    const now = Date.now();
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_access_fail", 1),
        email: "access-fail@example.com",
        stripeCurrentPeriodEnd: now + 30 * 86_400_000
    });
    const { createServiceAccessLinkForPurchase, revokeServiceAccessLink } = require("../services/serviceAccessLinks");

    const invalid = await postJson(app, "/api/support/context", {
        accessToken: tokenFor("not_a_service_access_token", 1)
    });
    assert.equal(invalid.status, 200);
    assert.equal((await invalid.json()).verified, false);

    const revoked = await createServiceAccessLinkForPurchase(seeded.purchase);
    await revokeServiceAccessLink(revoked.link.id);
    const revokedResponse = await postJson(app, "/api/support/context", {
        accessToken: revoked.rawToken
    });
    assert.equal(revokedResponse.status, 200);
    assert.equal((await revokedResponse.json()).verified, false);

    const expired = await createServiceAccessLinkForPurchase(seeded.purchase, {
        period: {
            start: now - 60 * 86_400_000,
            end: now - 45 * 86_400_000,
            expiresAt: now - 1000
        }
    });
    const expiredResponse = await postJson(app, "/api/support/context", {
        accessToken: expired.rawToken
    });
    assert.equal(expiredResponse.status, 200);
    assert.equal((await expiredResponse.json()).verified, false);

    const overlap = await createServiceAccessLinkForPurchase(seeded.purchase, {
        period: {
            start: now - 30 * 86_400_000,
            end: now - 1000,
            expiresAt: now + 1000
        }
    });
    const overlapResponse = await postJson(app, "/api/support/context", {
        accessToken: overlap.rawToken
    });
    assert.equal(overlapResponse.status, 200);
    assert.equal((await overlapResponse.json()).verified, true);
});

test("private service access tokens fail closed for deleted service states but allow suspended recovery", async t => {
    const app = await createTestApp(t);
    const { createServiceAccessLinkForPurchase } = require("../services/serviceAccessLinks");

    const deletedService = await seedPaidSetupPurchase(app, {
        serverId: 1,
        setupToken: tokenFor("setup_token_deleted_service", 1),
        email: "deleted-service@example.com",
        serviceStatus: "deleted"
    });
    const deletedServiceLink = await createServiceAccessLinkForPurchase(deletedService.purchase);
    const deletedServiceResponse = await postJson(app, "/api/support/context", {
        accessToken: deletedServiceLink.rawToken
    });
    assert.equal((await deletedServiceResponse.json()).verified, false);

    const deletedFulfillment = await seedPaidSetupPurchase(app, {
        serverId: 2,
        setupToken: tokenFor("setup_token_deleted_fulfillment", 2),
        email: "deleted-fulfillment@example.com",
        fulfillmentStatus: "deleted"
    });
    const deletedFulfillmentLink = await createServiceAccessLinkForPurchase(deletedFulfillment.purchase);
    const deletedFulfillmentResponse = await postJson(app, "/api/support/context", {
        accessToken: deletedFulfillmentLink.rawToken
    });
    assert.equal((await deletedFulfillmentResponse.json()).verified, false);

    const hardFlagged = await seedPaidSetupPurchase(app, {
        serverId: 3,
        setupToken: tokenFor("setup_token_hard_flagged", 3),
        email: "hard-flagged@example.com",
        customerRiskStatus: "hard_flagged"
    });
    const hardFlaggedLink = await createServiceAccessLinkForPurchase(hardFlagged.purchase);
    const hardFlaggedResponse = await postJson(app, "/api/support/context", {
        accessToken: hardFlaggedLink.rawToken
    });
    assert.equal((await hardFlaggedResponse.json()).verified, false);

    const suspendedRecoverable = await seedPaidSetupPurchase(app, {
        serverId: 4,
        setupToken: tokenFor("setup_token_suspended_recovery", 4),
        email: "suspended-recovery@example.com",
        serviceStatus: "suspended_final_recovery",
        customerRiskStatus: "purchase_blocked_delinquent"
    });
    const suspendedRecoverableLink = await createServiceAccessLinkForPurchase(suspendedRecoverable.purchase);
    const suspendedRecoverableResponse = await postJson(app, "/api/support/context", {
        accessToken: suspendedRecoverableLink.rawToken
    });
    assert.equal((await suspendedRecoverableResponse.json()).verified, true);
});

test("service access period fallback uses paid or created start when Stripe period start is missing", async t => {
    const app = await createTestApp(t);
    const now = 1_900_000_000_000;
    const paidAt = now - 5 * 86_400_000;
    const periodEnd = now + 25 * 86_400_000;
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_period_fallback", 1),
        email: "period-fallback@example.com",
        paidAt,
        createdAt: paidAt - 86_400_000,
        stripeCurrentPeriodEnd: periodEnd
    });
    const { createServiceAccessLinkForPurchase, getPurchasePeriodBounds } = require("../services/serviceAccessLinks");

    const bounds = getPurchasePeriodBounds(seeded.purchase, now);
    assert.equal(bounds.start, paidAt);
    assert.equal(bounds.end, periodEnd);
    assert.equal(bounds.expiresAt, periodEnd + 14 * 86_400_000);

    const created = await createServiceAccessLinkForPurchase(seeded.purchase, { now });
    assert.equal(created.link.billingPeriodStart, paidAt);
    assert.equal(created.link.billingPeriodEnd, periodEnd);
    assert.equal(created.link.expiresAt, periodEnd + 14 * 86_400_000);
});

test("private service access token supports tickets, billing portal, and ready-email resend without unsafe mutations", async t => {
    const app = await createTestApp(t, {
        stripeBillingPortalConfigurationId: "bpc_test_access",
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.test"
        }
    });
    const seeded = await seedPendingActivationPurchase(app, {
        status: "completed",
        setupToken: tokenFor("setup_token_support_access_actions", 1),
        email: "access-actions@example.com",
        fulfillmentStatus: "ready",
        serviceStatus: "active",
        stripeCustomerId: "cus_access_actions"
    });
    const { createServiceAccessLinkForPurchase } = require("../services/serviceAccessLinks");
    const created = await createServiceAccessLinkForPurchase(seeded.purchase);
    const countsBefore = {
        purchases: await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases"),
        servers: await app.queries.getQuery("SELECT COUNT(*) AS count FROM servers"),
        fulfillment: await app.queries.getQuery("SELECT COUNT(*) AS count FROM fulfillmentQueue")
    };

    const ticket = await postJson(app, "/api/support/tickets", {
        accessToken: created.rawToken,
        email: "access-actions@example.com",
        category: "service_not_ready",
        subject: "Support from private link",
        message: "Please check the verified service."
    });
    assert.equal(ticket.status, 201);
    const ticketPayload = await ticket.json();
    const snapshot = await app.queries.getQuery(
        `SELECT snapshotJson
         FROM supportTicketSnapshots sts
         JOIN supportTickets st ON st.id = sts.ticketId
         WHERE st.publicRef = ?`,
        [ticketPayload.ticket.publicRef]
    );
    assert.equal(String(snapshot.snapshotJson).includes(created.rawToken), false);

    const mismatch = await postJson(app, "/api/support/tickets", {
        accessToken: created.rawToken,
        email: "other@example.com",
        category: "service_not_ready",
        subject: "Wrong owner",
        message: "This should not work."
    });
    assert.equal(mismatch.status, 403);

    const portal = await postJson(app, "/api/support/billing-portal-session", {
        accessToken: created.rawToken
    });
    assert.equal(portal.status, 200);
    assert.equal(app.stripeState.lastCreatedPortalSessionParams.customer, "cus_access_actions");

    const resend = await postJson(app, "/api/support/resend-ready-email", {
        accessToken: created.rawToken
    });
    assert.equal(resend.status, 200);

    const countsAfter = {
        purchases: await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases"),
        servers: await app.queries.getQuery("SELECT COUNT(*) AS count FROM servers"),
        fulfillment: await app.queries.getQuery("SELECT COUNT(*) AS count FROM fulfillmentQueue")
    };
    assert.equal(countsAfter.purchases.count, countsBefore.purchases.count);
    assert.equal(countsAfter.servers.count, countsBefore.servers.count);
    assert.equal(countsAfter.fulfillment.count, countsBefore.fulfillment.count);
});

test("private service link emails store placeholders and materialize usable fragment links only at delivery", async t => {
    const app = await createTestApp(t, {
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.test"
        }
    });
    const seeded = await seedPendingActivationPurchase(app, {
        status: "completed",
        setupToken: tokenFor("setup_token_support_email_link", 1),
        email: "email-link@example.com",
        fulfillmentStatus: "ready",
        serviceStatus: "active"
    });
    const { enqueueReadyEmailForPurchase } = require("../services/emailOutbox");
    await enqueueReadyEmailForPurchase(seeded.purchase);

    const stored = await app.queries.getQuery(
        "SELECT bodyText, payloadJson FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [seeded.purchase.id, "ready_access"]
    );
    assert.match(stored.bodyText, /\{\{SERVICE_ACCESS_LINK\}\}/);
    assert.doesNotMatch(stored.bodyText, /accessToken=[A-Za-z0-9_-]+/);
    assert.doesNotMatch(stored.payloadJson, /accessToken=/);

    let delivered = null;
    const { runEmailOutboxWorkerIteration } = require("../workers/fulfillmentWorker");
    const iteration = await runEmailOutboxWorkerIteration({
        sendEmailMessage: async message => {
            delivered = message;
            return { provider: "test", providerMessageId: "msg_private_link", statusCode: 202 };
        }
    });
    assert.equal(iteration.outcome, "sent");
    assert.match(delivered.bodyText, /\/support#accessToken=/);

    const rawToken = extractAccessTokenFromBody(delivered.bodyText);
    assert.ok(rawToken);

    const context = await postJson(app, "/api/support/context", {
        accessToken: rawToken
    });
    assert.equal(context.status, 200);
    assert.equal((await context.json()).verified, true);

    const storedLink = await app.queries.getQuery(
        "SELECT tokenHash, tokenPrefix FROM serviceAccessLinks WHERE purchaseId = ?",
        [seeded.purchase.id]
    );
    assert.ok(storedLink.tokenHash);
    assert.equal(storedLink.tokenHash.includes(rawToken), false);
    assert.equal(storedLink.tokenPrefix, rawToken.slice(0, 10));
});

test("billing period sync preserves old-token overlap and queues replacement service-link email without fulfillment mutations", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: "cus_period_rotation",
                items: {
                    data: [
                        {
                            current_period_start: 1_900_100_000,
                            current_period_end: 1_902_692_000,
                            price: { id: "price_test_paper_2gb" }
                        }
                    ]
                }
            })
        }
    });
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_rotation", 1),
        email: "rotation@example.com",
        stripeSubscriptionId: "sub_period_rotation",
        stripeCurrentPeriodEnd: 1_900_099_999_000
    });
    const { createServiceAccessLinkForPurchase } = require("../services/serviceAccessLinks");
    const old = await createServiceAccessLinkForPurchase(seeded.purchase, {
        period: {
            start: 1_897_507_200_000,
            end: 1_900_099_999_000,
            expiresAt: 1_902_000_000_000
        }
    });

    const before = {
        purchases: await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases"),
        fulfillment: await app.queries.getQuery("SELECT COUNT(*) AS count FROM fulfillmentQueue")
    };

    const response = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "stripe-signature": "test-signature",
            "content-type": "application/json"
        },
        body: JSON.stringify({
            id: "evt_period_rotation",
            type: "invoice.paid",
            data: {
                object: {
                    subscription: "sub_period_rotation",
                    customer: "cus_period_rotation",
                    lines: { data: [{ price: { id: "price_test_paper_2gb" } }] }
                }
            }
        })
    });
    assert.equal(response.status, 200);

    const oldContext = await postJson(app, "/api/support/context", {
        accessToken: old.rawToken
    });
    assert.equal(oldContext.status, 200);
    assert.equal((await oldContext.json()).verified, true);

    const cappedOld = await app.queries.getQuery("SELECT expiresAt, rotatedAt FROM serviceAccessLinks WHERE id = ?", [
        old.link.id
    ]);
    assert.equal(cappedOld.expiresAt, 1_900_100_000_000 + 14 * 86_400_000);
    assert.ok(cappedOld.rotatedAt);

    const queued = await app.queries.getQuery(
        "SELECT bodyText FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [seeded.purchase.id, "service_access_link"]
    );
    assert.match(queued.bodyText, /\{\{SERVICE_ACCESS_LINK\}\}/);

    const after = {
        purchases: await app.queries.getQuery("SELECT COUNT(*) AS count FROM purchases"),
        fulfillment: await app.queries.getQuery("SELECT COUNT(*) AS count FROM fulfillmentQueue")
    };
    assert.equal(after.purchases.count, before.purchases.count);
    assert.equal(after.fulfillment.count, before.fulfillment.count);
});

test("admin can list, rotate, and revoke service access metadata without exposing raw tokens", async t => {
    const app = await createTestApp(t);
    const seeded = await seedPaidSetupPurchase(app, {
        setupToken: tokenFor("setup_token_support_admin_access", 1),
        email: "admin-access@example.com"
    });
    const { createServiceAccessLinkForPurchase } = require("../services/serviceAccessLinks");
    const created = await createServiceAccessLinkForPurchase(seeded.purchase);
    const adminCookieValue = await adminLogin(app);

    const list = await app.request(`/api/admin/purchases/${seeded.purchase.id}/service-access-links`, {
        headers: { cookie: adminCookieValue },
        userAgent: "SupportFramework/1.0"
    });
    assert.equal(list.status, 200);
    const listPayload = await list.json();
    assert.equal(listPayload.links.length, 1);
    assert.equal(JSON.stringify(listPayload).includes(created.rawToken), false);
    assert.equal(listPayload.links[0].tokenPrefix, created.rawToken.slice(0, 10));

    const rotate = await postJson(app, `/api/admin/purchases/${seeded.purchase.id}/service-access-links/rotate`, {
        adminNote: "Replace private service link."
    }, {
        cookie: adminCookieValue
    });
    assert.equal(rotate.status, 200);
    assert.equal(JSON.stringify(await rotate.json()).includes(created.rawToken), false);

    const oldContext = await postJson(app, "/api/support/context", {
        accessToken: created.rawToken
    });
    assert.equal((await oldContext.json()).verified, false);

    const replacementEmail = await app.queries.getQuery(
        "SELECT bodyText FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [seeded.purchase.id, "service_access_link"]
    );
    assert.match(replacementEmail.bodyText, /\{\{SERVICE_ACCESS_LINK\}\}/);
    assert.doesNotMatch(replacementEmail.bodyText, /accessToken=/);

    const linkRow = await app.queries.getQuery(
        "SELECT id FROM serviceAccessLinks WHERE purchaseId = ? ORDER BY id DESC LIMIT 1",
        [seeded.purchase.id]
    );
    const revoke = await postJson(app, `/api/admin/service-access-links/${linkRow.id}/revoke`, {
        adminNote: "Revoke private link."
    }, {
        cookie: adminCookieValue
    });
    assert.equal(revoke.status, 200);
    assert.equal(JSON.stringify(await revoke.json()).includes(created.rawToken), false);

    const audit = await app.queries.allQuery(
        "SELECT detailsJson FROM adminAuditLog WHERE purchaseId = ? ORDER BY id",
        [seeded.purchase.id]
    );
    assert.equal(audit.some(row => String(row.detailsJson || "").includes(created.rawToken)), false);
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
