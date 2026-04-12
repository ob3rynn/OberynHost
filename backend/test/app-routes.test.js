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

    assert.equal(byType["2GB"].available, 20);
    assert.equal(byType["4GB"].available, 2);
    assert.match(byType["2GB"].features.join(" "), /Paper server software/);

    await runQuery("UPDATE servers SET status = ? WHERE type = ?", ["held", "4GB"]);

    const soldOutRes = await app.request("/api/plans");
    assert.equal(soldOutRes.status, 200);

    const soldOutPlans = await soldOutRes.json();
    const soldOutByType = Object.fromEntries(soldOutPlans.map(plan => [plan.type, plan]));

    assert.equal(soldOutByType["4GB"].available, 0);
    assert.equal(soldOutByType["4GB"].price, 31.98);
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
        body: JSON.stringify({ planType: "2GB" })
    });

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.url, "https://checkout.stripe.test/success");
    assert.match(app.parseSetCookie(res), /setup_session=/);
    assert.equal(app.stripeState.lastCreatedSessionParams.mode, "subscription");
    assert.equal(app.stripeState.lastCreatedSessionParams.line_items[0].price, "price_test_2gb");

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
        body: JSON.stringify({ planType: "2GB" })
    });
    const setupCookie = app.parseSetCookie(checkoutRes);

    const resumeRes = await app.request("/api/resume-checkout", {
        headers: { cookie: setupCookie }
    });
    assert.equal(resumeRes.status, 200);

    const resumeData = await resumeRes.json();
    assert.equal(resumeData.resumable, true);
    assert.equal(resumeData.planType, "2GB");
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
        body: JSON.stringify({ planType: "2GB" })
    });
    const setupCookie = app.parseSetCookie(firstRes);

    const secondRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie
        },
        body: JSON.stringify({ planType: "2GB" })
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

test("retrying with a different server type offers the existing checkout instead of taking a second hold", async t => {
    let createCount = 0;
    const app = await createTestApp(t, {
        stripe: {
            createSession: async () => {
                createCount += 1;
                return {
                    id: "cs_test_resume_conflict",
                    url: "https://checkout.stripe.test/resume-conflict"
                };
            },
            retrieveSession: async id => ({
                id,
                status: "open",
                payment_status: "unpaid",
                url: "https://checkout.stripe.test/resume-conflict"
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
        body: JSON.stringify({ planType: "2GB" })
    });
    const setupCookie = app.parseSetCookie(firstRes);

    const secondRes = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie: setupCookie
        },
        body: JSON.stringify({ planType: "4GB" })
    });
    assert.equal(secondRes.status, 409);

    const secondData = await secondRes.json();
    assert.equal(secondData.existingPlanType, "2GB");
    assert.equal(secondData.resumeUrl, "https://checkout.stripe.test/resume-conflict");
    assert.equal(createCount, 1);

    const purchaseCount = await getQuery("SELECT COUNT(*) AS count FROM purchases");
    assert.equal(purchaseCount.count, 1);

    const held4Gb = await getQuery(
        "SELECT COUNT(*) AS count FROM servers WHERE type = ? AND status = ?",
        ["4GB", "held"]
    );
    assert.equal(held4Gb.count, 0);
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
        body: JSON.stringify({ planType: "2GB" })
    });
    assert.equal(foreignOrigin.status, 403);

    await runQuery("UPDATE servers SET status = ? WHERE type = ?", ["held", "4GB"]);
    const soldOut = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "4GB" })
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
        body: JSON.stringify({ planType: "4GB" })
    });

    assert.equal(res.status, 500);

    const purchase = await getQuery(
        "SELECT id, serverId, status FROM purchases ORDER BY id DESC LIMIT 1"
    );
    assert.equal(purchase.status, "cancelled");

    const server = await getQuery("SELECT status FROM servers WHERE id = ?", [purchase.serverId]);
    assert.equal(server.status, "available");
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
                            price: { id: "price_test_2gb" }
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
        body: JSON.stringify({ planType: "2GB" })
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
                    planType: "2GB"
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
    assert.equal(paidPurchase.stripePriceId, "price_test_2gb");

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
            "price_test_2gb"
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
                                price: { id: "price_test_2gb" }
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
                            price: { id: "price_test_2gb" }
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
