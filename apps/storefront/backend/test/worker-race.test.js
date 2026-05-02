const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestApp } = require("./helpers/testApp");
const { assertCoreBusinessInvariants } = require("./helpers/invariants");

async function seedQueuedPurchase(app, options = {}) {
    const { getQuery, runQuery } = app.queries;
    const server = await getQuery(
        `SELECT id, type, productCode, inventoryBucketCode, nodeGroupCode,
                provisioningTargetCode, runtimeFamily, runtimeTemplate
         FROM servers
         WHERE id = ?`,
        [options.serverId || 1]
    );
    const setupToken = options.setupToken || `setup_token_worker_race_${server.id}_abcdefghijklmnopqrstuvwxyz`;

    await runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeCustomerId, createdAt,
                setupToken, setupTokenExpiresAt, planType, productCode,
                inventoryBucketCode, nodeGroupCode, provisioningTargetCode,
                runtimeFamily, runtimeTemplate, paidAt, updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            server.id,
            options.email || "worker-race@example.com",
            "",
            "paid",
            options.stripeCustomerId || "cus_worker_race",
            Date.now(),
            setupToken,
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

    const setup = await app.request("/api/complete-setup", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: `setup_session=${setupToken}`,
            origin: app.baseUrl
        },
        body: JSON.stringify({
            serverName: options.serverName || "Worker Race",
            minecraftVersion: options.minecraftVersion || "1.21.11",
            pelicanUsername: options.pelicanUsername || "worker_race_customer",
            pelicanPassword: options.pelicanPassword || "worker-race-password"
        })
    });
    assert.equal(setup.status, 200);

    return getQuery("SELECT * FROM purchases WHERE id = 1");
}

test("two workers racing for one queued job produce a single lease", async t => {
    const app = await createTestApp(t);
    await seedQueuedPurchase(app);

    const { leaseNextFulfillmentJob } = require("../services/fulfillmentQueue");
    const [first, second] = await Promise.all([
        leaseNextFulfillmentJob({ now: 1_900_000_000_000 }),
        leaseNextFulfillmentJob({ now: 1_900_000_000_000 })
    ]);
    const leased = [first, second].filter(Boolean);

    assert.equal(leased.length, 1);
    assert.equal(leased[0].purchaseId, 1);
    assert.equal(leased[0].queueState, "leased");
    assert.ok(leased[0].leaseKey);

    const queueRows = await app.queries.allQuery("SELECT state, leaseKey FROM fulfillmentQueue");
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].state, "leased");
    assert.equal(queueRows[0].leaseKey, leased[0].leaseKey);

    await assertCoreBusinessInvariants(app.queries);
});

test("stale worker finalization cannot complete a job after losing its lease", async t => {
    const app = await createTestApp(t);
    await seedQueuedPurchase(app);

    const {
        completeLeasedProvisioningJob,
        leaseNextFulfillmentJob
    } = require("../services/fulfillmentQueue");
    const job = await leaseNextFulfillmentJob({ now: 1_900_000_100_000 });
    assert.ok(job);

    const staleCompletion = await completeLeasedProvisioningJob(
        { ...job, leaseKey: "stale_lease_key" },
        {
            pelicanUserId: "pelican-user-stale",
            pelicanUsername: "worker_race_customer",
            pelicanServerId: "pelican-server-stale",
            pelicanServerIdentifier: "srv_stale",
            pelicanAllocationId: "allocation-stale"
        },
        {
            kind: "haproxy_desired_mapping",
            version: 1,
            hostname: "worker-race.oberyn.net",
            provisioningTargetCode: "paper-launch-default",
            purchaseId: 1,
            pelicanServerIdentifier: "srv_stale",
            pelicanAllocationId: "allocation-stale",
            generatedAt: 1_900_000_100_000
        },
        { now: 1_900_000_100_000 }
    );
    assert.equal(staleCompletion, false);

    const purchase = await app.queries.getQuery(
        "SELECT fulfillmentStatus, pelicanServerId, workerLeaseKey FROM purchases WHERE id = ?",
        [1]
    );
    assert.equal(purchase.fulfillmentStatus, "provisioning");
    assert.equal(purchase.pelicanServerId, null);
    assert.equal(purchase.workerLeaseKey, job.leaseKey);

    const realCompletion = await completeLeasedProvisioningJob(
        job,
        {
            pelicanUserId: "pelican-user-real",
            pelicanUsername: "worker_race_customer",
            pelicanServerId: "pelican-server-real",
            pelicanServerIdentifier: "srv_real",
            pelicanAllocationId: "allocation-real"
        },
        {
            kind: "haproxy_desired_mapping",
            version: 1,
            hostname: "worker-race.oberyn.net",
            provisioningTargetCode: "paper-launch-default",
            purchaseId: 1,
            pelicanServerIdentifier: "srv_real",
            pelicanAllocationId: "allocation-real",
            generatedAt: 1_900_000_101_000
        },
        { now: 1_900_000_101_000 }
    );
    assert.equal(realCompletion, true);

    const completed = await app.queries.getQuery(
        `SELECT fulfillmentStatus, pelicanServerId, pelicanPasswordCiphertext,
                workerLeaseKey, workerLeaseExpiresAt
         FROM purchases WHERE id = ?`,
        [1]
    );
    assert.equal(completed.fulfillmentStatus, "pending_activation");
    assert.equal(completed.pelicanServerId, "pelican-server-real");
    assert.equal(completed.pelicanPasswordCiphertext, null);
    assert.equal(completed.workerLeaseKey, null);
    assert.equal(completed.workerLeaseExpiresAt, null);

    await assertCoreBusinessInvariants(app.queries);
});

test("duplicate provisioning enqueue and admin requeue attempts keep one active job", async t => {
    const app = await createTestApp(t);
    const purchase = await seedQueuedPurchase(app);
    const { enqueueProvisioningJobForPurchase } = require("../services/fulfillmentQueue");

    await enqueueProvisioningJobForPurchase(purchase, { now: 1_900_000_200_000 });
    await enqueueProvisioningJobForPurchase(purchase, { now: 1_900_000_201_000 });

    const count = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM fulfillmentQueue WHERE purchaseId = ?",
        [purchase.id]
    );
    assert.equal(count.count, 1);

    const queueRow = await app.queries.getQuery(
        "SELECT state, attempts, idempotencyKey FROM fulfillmentQueue WHERE purchaseId = ?",
        [purchase.id]
    );
    assert.equal(queueRow.state, "queued");
    assert.equal(queueRow.attempts, 0);
    assert.equal(queueRow.idempotencyKey, "purchase:1:task:provision_initial_server");

    await assertCoreBusinessInvariants(app.queries);
});

test("external success followed by unsafe local finalization dead-letters without allocating the slot", async t => {
    const app = await createTestApp(t);
    await seedQueuedPurchase(app, {
        serverName: "Worker Dead Letter",
        pelicanUsername: "worker_deadletter"
    });

    const { runFulfillmentWorkerIteration } = require("../workers/fulfillmentWorker");
    const iteration = await runFulfillmentWorkerIteration({
        provisionInitialServer: async () => ({
            pelicanUserId: "pelican-user-deadletter",
            pelicanUsername: "worker_deadletter",
            pelicanServerId: "pelican-server-deadletter",
            pelicanServerIdentifier: "srv_deadletter",
            pelicanAllocationId: "allocation-deadletter"
        }),
        completeProvisioningJob: async () => false
    });

    assert.equal(iteration.outcome, "dead_letter");

    const purchase = await app.queries.getQuery(
        `SELECT fulfillmentStatus, pelicanServerId, desiredRoutingArtifactJson,
                pelicanPasswordCiphertext
         FROM purchases WHERE id = ?`,
        [1]
    );
    const server = await app.queries.getQuery("SELECT status, allocatedAt FROM servers WHERE id = ?", [1]);
    assert.equal(purchase.fulfillmentStatus, "dead_letter");
    assert.equal(purchase.pelicanServerId, null);
    assert.equal(purchase.desiredRoutingArtifactJson, null);
    assert.ok(purchase.pelicanPasswordCiphertext);
    assert.equal(server.status, "held");
    assert.equal(server.allocatedAt, null);

    await assertCoreBusinessInvariants(app.queries);
});
