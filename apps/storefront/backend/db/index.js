const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const configuredDatabasePath = (process.env.DATABASE_PATH || "").trim();
const databasePath = configuredDatabasePath
    ? (
        path.isAbsolute(configuredDatabasePath)
            ? configuredDatabasePath
            : path.resolve(__dirname, "..", configuredDatabasePath)
    )
    : path.join(__dirname, "../data.db");

const databaseDirectory = path.dirname(databasePath);

function failDatabasePath(message) {
    if (process.env.NODE_ENV === "test") {
        throw new Error(message);
    }

    console.error(`Database configuration error: ${message}`);
    process.exit(1);
}

if (fs.existsSync(databasePath) && fs.statSync(databasePath).isDirectory()) {
    failDatabasePath(`SQLite database path points to a directory: ${databasePath}`);
}

if (!fs.existsSync(databaseDirectory)) {
    failDatabasePath(
        `SQLite database directory does not exist: ${databaseDirectory}. Create or mount this directory before startup.`
    );
}

if (!fs.statSync(databaseDirectory).isDirectory()) {
    failDatabasePath(`SQLite database parent path is not a directory: ${databaseDirectory}`);
}

try {
    fs.accessSync(databaseDirectory, fs.constants.R_OK | fs.constants.W_OK);
} catch (err) {
    failDatabasePath(
        `SQLite database directory must be readable and writable: ${databaseDirectory} (${err.message})`
    );
}

const db = new sqlite3.Database(databasePath, err => {
    if (err) {
        console.error(`Failed to open SQLite database at ${databasePath}: ${err.message}`);
        process.exit(1);
    }
});

db.databasePath = databasePath;

db.run("PRAGMA foreign_keys = ON");

module.exports = db;
