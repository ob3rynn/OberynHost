const config = require("../config");
const db = require("./index");
const { SERVER_STATUS, PURCHASE_STATUS } = require("../constants/status");
const { PLAN_DEFINITIONS } = require("../config/plans");
const { createLaunchPlanDefinition, savePlanDefinition } = require("../services/catalog");
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

    const launchDefinition = createLaunchPlanDefinition(
        LAUNCH_PLAN_TYPE,
        LAUNCH_PLAN,
        config.stripePriceIds[LAUNCH_PLAN_TYPE]
    );

    const result = await savePlanDefinition(launchDefinition);

    if (!result.saved) {
        throw new Error(`Launch plan definition is invalid: ${result.validation.errors.join("; ")}`);
    }
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
            CREATE TABLE IF NOT EXISTS planDefinitions (
                planKey TEXT PRIMARY KEY,
                productCode TEXT NOT NULL UNIQUE,
                definitionJson TEXT NOT NULL,
                stripePriceId TEXT,
                stripePriceMetadataJson TEXT,
                active INTEGER NOT NULL DEFAULT 0,
                storefrontVisible INTEGER NOT NULL DEFAULT 0,
                sortOrder INTEGER NOT NULL DEFAULT 100,
                validationStatus TEXT NOT NULL DEFAULT 'valid',
                validationErrorsJson TEXT,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
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
            CREATE TABLE IF NOT EXISTS supportTickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                publicRef TEXT NOT NULL UNIQUE,
                customerId TEXT,
                purchaseId INTEGER,
                serviceId TEXT,
                email TEXT NOT NULL COLLATE NOCASE,
                subject TEXT NOT NULL,
                message TEXT NOT NULL,
                category TEXT NOT NULL,
                scopeClassification TEXT NOT NULL DEFAULT 'unknown',
                priority TEXT NOT NULL DEFAULT 'normal',
                humanRequired INTEGER NOT NULL DEFAULT 1,
                ruleRecommendationJson TEXT,
                escalationReason TEXT,
                status TEXT NOT NULL DEFAULT 'needs_admin',
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                resolvedAt INTEGER,
                FOREIGN KEY(purchaseId) REFERENCES purchases(id)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS supportTicketEvents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticketId INTEGER NOT NULL,
                eventType TEXT NOT NULL,
                actorType TEXT NOT NULL,
                body TEXT,
                payloadJson TEXT,
                createdAt INTEGER NOT NULL,
                FOREIGN KEY(ticketId) REFERENCES supportTickets(id)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS supportTicketSnapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticketId INTEGER NOT NULL,
                snapshotType TEXT NOT NULL,
                snapshotJson TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                FOREIGN KEY(ticketId) REFERENCES supportTickets(id)
            )
        `);

        await runStatement(`
            CREATE TABLE IF NOT EXISTS serviceAccessLinks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchaseId INTEGER NOT NULL,
                tokenHash TEXT NOT NULL,
                tokenPrefix TEXT,
                purpose TEXT NOT NULL DEFAULT 'service_support',
                billingPeriodStart INTEGER,
                billingPeriodEnd INTEGER,
                expiresAt INTEGER NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                createdAt INTEGER NOT NULL,
                lastUsedAt INTEGER,
                revokedAt INTEGER,
                rotatedAt INTEGER,
                rotatedFromId INTEGER,
                FOREIGN KEY(purchaseId) REFERENCES purchases(id),
                FOREIGN KEY(rotatedFromId) REFERENCES serviceAccessLinks(id)
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

        await runStatement(`
            CREATE TABLE IF NOT EXISTS waitlistEntries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL COLLATE NOCASE,
                name TEXT,
                note TEXT,
                planKey TEXT NOT NULL,
                productCode TEXT NOT NULL,
                inventoryBucketCode TEXT,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL
            )
        `);

        const purchaseColumns = await getAllRows("PRAGMA table_info(purchases)");
        const purchaseColumnNames = new Set(purchaseColumns.map(column => column.name));
        const serverColumns = await getAllRows("PRAGMA table_info(servers)");
        const serverColumnNames = new Set(serverColumns.map(column => column.name));
        const productColumns = await getAllRows("PRAGMA table_info(products)");
        const productColumnNames = new Set(productColumns.map(column => column.name));
        const inventoryBucketColumns = await getAllRows("PRAGMA table_info(inventoryBuckets)");
        const inventoryBucketColumnNames = new Set(inventoryBucketColumns.map(column => column.name));
        const nodeGroupColumns = await getAllRows("PRAGMA table_info(nodeGroups)");
        const nodeGroupColumnNames = new Set(nodeGroupColumns.map(column => column.name));
        const provisioningTargetColumns = await getAllRows("PRAGMA table_info(provisioningTargets)");
        const provisioningTargetColumnNames = new Set(provisioningTargetColumns.map(column => column.name));
        const adminAuditColumns = await getAllRows("PRAGMA table_info(adminAuditLog)");
        const adminAuditColumnNames = new Set(adminAuditColumns.map(column => column.name));
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

        await addColumnIfMissing("products", productColumnNames, "description", "TEXT");
        await addColumnIfMissing("products", productColumnNames, "priceLabel", "TEXT");
        await addColumnIfMissing("products", productColumnNames, "storefrontVisible", "INTEGER DEFAULT 1");
        await addColumnIfMissing("products", productColumnNames, "sortOrder", "INTEGER DEFAULT 100");
        await addColumnIfMissing("products", productColumnNames, "stripePriceId", "TEXT");
        await addColumnIfMissing("inventoryBuckets", inventoryBucketColumnNames, "purchaseEnabled", "INTEGER DEFAULT 1");
        await addColumnIfMissing("inventoryBuckets", inventoryBucketColumnNames, "adminNotes", "TEXT");
        await addColumnIfMissing("nodeGroups", nodeGroupColumnNames, "adminNotes", "TEXT");
        await addColumnIfMissing("nodeGroups", nodeGroupColumnNames, "supportedVersionsJson", "TEXT");
        await addColumnIfMissing("provisioningTargets", provisioningTargetColumnNames, "adminNotes", "TEXT");
        await addColumnIfMissing("provisioningTargets", provisioningTargetColumnNames, "supportedVersionsJson", "TEXT");
        await addColumnIfMissing("adminAuditLog", adminAuditColumnNames, "entityType", "TEXT");
        await addColumnIfMissing("adminAuditLog", adminAuditColumnNames, "entityCode", "TEXT");
        await addColumnIfMissing("adminAuditLog", adminAuditColumnNames, "oldValueJson", "TEXT");
        await addColumnIfMissing("adminAuditLog", adminAuditColumnNames, "newValueJson", "TEXT");
        await addColumnIfMissing("adminAuditLog", adminAuditColumnNames, "actorJson", "TEXT");

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

        await addColumnIfMissing("purchases", purchaseColumnNames, "stripeCurrentPeriodStart", "INTEGER");

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
        await addColumnIfMissing("purchases", purchaseColumnNames, "planSnapshotJson", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "stripePriceSnapshotJson", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "inventorySnapshotJson", "TEXT");
        await addColumnIfMissing("purchases", purchaseColumnNames, "provisioningSnapshotJson", "TEXT");
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
            CREATE INDEX IF NOT EXISTS idx_plan_definitions_public
            ON planDefinitions(active, storefrontVisible, sortOrder, planKey)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_inventory_buckets_active
            ON inventoryBuckets(active, purchaseEnabled, productCode)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_purchases_plan_status
            ON purchases(planType, status, createdAt DESC)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
            ON supportTickets(status, createdAt DESC, id DESC)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_email_created
            ON supportTickets(email, createdAt DESC)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_purchase_created
            ON supportTickets(purchaseId, createdAt DESC)
            WHERE purchaseId IS NOT NULL
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_category_created
            ON supportTickets(category, createdAt DESC)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket_created
            ON supportTicketEvents(ticketId, createdAt ASC, id ASC)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_service_access_links_token_hash
            ON serviceAccessLinks(tokenHash)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_service_access_links_purchase
            ON serviceAccessLinks(purchaseId, purpose, active, expiresAt DESC)
        `);

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_service_access_links_rotation
            ON serviceAccessLinks(rotatedFromId)
            WHERE rotatedFromId IS NOT NULL
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

        await runStatement(`
            CREATE INDEX IF NOT EXISTS idx_waitlist_entries_filters
            ON waitlistEntries(planKey, status, createdAt DESC)
        `);

        await runStatement(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_active_email_plan
            ON waitlistEntries(email COLLATE NOCASE, planKey)
            WHERE status IN ('waiting', 'notified')
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
