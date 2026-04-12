const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const configuredDatabasePath = (process.env.DATABASE_PATH || "").trim();
const databasePath = configuredDatabasePath
    ? path.resolve(configuredDatabasePath)
    : path.join(__dirname, "../data.db");

const db = new sqlite3.Database(databasePath);

db.run("PRAGMA foreign_keys = ON");

module.exports = db;
