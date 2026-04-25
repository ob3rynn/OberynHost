const config = require("../config");
const db = require("./index");
const { SERVER_STATUS, PURCHASE_STATUS } = require("../constants/status");
const { PLAN_DEFINITIONS } = require("../config/plans");
const { mergeLifecycleState } = require("../services/lifecycle");

const [LAUNCH_PLAN_TYPE, LAUNCH_PLAN] = Object.entries(PLAN_DEFINITIONS)[0] || [];

function runStatement(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) {
                reject(err);
                return;
            }

            resolve(this);
        });
    });
}

function getRow(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(row);
        });
    });
}

function getAllRows(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(rows);
        });
    });
}

async function addColumnIfMissing(tableName, columnNames, columnName, definition) {
    if (columnNames.has(columnName)) {
        return;
    }

    await runStatement(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    columnNames.add(columnName);
}

async function upsertCatalogRow(tableName, keyColumn, columns, values) {
    const assignments = columns
        .filter(column => column !== keyColumn)
        .map(column => `${column} = excluded.${column}`)
        .join(", ");
    const placeholders = columns.map(() => "?").join(", ");

    await runStatement(
        `INSERT INTO ${tableName} (${columns.join(", ")})
         VALUES (${placeholders})
         ON CONFLICT(${keyColumn}) DO UPDATE SET ${assignments}`,
        values
    );
}

async function seedLaunchCatalog() {
    if (!LAUNCH_PLAN_TYPE || !LAUNCH_PLAN) {
        throw new Error("Launch plan configuration is missing.");
    }

    await upsertCatalogRow(
        "products",
        "code",
        [
            "code",
            "planType",
            "displayName",
            "price",
            "productFamily",
            "runtimeFamily",
            "runtimeTemplate",
            "inventoryBucketCode",
            "nodeGroupCode",
            "provisioningTargetCode",
            "launchSlotCount",
            "active",
            "releaseGateMode"
        ],
        [
            LAUNCH_PLAN.code,
            LAUNCH_PLAN_TYPE,
            LAUNCH_PLAN.displayName,
            LAUNCH_PLAN.price,
            LAUNCH_PLAN.productFamily,
            LAUNCH_PLAN.runtimeFamily,
            LAUNCH_PLAN.runtimeTemplate,
            LAUNCH_PLAN.inventoryBucketCode,
            LAUNCH_PLAN.nodeGroupCode,
            LAUNCH_PLAN.provisioningTargetCode,
            LAUNCH_PLAN.launchSlotCount,
            1,
            "admin_release"
        ]
    );

    await upsertCatalogRow(
        "inventoryBuckets",
        "code",
        [
            "code",
            "productCode",
            "displayName",
            "capacityTarget",
            "reservationPolicy",
            "releasePolicy",
            "active"
        ],
        [
            LAUNCH_PLAN.inventoryBucketCode,
            LAUNCH_PLAN.code,
            "Paper 3GB Launch Bucket",
            LAUNCH_PLAN.launchSlotCount,
            "reserve_on_checkout",
            "release_on_expire_or_cancel",
            1
        ]
    );

    await upsertCatalogRow(
        "nodeGroups",
        "code",
        [
            "code",
            "displayName",
            "runtimeFamily",
            "allocationMode",
            "active"
        ],
        [
            LAUNCH_PLAN.nodeGroupCode,
            "Paper Launch Group",
            LAUNCH_PLAN.runtimeFamily,
            "manual_edge_apply",
            1
        ]
    );

    await upsertCatalogRow(
        "provisioningTargets",
        "code",
        [
            "code",
            "nodeGroupCode",
            "displayName",
            "runtimeFamily",
            "operatorMode",
            "active"
        ],
        [
            LAUNCH_PLAN.provisioningTargetCode,
            LAUNCH_PLAN.nodeGroupCode,
            "Paper Launch Default Target",
            LAUNCH_PLAN.runtimeFamily,
            "operator_release_gate",
            1
        ]
    );
}

async function seedLaunchInventory() {
    const currentRow = await getRow(
        `SELECT COUNT(*) AS count
         FROM servers
         WHERE productCode = ?
            OR (productCode IS NULL AND type = ?)`,
        [LAUNCH_PLAN.code, LAUNCH_PLAN_TYPE]
    );
    const existingCount = Number(currentRow?.count || 0);
    const targetCount = Number(LAUNCH_PLAN.launchSlotCount || 0);

    await runStatement(
        `UPDATE servers
         SET type = ?,
             price = ?,
             productCode = ?,
             inventoryBucketCode = ?,
             nodeGroupCode = ?,
             provisioningTargetCode = ?,
             runtimeFamily = ?,
             runtimeTemplate = ?
         WHERE productCode = ?
            OR (productCode IS NULL AND type = ?)`,
        [
            LAUNCH_PLAN_TYPE,
            LAUNCH_PLAN.price,
            LAUNCH_PLAN.code,
            LAUNCH_PLAN.inventoryBucketCode,
            LAUNCH_PLAN.nodeGroupCode,
            LAUNCH_PLAN.provisioningTargetCode,
            LAUNCH_PLAN.runtimeFamily,
            LAUNCH_PLAN.runtimeTemplate,
            LAUNCH_PLAN.code,
            LAUNCH_PLAN_TYPE
        ]
    );

    for (let index = existingCount; index < targetCount; index += 1) {
        await runStatement(
            `INSERT INTO servers
                (
                    type,
                    price,
                    status,
                    productCode,
                    inventoryBucketCode,
                    nodeGroupCode,
                    provisioningTargetCode,
                    runtimeFamily,
                    runtimeTemplate
                )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                LAUNCH_PLAN_TYPE,
                LAUNCH_PLAN.price,
                SERVER_STATUS.AVAILABLE,
                LAUNCH_PLAN.code,
                LAUNCH_PLAN.inventoryBucketCode,
                LAUNCH_PLAN.nodeGroupCode,
                LAUNCH_PLAN.provisioningTargetCode,
                LAUNCH_PLAN.runtimeFamily,
                LAUNCH_PLAN.runtimeTemplate
            ]
        );
    }
}

async function backfillPurchaseCatalogFields() {
    await runStatement(
        `UPDATE purchases
         SET planType = COALESCE(
                planType,
                (SELECT type FROM servers WHERE servers.id = purchases.serverId)
             ),
             productCode = COALESCE(
                productCode,
                (SELECT productCode FROM servers WHERE servers.id = purchases.serverId)
             ),
             inventoryBucketCode = COALESCE(
                inventoryBucketCode,
                (SELECT inventoryBucketCode FROM servers WHERE servers.id = purchases.serverId)
             ),
             nodeGroupCode = COALESCE(
                nodeGroupCode,
                (SELECT nodeGroupCode FROM servers WHERE servers.id = purchases.serverId)
             ),
             provisioningTargetCode = COALESCE(
                provisioningTargetCode,
                (SELECT provisioningTargetCode FROM servers WHERE servers.id = purchases.serverId)
             ),
             runtimeFamily = COALESCE(
                runtimeFamily,
                (SELECT runtimeFamily FROM servers WHERE servers.id = purchases.serverId)
             ),
             runtimeTemplate = COALESCE(
                runtimeTemplate,
                (SELECT runtimeTemplate FROM servers WHERE servers.id = purchases.serverId)
             )`
    );
}

async function backfillLifecycleFields() {
    const purchases = await getAllRows("SELECT * FROM purchases");

    for (const purchase of purchases) {
        const nextPurchase = mergeLifecycleState(purchase);

        await runStatement(
            `UPDATE purchases
             SET setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 customerRiskStatus = ?
             WHERE id = ?`,
            [
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                nextPurchase.customerRiskStatus,
                purchase.id
            ]
        );
    }
}

const ready = (async () => {
    try {
        await runStatement(`
            CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY,
                type TEXT,
                price REAL,
                status TEXT
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS products (
                code TEXT PRIMARY KEY,
                planType TEXT NOT NULL UNIQUE,
                displayName TEXT NOT NULL,
                price REAL NOT NULL,
                productFamily TEXT NOT NULL,
                runtimeFamily TEXT NOT NULL,
                runtimeTemplate TEXT NOT NULL,
                inventoryBucketCode TEXT NOT NULL,
                nodeGroupCode TEXT NOT NULL,
                provisioningTargetCode TEXT NOT NULL,
                launchSlotCount INTEGER NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                releaseGateMode TEXT NOT NULL
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS inventoryBuckets (
                code TEXT PRIMARY KEY,
                productCode TEXT NOT NULL,
                displayName TEXT NOT NULL,
                capacityTarget INTEGER NOT NULL,
                reservationPolicy TEXT NOT NULL,
                releasePolicy TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(productCode) REFERENCES products(code)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS nodeGroups (
                code TEXT PRIMARY KEY,
                displayName TEXT NOT NULL,
                runtimeFamily TEXT NOT NULL,
                allocationMode TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS provisioningTargets (
                code TEXT PRIMARY KEY,
                nodeGroupCode TEXT NOT NULL,
                displayName TEXT NOT NULL,
                runtimeFamily TEXT NOT NULL,
                operatorMode TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(nodeGroupCode) REFERENCES nodeGroups(code)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                serverId INTEGER,
                email TEXT,
                serverName TEXT,
                status TEXT,
                stripeSessionId TEXT,
                createdAt INTEGER
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS customerPelicanLinks (
                stripeCustomerId TEXT PRIMARY KEY,
                pelicanUserId TEXT,
                pelicanUsername TEXT NOT NULL COLLATE NOCASE,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS fulfillmentQueue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchaseId INTEGER NOT NULL,
                taskType TEXT NOT NULL,
                state TEXT NOT NULL,
                idempotencyKey TEXT NOT NULL,
                payloadJson TEXT,
                availableAt INTEGER NOT NULL,
                lockedAt INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                lastError TEXT,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                FOREIGN KEY(purchaseId) REFERENCES purchases(id)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS emailOutbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchaseId INTEGER,
                kind TEXT NOT NULL,
                state TEXT NOT NULL,
                idempotencyKey TEXT NOT NULL,
                recipientEmail TEXT NOT NULL,
                senderEmail TEXT NOT NULL,
                subject TEXT NOT NULL,
                bodyText TEXT NOT NULL,
                payloadJson TEXT,
                availableAt INTEGER NOT NULL,
                lockedAt INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                leaseKey TEXT,
                leaseExpiresAt INTEGER,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                sentAt INTEGER,
                provider TEXT,
                providerMessageId TEXT,
                providerStatusCode INTEGER,
                providerErrorCode INTEGER,
                lastError TEXT,
                FOREIGN KEY(purchaseId) REFERENCES purchases(id)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS adminAuditLog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchaseId INTEGER,
                actionType TEXT,
                note TEXT,
                detailsJson TEXT,
                userAgent TEXT,
                createdAt INTEGER
            )
        `);

        const purchaseColumns = await getAllRows("PRAGMA table_info(purchases)");
        const purchaseColumnNames = new Set(purchaseColumns.map(column => column.name));
        const serverColumns = await getAllRows("PRAGMA table_info(servers)");
        const serverColumnNames = new Set(serverColumns.map(column => column.name));
        const fulfillmentQueueColumns = await getAllRows("PRAGMA table_info(fulfillmentQueue)");
        const fulfillmentQueueColumnNames = new Set(fulfillmentQueueColumns.map(column => column.name));
        const emailOutboxColumns = await getAllRows("PRAGMA table_info(emailOutbox)");
        const emailOutboxColumnNames = new Set(emailOutboxColumns.map(column => column.name));

        await addColumnIfMissing("servers", serverColumnNames, "productCode", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "inventoryBucketCode", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "nodeGroupCode", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "provisioningTargetCode", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "runtimeFamily", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "runtimeTemplate", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "reservationKey", "TEXT");
        await addColumnIfMissing("servers", serverColumnNames, "reservedAt", "INTEGER");
        await addColumnIfMissing("servers", serverColumnNames, "allocatedAt", "INTEGER");

        if (!purchaseColumnNames.has("setupToken")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN setupToken TEXT");
        }

        if (!purchaseColumnNames.has("browserSessionId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN browserSessionId TEXT");
        }

        if (!purchaseColumnNames.has("setupTokenExpiresAt")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN setupTokenExpiresAt INTEGER");
        }

        if (!purchaseColumnNames.has("stripeCustomerId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeCustomerId TEXT");
        }

        if (!purchaseColumnNames.has("stripeSubscriptionId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeSubscriptionId TEXT");
        }

        if (!purchaseColumnNames.has("stripeSubscriptionStatus")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeSubscriptionStatus TEXT");
        }

        if (!purchaseColumnNames.has("stripeCurrentPeriodEnd")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeCurrentPeriodEnd INTEGER");
        }

        if (!purchaseColumnNames.has("stripeCancelAtPeriodEnd")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeCancelAtPeriodEnd INTEGER");
        }

        if (!purchaseColumnNames.has("stripePriceId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripePriceId TEXT");
        }

        if (!purchaseColumnNames.has("subscriptionDelinquentAt")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN subscriptionDelinquentAt INTEGER");
        }

        if (!purchaseColumnNames.has("serviceSuspendedAt")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN serviceSuspendedAt INTEGER");
        }

        await addColumnIfMissing("purchases", purchaseColumnNames, "planType", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "productCode", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "inventoryBucketCode", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "nodeGroupCode", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "provisioningTargetCode", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "runtimeFamily", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "runtimeTemplate", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "runtimeProfileCode", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "runtimeJavaVersion", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "minecraftVersion", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "setupStatus", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "fulfillmentStatus", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "serviceStatus", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "customerRiskStatus", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "releasedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "readyEmailQueuedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "adminReleaseActionAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "hostnameReservedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "fulfillmentFailureClass", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "needsAdminReviewReason", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "lastProvisioningError", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "lastProvisioningAttemptAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "provisioningAttemptCount", "INTEGER DEFAULT 0");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanServerId", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanUserId", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanUsername", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanServerIdentifier", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanAllocationId", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanUserStateJson", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanServerStateJson", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanReconcileStatus", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanReconciledAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanPasswordCiphertext", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanPasswordIv", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanPasswordAuthTag", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "pelicanPasswordStoredAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "hostname", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "hostnameReservationKey", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "hostnameReleasedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "desiredRoutingArtifactJson", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "desiredRoutingArtifactGeneratedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "routingVerifiedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "workerLeaseKey", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "workerLeaseExpiresAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "reconciledAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "lastStateOwner", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "stateVersion", "INTEGER DEFAULT 1");
        await addColumnIfMissing("purchases", purchaseColumnNames, "updatedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "completedAt", "INTEGER");
        await addColumnIfMissing("purchases", purchaseColumnNames, "paidAt", "INTEGER");
        await addColumnIfMissing("fulfillmentQueue", fulfillmentQueueColumnNames, "leaseKey", "TEXT");
        await addColumnIfMissing("fulfillmentQueue", fulfillmentQueueColumnNames, "leaseExpiresAt", "INTEGER");
        await addColumnIfMissing("fulfillmentQueue", fulfillmentQueueColumnNames, "completedAt", "INTEGER");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "lockedAt", "INTEGER");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "attempts", "INTEGER DEFAULT 0");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "leaseKey", "TEXT");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "leaseExpiresAt", "INTEGER");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "provider", "TEXT");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "providerMessageId", "TEXT");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "providerStatusCode", "INTEGER");
        await addColumnIfMissing("emailOutbox", emailOutboxColumnNames, "providerErrorCode", "INTEGER");

        await seedLaunchCatalog();
        await seedLaunchInventory();
        await backfillPurchaseCatalogFields();

        await runStatement(
            "UPDATE purchases SET updatedAt = COALESCE(updatedAt, createdAt, ?) WHERE updatedAt IS NULL",
            [Date.now()]
        );
        await runStatement(
            "UPDATE purchases SET stateVersion = COALESCE(stateVersion, 1) WHERE stateVersion IS NULL"
        );

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_stripe_session_id
            ON purchases(stripeSessionId)
            WHERE stripeSessionId IS NOT NULL
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_stripe_subscription_id
            ON purchases(stripeSubscriptionId)
            WHERE stripeSubscriptionId IS NOT NULL
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_pelican_links_username
            ON customerPelicanLinks(pelicanUsername COLLATE NOCASE)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_setup_token
            ON purchases(setupToken)
            WHERE setupToken IS NOT NULL
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_purchases_browser_session
            ON purchases(browserSessionId, createdAt DESC)
            WHERE browserSessionId IS NOT NULL
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_admin_audit_purchase_created
            ON adminAuditLog(purchaseId, createdAt DESC)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_reservation_key
            ON servers(reservationKey)
            WHERE reservationKey IS NOT NULL
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_servers_product_status
            ON servers(productCode, status, id)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_purchases_plan_status
            ON purchases(planType, status, createdAt DESC)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_purchases_customer_pelican_username
            ON purchases(stripeCustomerId, pelicanUsername)
            WHERE pelicanUsername IS NOT NULL
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_active_hostname_slug
            ON purchases(hostnameReservationKey COLLATE NOCASE)
            WHERE hostnameReservationKey IS NOT NULL
              AND hostnameReleasedAt IS NULL
              AND status NOT IN ('cancelled', 'expired')
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_purchases_product_status
            ON purchases(productCode, status, createdAt DESC)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_queue_idempotency_key
            ON fulfillmentQueue(idempotencyKey)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_queue_purchase_task_active
            ON fulfillmentQueue(purchaseId, taskType)
            WHERE state IN ('queued', 'leased')
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_fulfillment_queue_poll
            ON fulfillmentQueue(state, availableAt, id)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_idempotency_key
            ON emailOutbox(idempotencyKey)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_email_outbox_poll
            ON emailOutbox(state, availableAt, id)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_email_outbox_purchase
            ON emailOutbox(purchaseId, createdAt DESC)
        `);

        await runStatement("UPDATE servers SET status = ? WHERE status = 'reserved'", [
            SERVER_STATUS.HELD
        ]);
        await runStatement("UPDATE servers SET status = ? WHERE status = 'sold'", [
            SERVER_STATUS.ALLOCATED
        ]);
        await runStatement("UPDATE purchases SET status = ? WHERE status = 'pending'", [
            PURCHASE_STATUS.CHECKOUT_PENDING
        ]);
        await runStatement(
            "UPDATE servers SET allocatedAt = COALESCE(allocatedAt, ?) WHERE status = ? AND allocatedAt IS NULL",
            [Date.now(), SERVER_STATUS.ALLOCATED]
        );
        await runStatement(
            "UPDATE servers SET reservedAt = COALESCE(reservedAt, ?) WHERE status = ? AND reservedAt IS NULL",
            [Date.now(), SERVER_STATUS.HELD]
        );
        await runStatement(
            "UPDATE purchases SET setupToken = lower(hex(randomblob(32))) WHERE setupToken IS NULL"
        );
        await runStatement(
            "UPDATE purchases SET setupTokenExpiresAt = ? WHERE setupTokenExpiresAt IS NULL",
            [Date.now() + config.setupTokenTtlMs]
        );
        await runStatement(
            "UPDATE emailOutbox SET attempts = COALESCE(attempts, 0) WHERE attempts IS NULL"
        );
        await runStatement(
            "UPDATE purchases SET updatedAt = COALESCE(updatedAt, createdAt, ?) WHERE updatedAt IS NULL",
            [Date.now()]
        );
        await backfillLifecycleFields();
    } catch (err) {
        console.error("Database initialization failed:", err);
        throw err;
    }
})();

module.exports = ready;
