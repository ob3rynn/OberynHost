const { runQuery } = require("./queries");

async function rollbackTransaction() {
    try {
        await runQuery("ROLLBACK");
    } catch {}
}

module.exports = {
    rollbackTransaction
};