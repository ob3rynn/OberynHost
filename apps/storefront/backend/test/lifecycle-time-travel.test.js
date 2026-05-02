const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const { assertCoreBusinessInvariants } = require("./helpers/invariants");
const {
    ORIGINAL_REFUND_WINDOW_MS,
    SUBSCRIPTION_GRACE_PERIOD_MS,
    SUSPENSION_RETENTION_MS,
    getPurchasePolicyState
} = require("../services/policyRules");

async function adminLogin(app) {
    const response = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ key: "test-admin-key" })
    });
    assert.equal(response.status, 200);
    return app.parseSetCookie(response);
}

async function seedCompletedPurchase(app, options = {}) {
    const now = options.now || Date.now();
    const serverId = options.serverId || 1;
    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeSessionId,
                stripeCustomerId, stripeSubscriptionId, stripeSubscriptionStatus,
                stripeCurrentPeriodEnd, stripeCancelAtPeriodEnd, stripePriceId,
                subscriptionDelinquentAt, serviceSuspendedAt, createdAt,
                setupToken, setupTokenExpiresAt, paidAt, completedAt,
                setupStatus, fulfillmentStatus, serviceStatus, customerRiskStatus,
                hostname, hostnameReservationKey, routingVerifiedAt,
                pelicanUserId, pelicanUsername, pelicanServerId,
                pelicanServerIdentifier, pelicanAllocationId
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            serverId,
            options.email || "lifecycle@example.com",
            options.serverName || "Lifecycle Server",
            "completed",
            options.stripeSessionId || `cs_test_lifecycle_${serverId}`,
            options.stripeCustomerId || `cus_lifecycle_${serverId}`,
            options.stripeSubscriptionId || `sub_lifecycle_${serverId}`,
            options.stripeSubscriptionStatus || "active",
            now + 86_400_000,
            0,
            "price_test_paper_2gb",
            options.subscriptionDelinquentAt ?? null,
            options.serviceSuspendedAt ?? null,
            options.createdAt || now - 1_000,
            options.setupToken || `setup_token_lifecycle_${serverId}_abcdefghijklmnopqrstuvwxyz`,
            now + 60_000,
            options.paidAt || now - 1_000,
            options.completedAt || now - 1_000,
            "setup_submitted",
            options.fulfillmentStatus || "ready",
            options.serviceStatus || "active",
            options.customerRiskStatus || "clear",
            options.hostname || `lifecycle-${serverId}.oberyn.net`,
            options.hostnameReservationKey || `lifecycle-${serverId}`,
            options.routingVerifiedAt || now - 1_000,
            options.pelicanUserId || `pelican-user-${serverId}`,
            options.pelicanUsername || `lifecycle_user_${serverId}`,
            options.pelicanServerId || `pelican-server-${serverId}`,
            options.pelicanServerIdentifier || `srv_lifecycle_${serverId}`,
            options.pelicanAllocationId || `allocation-${serverId}`
        ]
    );
    await app.queries.runQuery(
        "UPDATE servers SET status = ?, allocatedAt = ? WHERE id = ?",
        [options.serverStatus || "allocated", now - 1_000, serverId]
    );
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

test("paid setup stall clocks switch from no-op to reminder at 24h and escalation at 72h", async t => {
    const app = await createTestApp(t);
    const {
        PAID_SETUP_ADMIN_ESCALATION_DELAY_MS,
        PAID_SETUP_REMINDER_DELAY_MS
    } = require("../services/lifecycleEnforcement");
    const { runLifecycleWorkerIteration } = require("../workers/fulfillmentWorker");
    const now = 1_900_000_000_000;

    await app.queries.runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt,
             setupToken, setupTokenExpiresAt, paidAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            1,
            "stall-boundary@example.com",
            "",
            "paid",
            "cs_test_stall_boundary",
            now - PAID_SETUP_REMINDER_DELAY_MS + 1,
            "setup_token_stall_boundary_abcdefghijklmnopqrstuvwxyz",
            now + 86_400_000,
            now - PAID_SETUP_REMINDER_DELAY_MS + 1
        ]
    );
    await app.queries.runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 1]);

    const beforeReminder = await runLifecycleWorkerIteration({ now });
    assert.equal(beforeReminder, null);

    const reminderNow = now + 1;
    const reminder = await runLifecycleWorkerIteration({ now: reminderNow });
    assert.equal(reminder.outcome, "setup_reminder_queued");

    await app.queries.runQuery(
        "UPDATE purchases SET paidAt = ?, createdAt = ? WHERE id = ?",
        [
            now - PAID_SETUP_ADMIN_ESCALATION_DELAY_MS,
            now - PAID_SETUP_ADMIN_ESCALATION_DELAY_MS,
            1
        ]
    );
    const escalation = await runLifecycleWorkerIteration({ now });
    assert.equal(escalation.outcome, "paid_setup_admin_escalation");

    const reminderCount = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM emailOutbox WHERE purchaseId = ? AND kind = ?",
        [1, "setup_reminder"]
    );
    const escalationCount = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE purchaseId = ? AND actionType = ?",
        [1, "worker_escalate_paid_stall"]
    );
    assert.equal(reminderCount.count, 1);
    assert.equal(escalationCount.count, 1);

    await assertCoreBusinessInvariants(app.queries);
});

test("policy clock boundaries cover refund, grace, suspension, and checkout expiration before payment", async t => {
    const app = await createTestApp(t);
    const now = 1_900_100_000_000;

    const insideRefund = getPurchasePolicyState({
        status: "completed",
        createdAt: now - ORIGINAL_REFUND_WINDOW_MS
    }, now);
    const outsideRefund = getPurchasePolicyState({
        status: "completed",
        createdAt: now - ORIGINAL_REFUND_WINDOW_MS - 1
    }, now);
    assert.equal(insideRefund.originalPurchaseRefundEligible, true);
    assert.equal(outsideRefund.originalPurchaseRefundEligible, false);

    await app.queries.runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt,
             setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            1,
            "",
            "",
            "checkout_pending",
            "cs_test_expire_boundary",
            now,
            "setup_token_expire_boundary_abcdefghijklmnopqrstuvwxyz",
            now + 60_000
        ]
    );
    await app.queries.runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 1]);

    const firstExpire = await postWebhook(app, {
        id: "evt_expire_boundary_1",
        type: "checkout.session.expired",
        data: {
            object: {
                id: "cs_test_expire_boundary",
                metadata: { purchaseId: "1" }
            }
        }
    });
    const replayExpire = await postWebhook(app, {
        id: "evt_expire_boundary_2",
        type: "checkout.session.expired",
        data: {
            object: {
                id: "cs_test_expire_boundary",
                metadata: { purchaseId: "1" }
            }
        }
    });
    assert.equal(firstExpire.status, 200);
    assert.equal(replayExpire.status, 200);

    const purchase = await app.queries.getQuery("SELECT status FROM purchases WHERE id = ?", [1]);
    const server = await app.queries.getQuery("SELECT status FROM servers WHERE id = ?", [1]);
    assert.equal(purchase.status, "expired");
    assert.equal(server.status, "available");
});

test("delinquency grace boundary suspends at expiry and invoice paid recovers suspended capacity", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: "cus_recover_suspended",
                items: {
                    data: [
                        {
                            current_period_end: 1_900_200_000,
                            price: { id: "price_test_paper_2gb" }
                        }
                    ]
                }
            })
        }
    });
    const { runLifecycleWorkerIteration } = require("../workers/fulfillmentWorker");
    const now = 1_900_200_000_000;
    await seedCompletedPurchase(app, {
        now,
        serverId: 1,
        stripeCustomerId: "cus_recover_suspended",
        stripeSubscriptionId: "sub_recover_suspended",
        stripeSubscriptionStatus: "past_due",
        subscriptionDelinquentAt: now - SUBSCRIPTION_GRACE_PERIOD_MS + 1,
        serviceStatus: "grace_live",
        customerRiskStatus: "purchase_blocked_delinquent"
    });

    const beforeGraceEnds = await runLifecycleWorkerIteration({ now });
    assert.equal(beforeGraceEnds, null);

    const suspension = await runLifecycleWorkerIteration({ now: now + 1 });
    assert.equal(suspension.outcome, "suspended_for_nonpayment");

    const suspendedServer = await app.queries.getQuery("SELECT status FROM servers WHERE id = ?", [1]);
    assert.equal(suspendedServer.status, "held");

    const paid = await postWebhook(app, {
        id: "evt_paid_recover_suspended",
        type: "invoice.paid",
        data: {
            object: {
                subscription: "sub_recover_suspended",
                customer: "cus_recover_suspended",
                lines: { data: [{ price: { id: "price_test_paper_2gb" } }] }
            }
        }
    });
    assert.equal(paid.status, 200);

    const recoveredPurchase = await app.queries.getQuery(
        `SELECT subscriptionDelinquentAt, serviceSuspendedAt, serviceStatus, customerRiskStatus
         FROM purchases WHERE id = ?`,
        [1]
    );
    const recoveredServer = await app.queries.getQuery("SELECT status FROM servers WHERE id = ?", [1]);
    assert.equal(recoveredPurchase.subscriptionDelinquentAt, null);
    assert.equal(recoveredPurchase.serviceSuspendedAt, null);
    assert.equal(recoveredPurchase.serviceStatus, "active");
    assert.equal(recoveredPurchase.customerRiskStatus, "clear");
    assert.equal(recoveredServer.status, "allocated");

    await assertCoreBusinessInvariants(app.queries);
});

test("suspended delete warnings queue 72h, 48h, and 24h messages once each", async t => {
    const app = await createTestApp(t);
    const { runLifecycleWorkerIteration } = require("../workers/fulfillmentWorker");
    const now = 1_900_300_000_000;
    const hour = 60 * 60 * 1000;
    const purgeAt = now + (72 * hour) - 1_000;
    const suspendedAt = purgeAt - SUSPENSION_RETENTION_MS;

    await seedCompletedPurchase(app, {
        now,
        serverId: 1,
        serviceSuspendedAt: suspendedAt,
        serviceStatus: "suspended_final_recovery",
        customerRiskStatus: "purchase_blocked_delinquent",
        serverStatus: "held"
    });

    const warning72 = await runLifecycleWorkerIteration({ now });
    const warning48 = await runLifecycleWorkerIteration({ now: purgeAt - (48 * hour) + 1_000 });
    const warning24 = await runLifecycleWorkerIteration({ now: purgeAt - (24 * hour) + 1_000 });
    const duplicate24 = await runLifecycleWorkerIteration({ now: purgeAt - (24 * hour) + 2_000 });

    assert.equal(warning72.emailKind, "suspension_delete_warning_72h");
    assert.equal(warning48.emailKind, "suspension_delete_warning_48h");
    assert.equal(warning24.emailKind, "suspension_delete_warning_24h");
    assert.equal(duplicate24, null);

    const warnings = await app.queries.allQuery(
        "SELECT kind FROM emailOutbox WHERE purchaseId = ? ORDER BY kind",
        [1]
    );
    assert.deepEqual(warnings.map(row => row.kind).sort(), [
        "suspension_delete_warning_24h",
        "suspension_delete_warning_48h",
        "suspension_delete_warning_72h"
    ]);

    await assertCoreBusinessInvariants(app.queries);
});

test("retention expiry opens one purge review and hard-flag remains explicit/admin-only", async t => {
    const app = await createTestApp(t);
    const { runLifecycleWorkerIteration } = require("../workers/fulfillmentWorker");
    const now = Date.now();
    const suspendedAt = now - SUSPENSION_RETENTION_MS - 1_000;

    await seedCompletedPurchase(app, {
        now,
        serverId: 1,
        serviceSuspendedAt: suspendedAt,
        serviceStatus: "suspended_final_recovery",
        customerRiskStatus: "purchase_blocked_delinquent",
        serverStatus: "held"
    });

    const purgeReview = await runLifecycleWorkerIteration({ now });
    const duplicateReview = await runLifecycleWorkerIteration({ now: now + 1_000 });
    assert.equal(purgeReview.outcome, "purge_review_task_opened");
    assert.equal(duplicateReview, null);

    const adminCookie = await adminLogin(app);
    const hardFlag = await app.request("/api/admin/purchases/1/mark-hard-flag", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ adminNote: "Destructive cleanup reviewed externally" })
    });
    assert.equal(hardFlag.status, 200);

    const purchase = await app.queries.getQuery(
        "SELECT customerRiskStatus, serviceStatus FROM purchases WHERE id = ?",
        [1]
    );
    const server = await app.queries.getQuery("SELECT status FROM servers WHERE id = ?", [1]);
    assert.equal(purchase.customerRiskStatus, "hard_flagged");
    assert.equal(purchase.serviceStatus, "suspended_final_recovery");
    assert.equal(server.status, "held");

    await assertCoreBusinessInvariants(app.queries);
});
