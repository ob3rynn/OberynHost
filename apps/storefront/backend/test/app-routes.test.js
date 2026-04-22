const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");

test("public routes serve correctly and set security headers", async t => {
    const app = await createTestApp(t);

    const home = await app.request("/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /OberynHost/);
    assert.equal(home.headers.get("x-frame-options"), "DENY");
    assert.match(home.headers.get("content-security-policy") || "", /default-src 'self'/);

    const pricing = await app.request("/pricing");
    assert.equal(pricing.status, 200);

    const success = await app.request("/success");
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("cache-control"), "no-store");

    const admin = await app.request("/admin");
    assert.equal(admin.status, 200);

    const forbidden = await app.request("/admin.html");
    assert.equal(forbidden.status, 403);
});

test("plans api returns seeded inventory counts", async t => {
    const app = await createTestApp(t);
    const { runQuery } = app.queries;

    const res = await app.request("/api/plans");
    assert.equal(res.status, 200);

    const plans = await res.json();
    const byType = Object.fromEntries(plans.map(plan => [plan.type, plan]));

    assert.equal(byType["3GB"].available, 25);
    assert.match(byType["3GB"].features.join(" "), /Paper server software/);

    await runQuery("UPDATE servers SET status = ? WHERE type = ?", ["held", "3GB"]);

    const soldOutRes = await app.request("/api/plans");
    assert.equal(soldOutRes.status, 200);

    const soldOutPlans = await soldOutRes.json();
    const soldOutByType = Object.fromEntries(soldOutPlans.map(plan => [plan.type, plan]));

    assert.equal(soldOutByType["3GB"].available, 0);
    assert.equal(soldOutByType["3GB"].price, 11.98);
});

test("checkout creates a pending purchase, reserves inventory, and sets setup cookie", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_checkout_success",
            subscription: "sub_test_checkout_success",
            url: "https://checkout.stripe.test/success"
        }
    });
    const { getQuery } = app.queries;

    const res = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.url, "https://checkout.stripe.test/success");
    assert.match(app.parseSetCookie(res), /setup_session=/);
    assert.equal(app.stripeState.lastCreatedSessionParams.mode, "subscription");
    assert.equal(app.stripeState.lastCreatedSessionParams.line_items[0].price, "price_test_3gb");
    assert.ok(app.stripeState.constructors.length > 0);
    assert.ok(app.stripeState.constructors.every(({ options }) => options?.apiVersion === "2026-02-25.clover"));

    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_checkout_success"
    ]);
    assert.equal(purchase.status, "checkout_pending");
    assert.match(purchase.setupToken, /^[A-Za-z0-9_-]+$/);

    const server = await getQuery("SELECT status FROM servers WHERE id = ?", [purchase.serverId]);
    assert.equal(server.status, "held");
});

test("resume checkout endpoint surfaces an open pending checkout for the same browser", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_resume_visible",
            url: "https://checkout.stripe.test/resume-visible"
        },
        stripe: {
            retrieveSession: async id => ({
                id,
                status: "open",
                payment_status: "unpaid",
                url: "https://checkout.stripe.test/resume-visible"
            })
        }
    });

    const checkoutRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    const setupCookie = app.parseSetCookie(checkoutRes);

    const resumeRes = await app.request("/api/resume-checkout", {
        headers: { cookie: setupCookie }
    });
    assert.equal(resumeRes.status, 200);

    const resumeData = await resumeRes.json();
    assert.equal(resumeData.resumable, true);
    assert.equal(resumeData.planType, "3GB");
    assert.equal(resumeData.url, "https://checkout.stripe.test/resume-visible");
});

test("retrying the same server resumes the existing checkout instead of reserving another slot", async t => {
    let createCount = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                createCount += 1;
                return {
                    id: "cs_test_resume_same_plan",
                    url: "https://checkout.stripe.test/resume-same-plan"
                };
            },
            retrieveSession: async id => ({
                id,
                status: "open",
                payment_status: "unpaid",
                url: "https://checkout.stripe.test/resume-same-plan"
            })
        }
    });
    const { getQuery } = app.queries;

    const firstRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    const setupCookie = app.parseSetCookie(firstRes);

    const secondRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    assert.equal(secondRes.status, 200);

    const secondData = await secondRes.json();
    assert.equal(secondData.resumed, true);
    assert.equal(secondData.url, "https://checkout.stripe.test/resume-same-plan");
    assert.equal(createCount, 1);

    const purchaseCount = await getQuery("SELECT COUNT(*) AS count FROM purchases");
    assert.equal(purchaseCount.count, 1);

    const heldServers = await getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = ?", ["held"]);
    assert.equal(heldServers.count, 1);
});

test("checkout rejects invalid plan types and foreign origins", async t => {
    const app = await createTestApp(t);
    const { runQuery } = app.queries;

    const invalidPlan = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "bad-plan" })
    });
    assert.equal(invalidPlan.status, 400);

    const foreignOrigin = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: "https://evil.example"
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    assert.equal(foreignOrigin.status, 403);

    await runQuery("UPDATE servers SET status = ? WHERE type = ?", ["held", "3GB"]);
    const soldOut = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    assert.equal(soldOut.status, 400);
});

test("checkout failure cleans up held inventory and cancels the purchase", async t => {
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                throw new Error("Stripe is down");
            }
        }
    });
    const { getQuery } = app.queries;

    const res = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });

    assert.equal(res.status, 500);

    const purchase = await getQuery(
        "SELECT id, serverId, status FROM purchases ORDER BY id DESC LIMIT 1"
    );

    if (purchase) {
        assert.equal(purchase.status, "cancelled");

        const server = await getQuery("SELECT status FROM servers WHERE id = ?", [purchase.serverId]);
        assert.equal(server.status, "available");
        return;
    }

    const heldServer = await getQuery(
        "SELECT id, status FROM servers WHERE type = ? AND status = ? LIMIT 1",
        ["3GB", "held"]
    );
    assert.equal(heldServer || null, null);
});

test("webhook completed marks purchase paid, stores email, and unlocks setup", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_paid_flow",
            subscription: "sub_test_paid_flow",
            url: "https://checkout.stripe.test/paid"
        },
        stripe: {
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: "cus_test_paid_flow",
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_000,
                            price: { id: "price_test_3gb" }
                        }
                    ]
                }
            })
        }
    });
    const { getQuery } = app.queries;

    const checkoutRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    const setupCookie = app.parseSetCookie(checkoutRes);

    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_paid_flow"
    ]);

    const event = {
        type: "checkout.session.completed",
        data: {
            object: {
                id: "cs_test_paid_flow",
                metadata: {
                    purchaseId: String(purchase.id),
                    serverId: String(purchase.serverId),
                    planType: "3GB"
                },
                subscription: "sub_test_paid_flow",
                customer: "cus_test_paid_flow",
                customer_details: {
                    email: "buyer@example.com"
                }
            }
        }
    };

    const webhookRes = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify(event)
    });
    assert.equal(webhookRes.status, 200);

    const paidPurchase = await getQuery("SELECT * FROM purchases WHERE id = ?", [purchase.id]);
    assert.equal(paidPurchase.status, "paid");
    assert.equal(paidPurchase.email, "buyer@example.com");
    assert.equal(paidPurchase.stripeSubscriptionId, "sub_test_paid_flow");
    assert.equal(paidPurchase.stripeCustomerId, "cus_test_paid_flow");
    assert.equal(paidPurchase.stripeSubscriptionStatus, "active");
    assert.equal(paidPurchase.stripeCurrentPeriodEnd, 1_900_000_000_000);
    assert.equal(paidPurchase.stripePriceId, "price_test_3gb");

    const statusRes = await app.request("/api/setup-status", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: setupCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({})
    });

    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ready, true);
});

test("setup status can recover a paid purchase from Stripe session id when the setup cookie is missing", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_recover_cookie",
            subscription: "sub_test_recover_cookie",
            url: "https://checkout.stripe.test/recover-cookie"
        },
        stripe: {
            retrieveSession: async id => ({
                id,
                status: "complete",
                payment_status: "paid",
                subscription: "sub_test_recover_cookie",
                customer: "cus_test_recover_cookie",
                customer_details: {
                    email: "buyer@example.com"
                },
                metadata: {
                    purchaseId: "1",
                    serverId: "1",
                    planType: "3GB"
                }
            }),
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: "cus_test_recover_cookie",
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_100,
                            price: { id: "price_test_3gb" }
                        }
                    ]
                }
            })
        }
    });
    const { getQuery } = app.queries;

    const checkoutRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "3GB" })
    });
    assert.equal(checkoutRes.status, 200);

    const statusRes = await app.request("/api/setup-status", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            sessionId: "cs_test_recover_cookie"
        })
    });

    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ready, true);

    const setupCookie = app.parseSetCookie(statusRes);
    assert.match(setupCookie, /setup_session=/);

    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_recover_cookie"
    ]);
    assert.equal(purchase.status, "paid");
    assert.equal(purchase.email, "buyer@example.com");
    assert.equal(purchase.stripeSubscriptionId, "sub_test_recover_cookie");
    assert.equal(purchase.stripeSubscriptionStatus, "active");
});

test("webhook rejects invalid signatures", async t => {
    const app = await createTestApp(t);

    const res = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "bad-signature"
        },
        body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } })
    });

    assert.equal(res.status, 400);
    assert.match(await res.text(), /Webhook Error/);
});

test("setup can only be submitted once through the customer flow", async t => {
    const app = await createTestApp(t);
    const { runQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            1,
            "customer@example.com",
            "",
            "paid",
            "cs_test_setup_once",
            Date.now(),
            "setup_token_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 1]);

    const cookie = "setup_session=setup_token_abcdefghijklmnopqrstuvwxyz";

    const firstStatus = await app.request("/api/setup-status", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({})
    });
    const firstStatusData = await firstStatus.json();
    assert.equal(firstStatusData.ready, true);

    const firstComplete = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ serverName: "First Server" })
    });
    assert.equal(firstComplete.status, 200);

    const secondStatus = await app.request("/api/setup-status", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({})
    });
    const secondStatusData = await secondStatus.json();
    assert.equal(secondStatusData.ready, false);
    assert.equal(
        secondStatusData.message,
        "Server setup has already been submitted for this order."
    );

    const secondComplete = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ serverName: "Second Server" })
    });
    assert.equal(secondComplete.status, 400);
});

test("setup submission queues provisioning work on the same purchase", async t => {
    const app = await createTestApp(t);
    const { getQuery, runQuery } = app.queries;
    const server = await getQuery(
        `SELECT
            id,
            type,
            productCode,
            inventoryBucketCode,
            nodeGroupCode,
            provisioningTargetCode,
            runtimeFamily,
            runtimeTemplate
         FROM servers
         WHERE id = 1`
    );

    await runQuery(
        `INSERT INTO purchases
            (
                serverId,
                email,
                serverName,
                status,
                createdAt,
                setupToken,
                setupTokenExpiresAt,
                planType,
                productCode,
                inventoryBucketCode,
                nodeGroupCode,
                provisioningTargetCode,
                runtimeFamily,
                runtimeTemplate,
                paidAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            server.id,
            "queued@example.com",
            "",
            "paid",
            Date.now(),
            "setup_token_queue_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000,
            server.type,
            server.productCode,
            server.inventoryBucketCode,
            server.nodeGroupCode,
            server.provisioningTargetCode,
            server.runtimeFamily,
            server.runtimeTemplate,
            Date.now(),
            Date.now()
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", server.id]);

    const res = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: "setup_session=setup_token_queue_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({ serverName: "Queued Server" })
    });
    assert.equal(res.status, 200);

    const purchase = await getQuery(
        `SELECT
            fulfillmentStatus,
            lastStateOwner,
            hostnameReservedAt
         FROM purchases
         WHERE id = 1`
    );
    assert.equal(purchase.fulfillmentStatus, "queued");
    assert.equal(purchase.lastStateOwner, "web_app");
    assert.ok(Number(purchase.hostnameReservedAt) > 0);

    const job = await getQuery(
        `SELECT
            taskType,
            state,
            idempotencyKey,
            payloadJson
         FROM fulfillmentQueue
         WHERE purchaseId = 1`
    );
    assert.equal(job.taskType, "provision_initial_server");
    assert.equal(job.state, "queued");
    assert.equal(job.idempotencyKey, "purchase:1:task:provision_initial_server");
    assert.match(job.payloadJson, /Queued Server/);
});

test("fulfillment worker leases queued setup work and escalates it to admin review", async t => {
    const app = await createTestApp(t);
    const { getQuery, runQuery } = app.queries;
    const server = await getQuery(
        `SELECT
            id,
            type,
            productCode,
            inventoryBucketCode,
            nodeGroupCode,
            provisioningTargetCode,
            runtimeFamily,
            runtimeTemplate
         FROM servers
         WHERE id = 2`
    );

    await runQuery(
        `INSERT INTO purchases
            (
                serverId,
                email,
                serverName,
                status,
                createdAt,
                setupToken,
                setupTokenExpiresAt,
                planType,
                productCode,
                inventoryBucketCode,
                nodeGroupCode,
                provisioningTargetCode,
                runtimeFamily,
                runtimeTemplate,
                paidAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            server.id,
            "worker@example.com",
            "",
            "paid",
            Date.now(),
            "setup_token_worker_queue_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000,
            server.type,
            server.productCode,
            server.inventoryBucketCode,
            server.nodeGroupCode,
            server.provisioningTargetCode,
            server.runtimeFamily,
            server.runtimeTemplate,
            Date.now(),
            Date.now()
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", server.id]);

    const setupRes = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: "setup_session=setup_token_worker_queue_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({ serverName: "Worker Queue Server" })
    });
    assert.equal(setupRes.status, 200);

    const { runFulfillmentWorkerIteration } = require("../workers/fulfillmentWorker");
    const iteration = await runFulfillmentWorkerIteration();

    assert.equal(iteration.outcome, "needs_admin_review");
    assert.equal(iteration.purchaseId, 1);

    const purchase = await getQuery(
        `SELECT
            fulfillmentStatus,
            fulfillmentFailureClass,
            needsAdminReviewReason,
            workerLeaseKey,
            workerLeaseExpiresAt,
            provisioningAttemptCount,
            lastStateOwner
         FROM purchases
         WHERE id = 1`
    );
    assert.equal(purchase.fulfillmentStatus, "needs_admin_review");
    assert.equal(purchase.fulfillmentFailureClass, "manual_approval_required");
    assert.match(purchase.needsAdminReviewReason, /Pelican provisioning contract is not configured yet/);
    assert.equal(purchase.workerLeaseKey, null);
    assert.equal(purchase.workerLeaseExpiresAt, null);
    assert.equal(purchase.provisioningAttemptCount, 1);
    assert.equal(purchase.lastStateOwner, "worker");

    const job = await getQuery(
        `SELECT
            state,
            attempts,
            completedAt,
            leaseKey,
            leaseExpiresAt,
            lastError
         FROM fulfillmentQueue
         WHERE purchaseId = 1`
    );
    assert.equal(job.state, "needs_admin_review");
    assert.equal(job.attempts, 1);
    assert.ok(Number(job.completedAt) > 0);
    assert.equal(job.leaseKey, null);
    assert.equal(job.leaseExpiresAt, null);
    assert.match(job.lastError, /Pelican provisioning contract is not configured yet/);
});

test("webhook expired releases held inventory for abandoned checkout", async t => {
    const app = await createTestApp(t);
    const { runQuery, getQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            2,
            "",
            "",
            "checkout_pending",
            "cs_test_expire_me",
            Date.now(),
            "setup_token_expire_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 2]);

    const event = {
        type: "checkout.session.expired",
        data: {
            object: {
                id: "cs_test_expire_me",
                metadata: { purchaseId: "1" }
            }
        }
    };

    const res = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify(event)
    });
    assert.equal(res.status, 200);

    const purchase = await getQuery("SELECT status FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_expire_me"
    ]);
    assert.equal(purchase.status, "expired");

    const server = await getQuery("SELECT status FROM servers WHERE id = ?", [2]);
    assert.equal(server.status, "available");
});

test("subscription runtime webhooks update and release fulfilled servers when subscriptions end", async t => {
    const app = await createTestApp(t);
    const { runQuery, getQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt,
             stripeCustomerId, stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd,
             stripeCancelAtPeriodEnd, stripePriceId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            5,
            "sub@example.com",
            "Subscription Server",
            "completed",
            "cs_test_runtime",
            Date.now(),
            "setup_token_runtime_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000,
            "cus_runtime",
            "sub_runtime",
            "active",
            Date.now() + 86_400_000,
            0,
            "price_test_3gb"
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["allocated", 5]);

    const deleted = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify({
            type: "customer.subscription.deleted",
            data: {
                object: {
                    id: "sub_runtime",
                    status: "canceled",
                    cancel_at_period_end: false,
                    customer: "cus_runtime",
                    items: {
                        data: [
                            {
                                current_period_end: 1_900_000_100,
                                price: { id: "price_test_3gb" }
                            }
                        ]
                    }
                }
            }
        })
    });
    assert.equal(deleted.status, 200);

    const endedPurchase = await getQuery(
        "SELECT stripeSubscriptionStatus FROM purchases WHERE stripeSubscriptionId = ?",
        ["sub_runtime"]
    );
    assert.equal(endedPurchase.stripeSubscriptionStatus, "canceled");

    const endedServer = await getQuery("SELECT status FROM servers WHERE id = ?", [5]);
    assert.equal(endedServer.status, "available");
});

test("failed renewal enters grace period and paid invoice clears delinquency", async t => {
    const app = await createTestApp(t);
    const { runQuery, getQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt,
             stripeCustomerId, stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd,
             stripeCancelAtPeriodEnd, stripePriceId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            6,
            "renewal@example.com",
            "Renewal Server",
            "completed",
            "cs_test_renewal_runtime",
            Date.now(),
            "setup_token_renewal_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000,
            "cus_renewal",
            "sub_renewal",
            "active",
            Date.now() + 86_400_000,
            0,
            "price_test_3gb"
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["allocated", 6]);

    const failedRes = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify({
            type: "invoice.payment_failed",
            data: {
                object: {
                    subscription: "sub_renewal",
                    customer: "cus_renewal",
                    lines: { data: [{ price: { id: "price_test_3gb" } }] }
                }
            }
        })
    });
    assert.equal(failedRes.status, 200);

    const delinquentPurchase = await getQuery(
        "SELECT subscriptionDelinquentAt FROM purchases WHERE stripeSubscriptionId = ?",
        ["sub_renewal"]
    );
    assert.ok(Number(delinquentPurchase.subscriptionDelinquentAt) > 0);

    const paidRes = await app.request("/api/stripe/webhook", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "good-signature"
        },
        body: JSON.stringify({
            type: "invoice.paid",
            data: {
                object: {
                    subscription: "sub_renewal",
                    customer: "cus_renewal",
                    lines: { data: [{ price: { id: "price_test_3gb" } }] }
                }
            }
        })
    });
    assert.equal(paidRes.status, 200);

    const recoveredPurchase = await getQuery(
        "SELECT subscriptionDelinquentAt, serviceSuspendedAt FROM purchases WHERE stripeSubscriptionId = ?",
        ["sub_renewal"]
    );
    assert.equal(recoveredPurchase.subscriptionDelinquentAt, null);
    assert.equal(recoveredPurchase.serviceSuspendedAt, null);
});

test("admin auth, completion, reconcile, and audit trail work", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSession: async id => ({
                id,
                status: "complete",
                payment_status: "paid",
                customer_details: { email: "operator-check@example.com" }
            })
        }
    });
    const { runQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            3,
            "",
            "Admin Ready",
            "checkout_pending",
            "cs_test_admin_reconcile",
            Date.now(),
            "setup_token_admin_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 3]);

    const badLogin = [];
    for (let index = 0; index < 5; index += 1) {
        badLogin.push(await app.request("/api/admin/login", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: app.baseUrl
            },
            body: JSON.stringify({ key: "wrong-key" })
        }));
    }
    assert.ok(badLogin.every(response => response.status === 401));

    const limited = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ key: "wrong-key" })
    });
    assert.equal(limited.status, 429);

    const authless = await app.request("/api/purchases");
    assert.equal(authless.status, 401);
});

test("admin happy path allows login, reconcile, complete, and logout", async t => {
    const app = await createTestApp(t, {
        stripe: {
            retrieveSession: async id => ({
                id,
                status: "complete",
                payment_status: "paid",
                customer: "cus_test_admin_complete",
                subscription: "sub_test_admin_complete",
                customer_details: { email: "operator-check@example.com" }
            }),
            retrieveSubscription: async id => ({
                id,
                status: "active",
                cancel_at_period_end: false,
                customer: "cus_test_admin_complete",
                items: {
                    data: [
                        {
                            current_period_end: 1_900_000_200,
                            price: { id: "price_test_3gb" }
                        }
                    ]
                }
            })
        }
    });
    const { runQuery, getQuery, allQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            4,
            "",
            "Completion Test",
            "checkout_pending",
            "cs_test_admin_complete",
            Date.now(),
            "setup_token_complete_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 4]);

    const loginRes = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ key: "test-admin-key" })
    });
    assert.equal(loginRes.status, 200);
    const adminCookie = app.parseSetCookie(loginRes);
    assert.match(adminCookie, /admin_session=/);

    const purchasesRes = await app.request("/api/purchases", {
        headers: { cookie: adminCookie }
    });
    assert.equal(purchasesRes.status, 200);

    const reconcileRes = await app.request("/api/admin/purchases/1/reconcile-stripe", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ adminNote: "Verifying customer report" })
    });
    assert.equal(reconcileRes.status, 200);
    const reconcileData = await reconcileRes.json();
    assert.equal(reconcileData.action, "marked_paid");

    const completeRes = await app.request("/api/complete", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ purchaseId: 1, adminNote: "Delivered" })
    });
    assert.equal(completeRes.status, 200);

    const purchase = await getQuery(
        `SELECT status, stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd
         FROM purchases WHERE id = 1`
    );
    assert.equal(purchase.status, "completed");
    assert.equal(purchase.stripeSubscriptionId, "sub_test_admin_complete");
    assert.equal(purchase.stripeSubscriptionStatus, "active");
    assert.equal(purchase.stripeCurrentPeriodEnd, 1_900_000_200_000);

    const server = await getQuery("SELECT status FROM servers WHERE id = 4");
    assert.equal(server.status, "allocated");

    const auditRows = await allQuery(
        "SELECT actionType, note FROM adminAuditLog WHERE purchaseId = 1 ORDER BY id ASC"
    );
    assert.deepEqual(
        auditRows.map(row => row.actionType),
        ["reconcile_stripe", "mark_complete"]
    );

    const logoutRes = await app.request("/api/admin/logout", {
        method: "POST",
        headers: {
            cookie: adminCookie,
            origin: app.baseUrl
        }
    });
    assert.equal(logoutRes.status, 200);

    const afterLogout = await app.request("/api/purchases", {
        headers: { cookie: adminCookie }
    });
    assert.equal(afterLogout.status, 401);
});

test("admin guardrails block cancelling or releasing a live subscription, but allow suspension", async t => {
    const app = await createTestApp(t);
    const { runQuery, getQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt,
             stripeCustomerId, stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd,
             stripeCancelAtPeriodEnd, stripePriceId, subscriptionDelinquentAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            7,
            "guardrail@example.com",
            "Guardrail Server",
            "completed",
            "cs_test_guardrails",
            Date.now(),
            "setup_token_guardrails_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000,
            "cus_guardrails",
            "sub_guardrails",
            "past_due",
            Date.now() + 86_400_000,
            0,
            "price_test_3gb",
            Date.now() - (1000 * 60 * 60 * 24 * 8)
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["allocated", 7]);

    const loginRes = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ key: "test-admin-key" })
    });
    const adminCookie = app.parseSetCookie(loginRes);

    const cancelRes = await app.request("/api/admin/purchases/1", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({
            status: "cancelled",
            adminNote: "Testing guardrails"
        })
    });
    assert.equal(cancelRes.status, 400);

    const releaseRes = await app.request("/api/admin/purchases/1", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverStatus: "available",
            adminNote: "Testing guardrails"
        })
    });
    assert.equal(releaseRes.status, 400);

    const suspendRes = await app.request("/api/admin/purchases/1", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serviceAccessAction: "suspend",
            adminNote: "Grace expired"
        })
    });
    assert.equal(suspendRes.status, 200);

    const suspendedPurchase = await getQuery(
        "SELECT serviceSuspendedAt FROM purchases WHERE id = 1"
    );
    assert.ok(Number(suspendedPurchase.serviceSuspendedAt) > 0);

    const suspendedServer = await getQuery("SELECT status FROM servers WHERE id = ?", [7]);
    assert.equal(suspendedServer.status, "held");
});
