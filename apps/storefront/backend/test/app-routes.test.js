const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");

function createPelicanTargetsJson() {
    return JSON.stringify({
        "paper-launch-default": {
            egg: {
                byRuntimeProfile: {
                    "paper-java17": 17,
                    "paper-java21": 21,
                    "paper-java25": 25
                }
            },
            allocationIds: [9001, 9002],
            dockerImage: {
                byRuntimeProfile: {
                    "paper-java17": "ghcr.io/pelican-eggs/yolks:java_17",
                    "paper-java21": "ghcr.io/pelican-eggs/yolks:java_21",
                    "paper-java25": "ghcr.io/pelican-eggs/yolks:java_25"
                }
            },
            startup: "java -Xms128M -XX:MaxRAMPercentage=95.0 -jar {{SERVER_JARFILE}}",
            environment: {
                SERVER_JARFILE: "server.jar",
                MINECRAFT_VERSION: "{{minecraftVersion}}",
                BUILD_NUMBER: "latest"
            },
            limits: {
                memory: 3072,
                swap: 0,
                disk: 10240,
                io: 500,
                cpu: 0,
                threads: null
            },
            featureLimits: {
                databases: 0,
                allocations: 0,
                backups: 1
            },
            skipScripts: false,
            startOnCompletion: false,
            oomKiller: true
        }
    });
}

function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "content-type": "application/json"
        }
    });
}

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
        body: JSON.stringify({
            serverName: "First Server",
            minecraftVersion: "1.21.11",
            pelicanUsername: "first_customer",
            pelicanPassword: "temporary-password"
        })
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
        body: JSON.stringify({
            serverName: "Second Server",
            minecraftVersion: "1.21.11",
            pelicanUsername: "first_customer",
            pelicanPassword: "temporary-password"
        })
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
        body: JSON.stringify({
            serverName: "Queued Server",
            minecraftVersion: "1.21.11",
            pelicanUsername: "queued_customer",
            pelicanPassword: "queued-password"
        })
    });
    assert.equal(res.status, 200);

    const purchase = await getQuery(
        `SELECT
            fulfillmentStatus,
            lastStateOwner,
            hostnameReservedAt,
            minecraftVersion,
            runtimeProfileCode,
            runtimeJavaVersion,
            hostname,
            hostnameReservationKey,
            pelicanUsername,
            pelicanPasswordCiphertext,
            pelicanPasswordIv,
            pelicanPasswordAuthTag
         FROM purchases
         WHERE id = 1`
    );
    assert.equal(purchase.fulfillmentStatus, "queued");
    assert.equal(purchase.lastStateOwner, "web_app");
    assert.ok(Number(purchase.hostnameReservedAt) > 0);
    assert.equal(purchase.minecraftVersion, "1.21.11");
    assert.equal(purchase.runtimeProfileCode, "paper-java21");
    assert.equal(purchase.runtimeJavaVersion, 21);
    assert.equal(purchase.hostname, "queued-server.oberyn.net");
    assert.equal(purchase.hostnameReservationKey, "queued-server");
    assert.equal(purchase.pelicanUsername, "queued_customer");
    assert.ok(purchase.pelicanPasswordCiphertext);
    assert.ok(purchase.pelicanPasswordIv);
    assert.ok(purchase.pelicanPasswordAuthTag);
    assert.notEqual(purchase.pelicanPasswordCiphertext, "queued-password");

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
    assert.match(job.payloadJson, /queued-server\.oberyn\.net/);
    assert.match(job.payloadJson, /queued_customer/);
    assert.match(job.payloadJson, /1.21.11/);
    assert.doesNotMatch(job.payloadJson, /queued-password/);
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
        body: JSON.stringify({
            serverName: "Worker Queue Server",
            minecraftVersion: "1.20.6",
            pelicanUsername: "worker_customer",
            pelicanPassword: "worker-password"
        })
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
    assert.match(purchase.needsAdminReviewReason, /Pelican provisioning adapter is not configured/);
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
    assert.match(job.lastError, /Pelican provisioning adapter is not configured/);
});

test("fulfillment worker can provision to pending activation through an injected adapter", async t => {
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
                stripeCustomerId,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            server.id,
            "success@example.com",
            "",
            "paid",
            "cus_success",
            Date.now(),
            "setup_token_success_queue_abcdefghijklmnopqrstuvwxyz",
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
            cookie: "setup_session=setup_token_success_queue_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverName: "Success Server",
            minecraftVersion: "1.21.11",
            pelicanUsername: "success_customer",
            pelicanPassword: "success-password"
        })
    });
    assert.equal(setupRes.status, 200);

    let capturedProvisioningInput = null;
    const { runFulfillmentWorkerIteration } = require("../workers/fulfillmentWorker");
    const iteration = await runFulfillmentWorkerIteration({
        provisionInitialServer: async input => {
            capturedProvisioningInput = input;
            return {
                pelicanUserId: "pelican-user-success",
                pelicanUsername: input.pelicanUsername,
                pelicanServerId: "pelican-server-success",
                pelicanServerIdentifier: "srv_success",
                pelicanAllocationId: "allocation-success"
            };
        }
    });

    assert.equal(iteration.outcome, "pending_activation");
    assert.equal(capturedProvisioningInput.hostname, "success-server.oberyn.net");
    assert.equal(capturedProvisioningInput.runtimeJavaVersion, 21);
    assert.equal(capturedProvisioningInput.pelicanPassword, "success-password");

    const purchase = await getQuery(
        `SELECT
            fulfillmentStatus,
            pelicanUserId,
            pelicanServerId,
            pelicanServerIdentifier,
            pelicanAllocationId,
            pelicanUsername,
            pelicanPasswordCiphertext,
            pelicanPasswordIv,
            pelicanPasswordAuthTag,
            pelicanPasswordStoredAt,
            desiredRoutingArtifactJson,
            desiredRoutingArtifactGeneratedAt,
            workerLeaseKey,
            workerLeaseExpiresAt,
            provisioningAttemptCount,
            lastStateOwner
         FROM purchases
         WHERE id = 1`
    );
    assert.equal(purchase.fulfillmentStatus, "pending_activation");
    assert.equal(purchase.pelicanUserId, "pelican-user-success");
    assert.equal(purchase.pelicanServerId, "pelican-server-success");
    assert.equal(purchase.pelicanServerIdentifier, "srv_success");
    assert.equal(purchase.pelicanAllocationId, "allocation-success");
    assert.equal(purchase.pelicanUsername, "success_customer");
    assert.equal(purchase.pelicanPasswordCiphertext, null);
    assert.equal(purchase.pelicanPasswordIv, null);
    assert.equal(purchase.pelicanPasswordAuthTag, null);
    assert.equal(purchase.pelicanPasswordStoredAt, null);
    assert.ok(Number(purchase.desiredRoutingArtifactGeneratedAt) > 0);
    assert.equal(purchase.workerLeaseKey, null);
    assert.equal(purchase.workerLeaseExpiresAt, null);
    assert.equal(purchase.provisioningAttemptCount, 1);
    assert.equal(purchase.lastStateOwner, "worker");

    const allocatedServer = await getQuery(
        "SELECT status, allocatedAt FROM servers WHERE id = ?",
        [server.id]
    );
    assert.equal(allocatedServer.status, "allocated");
    assert.ok(Number(allocatedServer.allocatedAt) > 0);

    const artifact = JSON.parse(purchase.desiredRoutingArtifactJson);
    assert.equal(artifact.kind, "haproxy_desired_mapping");
    assert.equal(artifact.hostname, "success-server.oberyn.net");
    assert.equal(artifact.pelicanServerIdentifier, "srv_success");
    assert.equal(artifact.pelicanAllocationId, "allocation-success");

    const job = await getQuery(
        `SELECT state, completedAt, lastError, leaseKey, leaseExpiresAt
         FROM fulfillmentQueue
         WHERE purchaseId = 1`
    );
    assert.equal(job.state, "completed");
    assert.ok(Number(job.completedAt) > 0);
    assert.equal(job.lastError, null);
    assert.equal(job.leaseKey, null);
    assert.equal(job.leaseExpiresAt, null);

    const link = await getQuery(
        `SELECT pelicanUserId, pelicanUsername
         FROM customerPelicanLinks
         WHERE stripeCustomerId = ?`,
        ["cus_success"]
    );
    assert.equal(link.pelicanUserId, "pelican-user-success");
    assert.equal(link.pelicanUsername, "success_customer");
});

test("fulfillment worker uses configured Pelican Application API adapter", async t => {
    const app = await createTestApp(t, {
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.net",
            PELICAN_APPLICATION_API_KEY: "ptla_test_key",
            PELICAN_PROVISIONING_TARGETS_JSON: createPelicanTargetsJson()
        }
    });
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
                stripeCustomerId,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            server.id,
            "adapter@example.com",
            "",
            "paid",
            "cus_live_adapter",
            Date.now(),
            "setup_token_live_adapter_abcdefghijklmnopqrstuvwxyz",
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
            cookie: "setup_session=setup_token_live_adapter_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverName: "Live Adapter",
            minecraftVersion: "1.20.6",
            pelicanUsername: "adapter_customer",
            pelicanPassword: "adapter-password"
        })
    });
    assert.equal(setupRes.status, 200);

    const originalFetch = global.fetch;
    const calls = [];
    let userCreatePayload = null;
    let serverCreatePayload = null;

    global.fetch = async (url, options = {}) => {
        const requestUrl = new URL(String(url));
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({
            method: options.method || "GET",
            path: requestUrl.pathname,
            body
        });

        if (requestUrl.pathname === "/api/application/servers/external/purchase%3A1") {
            return new Response("", { status: 404 });
        }

        if (requestUrl.pathname === "/api/application/users/external/stripe%3Acus_live_adapter") {
            return new Response("", { status: 404 });
        }

        if (requestUrl.pathname === "/api/application/users" && options.method === "POST") {
            userCreatePayload = body;
            return jsonResponse(201, {
                object: "user",
                attributes: {
                    id: 321,
                    username: body.username
                }
            });
        }

        if (requestUrl.pathname === "/api/application/servers" && options.method === "POST") {
            serverCreatePayload = body;
            return jsonResponse(201, {
                object: "server",
                attributes: {
                    id: 654,
                    identifier: "srv_adapter",
                    allocation: body.allocation.default,
                    user: body.user
                }
            });
        }

        return jsonResponse(500, { error: "unexpected Pelican API call" });
    };
    t.after(() => {
        global.fetch = originalFetch;
    });

    const { runFulfillmentWorkerIteration } = require("../workers/fulfillmentWorker");
    const iteration = await runFulfillmentWorkerIteration();

    assert.equal(iteration.outcome, "pending_activation");
    assert.deepEqual(
        calls.map(call => `${call.method} ${call.path}`),
        [
            "GET /api/application/servers/external/purchase%3A1",
            "GET /api/application/users/external/stripe%3Acus_live_adapter",
            "POST /api/application/users",
            "POST /api/application/servers"
        ]
    );

    assert.equal(userCreatePayload.external_id, "stripe:cus_live_adapter");
    assert.equal(userCreatePayload.email, "adapter@example.com");
    assert.equal(userCreatePayload.username, "adapter_customer");
    assert.equal(userCreatePayload.password, "adapter-password");

    assert.equal(serverCreatePayload.external_id, "purchase:1");
    assert.equal(serverCreatePayload.name, "Live Adapter");
    assert.equal(serverCreatePayload.user, 321);
    assert.equal(serverCreatePayload.egg, 21);
    assert.equal(serverCreatePayload.docker_image, "ghcr.io/pelican-eggs/yolks:java_21");
    assert.equal(serverCreatePayload.environment.MINECRAFT_VERSION, "1.20.6");
    assert.equal(serverCreatePayload.allocation.default, 9001);
    assert.equal(serverCreatePayload.limits.memory, 3072);

    const purchase = await getQuery(
        `SELECT
            fulfillmentStatus,
            pelicanUserId,
            pelicanServerId,
            pelicanServerIdentifier,
            pelicanAllocationId,
            pelicanPasswordCiphertext
         FROM purchases
         WHERE id = 1`
    );

    assert.equal(purchase.fulfillmentStatus, "pending_activation");
    assert.equal(purchase.pelicanUserId, "321");
    assert.equal(purchase.pelicanServerId, "654");
    assert.equal(purchase.pelicanServerIdentifier, "srv_adapter");
    assert.equal(purchase.pelicanAllocationId, "9001");
    assert.equal(purchase.pelicanPasswordCiphertext, null);

    const allocatedServer = await getQuery(
        "SELECT status, allocatedAt FROM servers WHERE id = ?",
        [server.id]
    );
    assert.equal(allocatedServer.status, "allocated");
    assert.ok(Number(allocatedServer.allocatedAt) > 0);
});

test("setup status exposes curated Minecraft versions and repeat-customer Pelican reuse", async t => {
    const app = await createTestApp(t);
    const { runQuery, getQuery } = app.queries;

    await runQuery(
        `INSERT INTO customerPelicanLinks
            (stripeCustomerId, pelicanUserId, pelicanUsername, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
        [
            "cus_repeat_customer",
            "pelican-user-123",
            "linked_player",
            Date.now(),
            Date.now()
        ]
    );

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeCustomerId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            3,
            "repeat@example.com",
            "",
            "paid",
            "cus_repeat_customer",
            Date.now(),
            "setup_token_repeat_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 3]);

    const statusRes = await app.request("/api/setup-status", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: "setup_session=setup_token_repeat_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({})
    });
    assert.equal(statusRes.status, 200);

    const statusData = await statusRes.json();
    assert.equal(statusData.ready, true);
    assert.equal(statusData.pelicanAccountMode, "reuse");
    assert.equal(statusData.pelicanUsername, "linked_player");
    assert.ok(Array.isArray(statusData.minecraftVersions));
    assert.ok(statusData.minecraftVersions.some(entry => entry.minecraftVersion === "1.21.11"));
    assert.ok(statusData.minecraftVersions.some(entry => entry.minecraftVersion === "1.19.4"));

    const completeRes = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: "setup_session=setup_token_repeat_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverName: "Repeat Server",
            minecraftVersion: "1.19.4",
            pelicanUsername: "ignored_override"
        })
    });
    assert.equal(completeRes.status, 200);

    const purchase = await getQuery(
        `SELECT
            pelicanUserId,
            pelicanUsername,
            runtimeProfileCode,
            runtimeJavaVersion,
            pelicanPasswordCiphertext
         FROM purchases
         WHERE id = 1`
    );
    assert.equal(purchase.pelicanUserId, "pelican-user-123");
    assert.equal(purchase.pelicanUsername, "linked_player");
    assert.equal(purchase.runtimeProfileCode, "paper-java17");
    assert.equal(purchase.runtimeJavaVersion, 17);
    assert.equal(purchase.pelicanPasswordCiphertext, null);

    const job = await getQuery(
        `SELECT payloadJson
         FROM fulfillmentQueue
         WHERE purchaseId = 1`
    );
    assert.match(job.payloadJson, /linked_player/);
    assert.match(job.payloadJson, /reuse/);
});

test("first-time setup rejects Pelican usernames already claimed locally", async t => {
    const app = await createTestApp(t);
    const { runQuery } = app.queries;

    await runQuery(
        `INSERT INTO customerPelicanLinks
            (stripeCustomerId, pelicanUserId, pelicanUsername, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
        [
            "cus_existing",
            "pelican-existing",
            "claimed_name",
            Date.now(),
            Date.now()
        ]
    );

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeCustomerId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            4,
            "new@example.com",
            "",
            "paid",
            "cus_new_customer",
            Date.now(),
            "setup_token_claim_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 4]);

    const res = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: "setup_session=setup_token_claim_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverName: "Collision Server",
            minecraftVersion: "1.21.11",
            pelicanUsername: "claimed_name",
            pelicanPassword: "collision-password"
        })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /already claimed/i);
});

test("setup reserves hostname slugs from server names and rejects duplicates", async t => {
    const app = await createTestApp(t);
    const { runQuery } = app.queries;

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, hostnameReservationKey, hostname, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            1,
            "existing-host@example.com",
            "Dragon Keep",
            "paid",
            "dragon-keep",
            "dragon-keep.oberyn.net",
            Date.now(),
            "setup_token_existing_host_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 1]);

    await runQuery(
        `INSERT INTO purchases
            (serverId, email, serverName, status, stripeCustomerId, createdAt, setupToken, setupTokenExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            2,
            "new-host@example.com",
            "",
            "paid",
            "cus_new_host",
            Date.now(),
            "setup_token_new_host_abcdefghijklmnopqrstuvwxyz",
            Date.now() + 60_000
        ]
    );
    await runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", 2]);

    const res = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: "setup_session=setup_token_new_host_abcdefghijklmnopqrstuvwxyz",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverName: "Dragon Keep",
            minecraftVersion: "1.21.11",
            pelicanUsername: "new_host_customer",
            pelicanPassword: "new-host-password"
        })
    });

    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /hostname.*reserved/i);
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
        pelicanEnv: {
            PELICAN_PANEL_URL: "https://panel.oberyn.net"
        },
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

    const earlyCompleteRes = await app.request("/api/complete", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ purchaseId: 1, adminNote: "Too early", routingVerified: true })
    });
    assert.equal(earlyCompleteRes.status, 400);
    assert.match((await earlyCompleteRes.json()).error, /pending activation/);

    const routingArtifact = {
        kind: "haproxy_desired_mapping",
        version: 1,
        hostname: "completion-test.oberyn.net",
        provisioningTargetCode: "paper-launch-default",
        purchaseId: 1,
        pelicanServerIdentifier: "srv_complete",
        pelicanAllocationId: "9009",
        generatedAt: Date.now()
    };

    await runQuery(
        `UPDATE purchases
         SET serverName = ?,
             hostname = ?,
             hostnameReservationKey = ?,
             setupStatus = ?,
             fulfillmentStatus = ?,
             pelicanUserId = ?,
             pelicanUsername = ?,
             pelicanServerId = ?,
             pelicanServerIdentifier = ?,
             pelicanAllocationId = ?,
             desiredRoutingArtifactJson = ?,
             desiredRoutingArtifactGeneratedAt = ?,
             updatedAt = ?
         WHERE id = ?`,
        [
            "Completion Test",
            "completion-test.oberyn.net",
            "completion-test",
            "setup_submitted",
            "pending_activation",
            "pelican-user-complete",
            "complete_customer",
            "pelican-server-complete",
            "srv_complete",
            "9009",
            JSON.stringify(routingArtifact),
            Date.now(),
            Date.now(),
            1
        ]
    );
    await runQuery(
        "UPDATE servers SET status = ?, allocatedAt = ? WHERE id = ?",
        ["allocated", Date.now(), 4]
    );

    const unverifiedReleaseRes = await app.request("/api/complete", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ purchaseId: 1, adminNote: "Routing not confirmed" })
    });
    assert.equal(unverifiedReleaseRes.status, 400);
    assert.match((await unverifiedReleaseRes.json()).error, /routing verification/i);

    const completeRes = await app.request("/api/complete", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: adminCookie,
            origin: app.baseUrl
        },
        body: JSON.stringify({ purchaseId: 1, adminNote: "Delivered", routingVerified: true })
    });
    assert.equal(completeRes.status, 200);

    const purchase = await getQuery(
        `SELECT
            status,
            fulfillmentStatus,
            stripeSubscriptionId,
            stripeSubscriptionStatus,
            stripeCurrentPeriodEnd,
            routingVerifiedAt,
            readyEmailQueuedAt
         FROM purchases WHERE id = 1`
    );
    assert.equal(purchase.status, "completed");
    assert.equal(purchase.fulfillmentStatus, "ready");
    assert.equal(purchase.stripeSubscriptionId, "sub_test_admin_complete");
    assert.equal(purchase.stripeSubscriptionStatus, "active");
    assert.equal(purchase.stripeCurrentPeriodEnd, 1_900_000_200_000);
    assert.ok(Number(purchase.routingVerifiedAt) > 0);
    assert.ok(Number(purchase.readyEmailQueuedAt) > 0);

    const server = await getQuery("SELECT status FROM servers WHERE id = 4");
    assert.equal(server.status, "allocated");

    const readyEmail = await getQuery(
        `SELECT
            kind,
            state,
            idempotencyKey,
            recipientEmail,
            senderEmail,
            subject,
            bodyText,
            payloadJson
         FROM emailOutbox
         WHERE purchaseId = ?`,
        [1]
    );
    assert.equal(readyEmail.kind, "ready_access");
    assert.equal(readyEmail.state, "queued");
    assert.equal(readyEmail.idempotencyKey, "purchase:1:email:ready_access");
    assert.equal(readyEmail.recipientEmail, "operator-check@example.com");
    assert.equal(readyEmail.senderEmail, "support@oberynn.com");
    assert.match(readyEmail.subject, /Completion Test/);
    assert.match(readyEmail.bodyText, /https:\/\/panel\.oberyn\.net/);
    assert.match(readyEmail.bodyText, /complete_customer/);
    assert.doesNotMatch(readyEmail.bodyText, /password/i);
    assert.equal(JSON.parse(readyEmail.payloadJson).pelicanUsername, "complete_customer");

    const auditRows = await allQuery(
        "SELECT actionType, note FROM adminAuditLog WHERE purchaseId = 1 ORDER BY id ASC"
    );
    assert.deepEqual(
        auditRows.map(row => row.actionType),
        ["reconcile_stripe", "release_ready"]
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
