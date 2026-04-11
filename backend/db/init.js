const config = require("../config");
const db = require("./index");
const { SERVER_STATUS, PURCHASE_STATUS } = require("../constants/status");

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS servers (
            id INTEGER PRIMARY KEY,
            type TEXT,
            price REAL,
            status TEXT
        )
    `);

    db.run(`
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

    db.all("PRAGMA table_info(purchases)", (err, columns) => {
        if (err) {
            console.error("Failed to inspect purchases table:", err);
            return;
        }

        const columnNames = new Set(columns.map(column => column.name));
        const migrations = [];

        if (!columnNames.has("setupToken")) {
            migrations.push("ALTER TABLE purchases ADD COLUMN setupToken TEXT");
        }

        if (!columnNames.has("setupTokenExpiresAt")) {
            migrations.push("ALTER TABLE purchases ADD COLUMN setupTokenExpiresAt INTEGER");
        }

        function finalizeBootstrap() {
            db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_stripe_session_id
                ON purchases(stripeSessionId)
                WHERE stripeSessionId IS NOT NULL
            `, indexErr => {
                if (indexErr) {
                    console.error("Failed to create purchase session index:", indexErr);
                }
            });

            db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_setup_token
                ON purchases(setupToken)
                WHERE setupToken IS NOT NULL
            `, indexErr => {
                if (indexErr) {
                    console.error("Failed to create setup token index:", indexErr);
                }
            });

            db.run("UPDATE servers SET status = ? WHERE status = 'reserved'", [SERVER_STATUS.HELD]);
            db.run("UPDATE servers SET status = ? WHERE status = 'sold'", [SERVER_STATUS.ALLOCATED]);
            db.run("UPDATE purchases SET status = ? WHERE status = 'pending'", [PURCHASE_STATUS.CHECKOUT_PENDING]);
            db.run(
                "UPDATE purchases SET setupToken = lower(hex(randomblob(32))) WHERE setupToken IS NULL"
            );
            db.run(
                "UPDATE purchases SET setupTokenExpiresAt = ? WHERE setupTokenExpiresAt IS NULL",
                [Date.now() + config.setupTokenTtlMs]
            );

            db.get("SELECT COUNT(*) as count FROM servers", (countErr, row) => {
                if (countErr) {
                    console.error("Failed to inspect server inventory:", countErr);
                    return;
                }

                if (!row || row.count === 0) {
                    const stmt = db.prepare("INSERT INTO servers VALUES (?, ?, ?, ?)");

                    for (let i = 0; i < 20; i++) {
                        stmt.run(i + 1, "2GB", 9.98, SERVER_STATUS.AVAILABLE);
                    }

                    for (let i = 0; i < 2; i++) {
                        stmt.run(21 + i, "4GB", 31.98, SERVER_STATUS.AVAILABLE);
                    }

                    stmt.finalize();
                }
            });
        }

        function runMigrations(index) {
            if (index >= migrations.length) {
                finalizeBootstrap();
                return;
            }

            db.run(migrations[index], migrationErr => {
                if (migrationErr) {
                    console.error("Failed to migrate purchases table:", migrationErr);
                    return;
                }

                runMigrations(index + 1);
            });
        }

        runMigrations(0);
    });
});
