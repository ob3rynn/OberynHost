const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const { assertCoreBusinessInvariants } = require("./helpers/invariants");

async function seedPaidSetup(app, options = {}) {
    const serverId = options.serverId || 1;
    const setupToken = options.setupToken || `setup_token_setup_adv_${serverId}_abcdefghijklmnopqrstuvwxyz`;
    const server = await app.queries.getQuery(
        `SELECT id, type, productCode, inventoryBucketCode, nodeGroupCode,
                provisioningTargetCode, runtimeFamily, runtimeTemplate
         FROM servers
         WHERE id = ?`,
        [serverId]
    );

    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeCustomerId, createdAt,
                setupToken, setupTokenExpiresAt, paidAt, planType, productCode,
                inventoryBucketCode, nodeGroupCode, provisioningTargetCode,
                runtimeFamily, runtimeTemplate, setupStatus, fulfillmentStatus,
                serviceStatus, customerRiskStatus
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            serverId,
            options.email || `setup-adv-${serverId}@example.com`,
            options.serverName || "",
            "paid",
            options.stripeCustomerId || `cus_setup_adv_${serverId}`,
            Date.now(),
            setupToken,
            Date.now() + 60_000,
            Date.now(),
            server.type,
            server.productCode,
            server.inventoryBucketCode,
            server.nodeGroupCode,
            server.provisioningTargetCode,
            server.runtimeFamily,
            server.runtimeTemplate,
            "setup_pending",
            "not_started",
            "inactive",
            "clear"
        ]
    );
    await app.queries.runQuery("UPDATE servers SET status = ? WHERE id = ?", ["held", serverId]);

    return setupToken;
}

function completeSetup(app, token, body, index = 0) {
    return app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: `setup_session=${token}`,
            origin: app.baseUrl,
            "x-forwarded-for": `203.0.113.${index + 10}`
        },
        body: JSON.stringify({
            minecraftVersion: "1.21.11",
            pelicanUsername: `setup_adv_${index}`,
            pelicanPassword: "setup-adversarial-password",
            ...body
        }),
        userAgent: `SetupAdversarial/${index}`
    });
}

async function assertRejectedSetupLeftNoMutation(app, token) {
    const purchase = await app.queries.getQuery(
        `SELECT serverName, hostname, hostnameReservationKey, fulfillmentStatus,
                pelicanPasswordCiphertext
         FROM purchases
         WHERE setupToken = ?`,
        [token]
    );
    const jobs = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM fulfillmentQueue WHERE purchaseId = ?",
        [1]
    );

    assert.equal(purchase.serverName || "", "");
    assert.equal(purchase.hostname, null);
    assert.equal(purchase.hostnameReservationKey, null);
    assert.equal(purchase.fulfillmentStatus, "not_started");
    assert.equal(purchase.pelicanPasswordCiphertext, null);
    assert.equal(jobs.count, 0);
}

test("reserved and hostile server names are rejected without queueing provisioning work", async t => {
    const app = await createTestApp(t, { trustProxy: true });
    const token = await seedPaidSetup(app);
    const badNames = [
        "admin",
        "api",
        "panel",
        "www",
        "mail",
        "support",
        "аdmin",
        "Way Too Long ".repeat(8),
        "line\nbreak",
        "<script>alert(1)</script>",
        "Robert'); DROP TABLE purchases;--",
        "../panel"
    ];

    for (const [index, serverName] of badNames.entries()) {
        const response = await completeSetup(app, token, { serverName }, index);
        assert.equal(response.status, 400, `expected ${serverName} to be rejected`);
        const data = await response.json();
        assert.match(data.error, /server name|hostname/i);
    }

    await assertRejectedSetupLeftNoMutation(app, token);
    await assertCoreBusinessInvariants(app.queries);
});

test("normalized hostname slug collisions are rejected even when display names differ", async t => {
    const app = await createTestApp(t);
    const existingToken = await seedPaidSetup(app, {
        serverId: 1,
        setupToken: "setup_token_collision_existing_abcdefghijklmnopqrstuvwxyz",
        stripeCustomerId: "cus_collision_existing"
    });
    const newToken = await seedPaidSetup(app, {
        serverId: 2,
        setupToken: "setup_token_collision_new_abcdefghijklmnopqrstuvwxyz",
        stripeCustomerId: "cus_collision_new"
    });

    const first = await completeSetup(app, existingToken, {
        serverName: "Dragon Keep",
        pelicanUsername: "dragon_keeper"
    });
    assert.equal(first.status, 200);

    const collision = await completeSetup(app, newToken, {
        serverName: "dragon___keep",
        pelicanUsername: "dragon_keeper_two"
    });
    assert.equal(collision.status, 409);
    assert.match((await collision.json()).error, /hostname.*reserved/i);

    const newPurchase = await app.queries.getQuery(
        `SELECT serverName, hostname, fulfillmentStatus, pelicanPasswordCiphertext
         FROM purchases
         WHERE setupToken = ?`,
        [newToken]
    );
    assert.equal(newPurchase.serverName || "", "");
    assert.equal(newPurchase.hostname, null);
    assert.equal(newPurchase.fulfillmentStatus, "not_started");
    assert.equal(newPurchase.pelicanPasswordCiphertext, null);

    await assertCoreBusinessInvariants(app.queries);
});

test("repeat-customer setup cannot spoof a different Pelican username", async t => {
    const app = await createTestApp(t);
    const token = await seedPaidSetup(app, {
        serverId: 3,
        setupToken: "setup_token_repeat_spoof_abcdefghijklmnopqrstuvwxyz",
        stripeCustomerId: "cus_repeat_spoof"
    });
    await app.queries.runQuery(
        `INSERT INTO customerPelicanLinks
            (stripeCustomerId, pelicanUserId, pelicanUsername, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
        ["cus_repeat_spoof", "pelican-linked", "linked_player", Date.now(), Date.now()]
    );

    const response = await completeSetup(app, token, {
        serverName: "Repeat Spoof",
        pelicanUsername: "attacker_name",
        pelicanPassword: "ignored-password"
    });
    assert.equal(response.status, 200);

    const purchase = await app.queries.getQuery(
        `SELECT pelicanUserId, pelicanUsername, pelicanPasswordCiphertext
         FROM purchases WHERE setupToken = ?`,
        [token]
    );
    assert.equal(purchase.pelicanUserId, "pelican-linked");
    assert.equal(purchase.pelicanUsername, "linked_player");
    assert.equal(purchase.pelicanPasswordCiphertext, null);

    await assertCoreBusinessInvariants(app.queries);
});

test("first-time username collision checks are case-insensitive and leave setup editable", async t => {
    const app = await createTestApp(t);
    const token = await seedPaidSetup(app, {
        serverId: 4,
        setupToken: "setup_token_username_collision_abcdefghijklmnopqrstuvwxyz",
        stripeCustomerId: "cus_username_collision"
    });
    await app.queries.runQuery(
        `INSERT INTO customerPelicanLinks
            (stripeCustomerId, pelicanUserId, pelicanUsername, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
        ["cus_existing_case", "pelican-existing", "Claimed_Name", Date.now(), Date.now()]
    );

    const response = await completeSetup(app, token, {
        serverName: "Username Collision",
        pelicanUsername: "claimed_name"
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /already claimed/i);

    const purchase = await app.queries.getQuery(
        `SELECT serverName, hostname, fulfillmentStatus, pelicanPasswordCiphertext
         FROM purchases WHERE setupToken = ?`,
        [token]
    );
    assert.equal(purchase.serverName || "", "");
    assert.equal(purchase.hostname, null);
    assert.equal(purchase.fulfillmentStatus, "not_started");
    assert.equal(purchase.pelicanPasswordCiphertext, null);

    await assertCoreBusinessInvariants(app.queries);
});
