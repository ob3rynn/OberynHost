const config = require("../config");
const db = require("./index");
const { SERVER_STATUS, PURCHASE_STATUS } = require("../constants/status");

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

async function seedInventory() {
    for (let index = 0; index < 20; index += 1) {
        await runStatement("INSERT INTO servers VALUES (?, ?, ?, ?)", [
            index + 1,
            "2GB",
            9.98,
            SERVER_STATUS.AVAILABLE
        ]);
    }

    for (let index = 0; index < 2; index += 1) {
        await runStatement("INSERT INTO servers VALUES (?, ?, ?, ?)", [
            21 + index,
            "4GB",
            31.98,
            SERVER_STATUS.AVAILABLE
        ]);
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

        const columns = await getAllRows("PRAGMA table_info(purchases)");
        const columnNames = new Set(columns.map(column => column.name));

        if (!columnNames.has("setupToken")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN setupToken TEXT");
        }

        if (!columnNames.has("browserSessionId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN browserSessionId TEXT");
        }

        if (!columnNames.has("setupTokenExpiresAt")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN setupTokenExpiresAt INTEGER");
        }

        if (!columnNames.has("stripeCustomerId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeCustomerId TEXT");
        }

        if (!columnNames.has("stripeSubscriptionId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeSubscriptionId TEXT");
        }

        if (!columnNames.has("stripeSubscriptionStatus")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeSubscriptionStatus TEXT");
        }

        if (!columnNames.has("stripeCurrentPeriodEnd")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeCurrentPeriodEnd INTEGER");
        }

        if (!columnNames.has("stripeCancelAtPeriodEnd")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripeCancelAtPeriodEnd INTEGER");
        }

        if (!columnNames.has("stripePriceId")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN stripePriceId TEXT");
        }

        if (!columnNames.has("subscriptionDelinquentAt")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN subscriptionDelinquentAt INTEGER");
        }

        if (!columnNames.has("serviceSuspendedAt")) {
            await runStatement("ALTER TABLE purchases ADD COLUMN serviceSuspendedAt INTEGER");
        }

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
            "UPDATE purchases SET setupToken = lower(hex(randomblob(32))) WHERE setupToken IS NULL"
        );
        await runStatement(
            "UPDATE purchases SET setupTokenExpiresAt = ? WHERE setupTokenExpiresAt IS NULL",
            [Date.now() + config.setupTokenTtlMs]
        );

        const row = await getRow("SELECT COUNT(*) as count FROM servers");

        if (!row || row.count === 0) {
            await seedInventory();
        }
    } catch (err) {
        console.error("Database initialization failed:", err);
        throw err;
    }
})();

module.exports = ready;
