const assert = require("node:assert/strict");

async function assertNoRows(queries, sql, params, message) {
    const rows = await queries.allQuery(sql, params);
    assert.deepEqual(rows, [], message || `Expected no rows for invariant query: ${sql}`);
}

async function assertCoreBusinessInvariants(queries) {
    const inventory = await queries.getQuery(
        `SELECT COUNT(*) AS count
         FROM servers
         WHERE productCode = ?`,
        ["minecraft-paper-2gb"]
    );
    assert.equal(Number(inventory.count), 25, "Paper launch inventory should stay fixed at 25 slots");

    await assertNoRows(
        queries,
        `SELECT serverId, COUNT(*) AS count
         FROM purchases
         WHERE serverId IS NOT NULL
           AND status NOT IN ('cancelled', 'expired')
         GROUP BY serverId
         HAVING COUNT(*) > 1`,
        [],
        "No active purchases should share one server slot"
    );

    await assertNoRows(
        queries,
        `SELECT s.id, s.status
         FROM servers s
         LEFT JOIN purchases p
           ON p.serverId = s.id
          AND p.status NOT IN ('cancelled', 'expired')
         WHERE s.status IN ('held', 'allocated')
           AND p.id IS NULL`,
        [],
        "No held or allocated server should be missing an active owning purchase"
    );

    await assertNoRows(
        queries,
        `SELECT hostnameReservationKey, COUNT(*) AS count
         FROM purchases
         WHERE hostnameReservationKey IS NOT NULL
           AND hostnameReleasedAt IS NULL
           AND status NOT IN ('cancelled', 'expired')
         GROUP BY hostnameReservationKey COLLATE NOCASE
         HAVING COUNT(*) > 1`,
        [],
        "No active hostname slug should map to more than one live purchase"
    );

    await assertNoRows(
        queries,
        `SELECT q.id, q.purchaseId
         FROM fulfillmentQueue q
         JOIN purchases p ON p.id = q.purchaseId
         WHERE q.state IN ('queued', 'leased')
           AND (
                p.productCode IS NULL OR TRIM(p.productCode) = '' OR
                p.inventoryBucketCode IS NULL OR TRIM(p.inventoryBucketCode) = '' OR
                p.nodeGroupCode IS NULL OR TRIM(p.nodeGroupCode) = '' OR
                p.provisioningTargetCode IS NULL OR TRIM(p.provisioningTargetCode) = '' OR
                p.hostname IS NULL OR TRIM(p.hostname) = '' OR
                p.hostnameReservationKey IS NULL OR TRIM(p.hostnameReservationKey) = '' OR
                p.minecraftVersion IS NULL OR TRIM(p.minecraftVersion) = '' OR
                p.runtimeProfileCode IS NULL OR TRIM(p.runtimeProfileCode) = '' OR
                p.runtimeJavaVersion IS NULL OR
                p.pelicanUsername IS NULL OR TRIM(p.pelicanUsername) = ''
           )`,
        [],
        "Queued or leased provisioning jobs should have resolved product, target, runtime, hostname, and identity data"
    );

    await assertNoRows(
        queries,
        `SELECT purchaseId, taskType, COUNT(*) AS count
         FROM fulfillmentQueue
         WHERE state IN ('queued', 'leased')
         GROUP BY purchaseId, taskType
         HAVING COUNT(*) > 1`,
        [],
        "No purchase should have duplicate active fulfillment jobs for one task kind"
    );

    await assertNoRows(
        queries,
        `SELECT id
         FROM purchases
         WHERE (status = 'completed' OR fulfillmentStatus = 'ready')
           AND (
                pelicanUserId IS NULL OR TRIM(pelicanUserId) = '' OR
                pelicanUsername IS NULL OR TRIM(pelicanUsername) = '' OR
                pelicanServerId IS NULL OR TRIM(pelicanServerId) = '' OR
                pelicanServerIdentifier IS NULL OR TRIM(pelicanServerIdentifier) = '' OR
                pelicanAllocationId IS NULL OR TRIM(pelicanAllocationId) = '' OR
                routingVerifiedAt IS NULL
           )`,
        [],
        "Ready services should have Pelican linkage and routing verification"
    );

    await assertNoRows(
        queries,
        `SELECT id
         FROM purchases
         WHERE fulfillmentStatus IN ('pending_activation', 'ready')
           AND pelicanServerId IS NOT NULL
           AND (
                pelicanPasswordCiphertext IS NOT NULL OR
                pelicanPasswordIv IS NOT NULL OR
                pelicanPasswordAuthTag IS NOT NULL OR
                pelicanPasswordStoredAt IS NOT NULL
           )`,
        [],
        "Staged Pelican passwords should be cleared after provisioning succeeds"
    );

    await assertNoRows(
        queries,
        `SELECT idempotencyKey, COUNT(*) AS count
         FROM emailOutbox
         GROUP BY idempotencyKey
         HAVING COUNT(*) > 1`,
        [],
        "Email outbox idempotency keys should be unique"
    );
}

async function getStorefrontCounts(queries) {
    const rows = await queries.allQuery(
        "SELECT status, COUNT(*) AS count FROM servers GROUP BY status"
    );
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
}

module.exports = {
    assertCoreBusinessInvariants,
    assertNoRows,
    getStorefrontCounts
};
