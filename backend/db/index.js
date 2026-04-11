const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database(path.join(__dirname, "../data.db"));

db.run("PRAGMA foreign_keys = ON");

module.exports = db;
