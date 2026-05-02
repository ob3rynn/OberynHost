const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");

async function login(app) {
    const res = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ key: "test-admin-key" })
    });
    assert.equal(res.status, 200);
    return app.parseSetCookie(res);
}

function buildPlan(overrides = {}) {
    return {
        planKey: "paper-4gb",
        publicName: "4GB Paper Minecraft Server",
        publicDescription: "A larger generated Paper Minecraft server plan.",
        runtimeFamily: "paper",
        containerMemoryMb: 4448,
        jvmMemoryMb: 4048,
        diskMb: 20480,
        stripePriceId: "price_test_paper_4gb",
        totalSlots: 2,
        purchaseEnabled: true,
        provisioningProfileCode: "paper-launch-default",
        features: "4GB Paper Minecraft server\nGuided setup",
        active: false,
        storefrontVisible: false,
        ...overrides
    };
}

test("admin plan builder endpoints validate, save, list, and audit generated plans", async t => {
    const app = await createTestApp(t);
    const { getQuery } = app.queries;

    const forbidden = await app.request("/api/admin/plans");
    assert.equal(forbidden.status, 401);

    const cookie = await login(app);
    const invalidPreview = await app.request("/api/admin/plans/preview", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ planKey: "Bad Key" })
    });
    assert.equal(invalidPreview.status, 200);
    assert.equal((await invalidPreview.json()).validation.valid, false);

    const preview = await app.request("/api/admin/plans/preview", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify(buildPlan())
    });
    assert.equal(preview.status, 200);
    const previewPayload = await preview.json();
    assert.equal(previewPayload.definition.productCode, "minecraft-paper-4gb");
    assert.equal(previewPayload.definition.inventory.bucketCode, "paper-4gb-bucket");
    assert.equal(previewPayload.definition.inventory.displayName, "4GB Paper Minecraft Server Bucket");
    assert.equal(previewPayload.definition.provisioning.targetCode, "paper-launch-default");
    assert.equal(previewPayload.definition.runtime.cpuLimit, 0);
    assert.equal(previewPayload.definition.public.priceLabel, "Draft price pending");
    assert.equal(previewPayload.definition.public.priceAmount, 0);
    assert.equal(previewPayload.definition.sortOrder, 20);
    assert.ok(previewPayload.definition.runtime.supportedVersions.includes("1.21.11"));
    assert.ok(previewPayload.definition.runtime.supportedVersions.includes("1.17"));

    const create = await app.request("/api/admin/plans", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify(buildPlan())
    });
    assert.equal(create.status, 201);

    const list = await app.request("/api/admin/plans", {
        headers: { cookie }
    });
    const plans = await list.json();
    assert.ok(plans.some(plan => plan.planKey === "paper-4gb"));
    assert.equal(plans.find(plan => plan.planKey === "paper-4gb").definition.sortOrder, 20);

    const edit = await app.request("/api/admin/plans/paper-4gb", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ publicDescription: "Edited description." })
    });
    assert.equal(edit.status, 200);
    assert.equal((await edit.json()).plan.sortOrder, 20);

    const audit = await getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE entityType = ? AND entityCode = ? AND actionType = ?",
        ["plan", "paper-4gb", "plan_save"]
    );
    assert.equal(audit.count, 1);
});

test("inactive draft plans can save without Stripe but cannot be activated without it", async t => {
    const app = await createTestApp(t);
    const cookie = await login(app);

    const draft = await app.request("/api/admin/plans", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify(buildPlan({
            planKey: "paper-draft",
            publicName: "Draft Paper Server",
            stripePriceId: "",
            active: false,
            storefrontVisible: false
        }))
    });
    assert.equal(draft.status, 201);

    const activate = await app.request("/api/admin/plans/paper-draft", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ active: true })
    });
    assert.equal(activate.status, 400);
});

test("active plan activation requires valid recurring Stripe price metadata", async t => {
    const inactiveStripeApp = await createTestApp(t, {
        stripe: {
            retrievePrice: async id => ({
                id,
                active: false,
                currency: "usd",
                unit_amount: 1997,
                type: "recurring",
                recurring: { interval: "month", interval_count: 1 }
            })
        }
    });
    const inactiveCookie = await login(inactiveStripeApp);
    const blocked = await inactiveStripeApp.request("/api/admin/plans", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: inactiveStripeApp.baseUrl,
            cookie: inactiveCookie
        },
        body: JSON.stringify(buildPlan({ active: true, storefrontVisible: true }))
    });
    assert.equal(blocked.status, 400);

    const validApp = await createTestApp(t);
    const validCookie = await login(validApp);
    const created = await validApp.request("/api/admin/plans", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: validApp.baseUrl,
            cookie: validCookie
        },
        body: JSON.stringify(buildPlan({ active: true, storefrontVisible: true }))
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    assert.equal(createdPayload.plan.public.priceAmount, 11.97);
    assert.equal(createdPayload.plan.public.priceLabel, "$11.97/month");
    assert.equal(createdPayload.plan.stripe.priceMetadata.currency, "usd");
});

test("checkout snapshots generated plan and Stripe price facts before later edits", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_snapshot",
            url: "https://checkout.stripe.test/snapshot"
        }
    });
    const { getQuery } = app.queries;
    const cookie = await login(app);

    const checkout = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "paper-2gb" })
    });
    assert.equal(checkout.status, 200);

    const purchase = await getQuery("SELECT * FROM purchases WHERE stripeSessionId = ?", [
        "cs_test_snapshot"
    ]);
    const planSnapshot = JSON.parse(purchase.planSnapshotJson);
    const stripeSnapshot = JSON.parse(purchase.stripePriceSnapshotJson);
    assert.equal(planSnapshot.planKey, "paper-2gb");
    assert.equal(stripeSnapshot.id, "price_test_paper_2gb");

    const update = await app.request("/api/admin/plans/paper-2gb", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ public: { name: "Edited Paper Plan" } })
    });
    assert.equal(update.status, 200);

    const unchanged = await getQuery("SELECT planSnapshotJson FROM purchases WHERE id = ?", [
        purchase.id
    ]);
    assert.equal(JSON.parse(unchanged.planSnapshotJson).public.name, "2GB Paper Minecraft Server");
});

test("inventory bucket controls enforce safe reductions and audit mutations", async t => {
    const app = await createTestApp(t, {
        createdSession: {
            id: "cs_test_inventory_guard",
            url: "https://checkout.stripe.test/inventory"
        }
    });
    const { getQuery } = app.queries;
    const cookie = await login(app);

    const checkout = await app.request("/api/create-checkout", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planType: "paper-2gb" })
    });
    assert.equal(checkout.status, 200);

    const unsafe = await app.request("/api/admin/inventory-buckets/paper-2gb-launch-bucket", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ totalSlots: 0 })
    });
    assert.equal(unsafe.status, 409);

    const increase = await app.request("/api/admin/inventory-buckets/paper-2gb-launch-bucket", {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ totalSlots: 26, purchaseEnabled: false })
    });
    assert.equal(increase.status, 200);

    const audit = await getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE entityType = ? AND entityCode = ?",
        ["inventory_bucket", "paper-2gb-launch-bucket"]
    );
    assert.equal(audit.count, 1);
});

test("sold-out waitlist captures interest without mutating inventory or purchases", async t => {
    const app = await createTestApp(t);
    const { getQuery, runQuery } = app.queries;

    await runQuery("UPDATE servers SET status = ? WHERE productCode = ?", [
        "held",
        "minecraft-paper-2gb"
    ]);
    const before = await getQuery("SELECT COUNT(*) AS count FROM purchases");
    const beforeHeld = await getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = ?", ["held"]);

    const submit = await app.request("/api/waitlist", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({
            planKey: "paper-2gb",
            email: "buyer@example.com",
            name: "Buyer",
            note: "Please tell me when it opens.",
            source: "storefront"
        })
    });
    assert.equal(submit.status, 200);

    const duplicate = await app.request("/api/waitlist", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planKey: "paper-2gb", email: "buyer@example.com" })
    });
    assert.equal(duplicate.status, 200);

    const entries = await getQuery("SELECT COUNT(*) AS count FROM waitlistEntries");
    const after = await getQuery("SELECT COUNT(*) AS count FROM purchases");
    const afterHeld = await getQuery("SELECT COUNT(*) AS count FROM servers WHERE status = ?", ["held"]);
    assert.equal(entries.count, 1);
    assert.equal(after.count, before.count);
    assert.equal(afterHeld.count, beforeHeld.count);
});

test("admin waitlist and provisioning target management are admin-only and audited", async t => {
    const app = await createTestApp(t);
    const { getQuery, runQuery } = app.queries;

    const targetForbidden = await app.request("/api/admin/provisioning-targets");
    assert.equal(targetForbidden.status, 401);
    const waitlistForbidden = await app.request("/api/admin/waitlist");
    assert.equal(waitlistForbidden.status, 401);

    await runQuery("UPDATE servers SET status = ? WHERE productCode = ?", [
        "held",
        "minecraft-paper-2gb"
    ]);
    await app.request("/api/waitlist", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl
        },
        body: JSON.stringify({ planKey: "paper-2gb", email: "buyer@example.com" })
    });

    const cookie = await login(app);
    const targets = await app.request("/api/admin/provisioning-targets", {
        headers: { cookie }
    });
    assert.equal(targets.status, 200);
    assert.ok((await targets.json()).some(target => target.code === "paper-launch-default"));

    const list = await app.request("/api/admin/waitlist", {
        headers: { cookie }
    });
    const entries = await list.json();
    assert.equal(entries.length, 1);

    const update = await app.request(`/api/admin/waitlist/${entries[0].id}`, {
        method: "PATCH",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            cookie
        },
        body: JSON.stringify({ status: "notified" })
    });
    assert.equal(update.status, 200);

    const audit = await getQuery(
        "SELECT COUNT(*) AS count FROM adminAuditLog WHERE entityType = ? AND actionType = ?",
        ["waitlist_entry", "waitlist_status_update"]
    );
    assert.equal(audit.count, 1);
});
