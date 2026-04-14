const {
    buildUpdateInventory,
    formatUpdateInventory
} = require("./lib/updateInventory");

async function main() {
    const inventory = await buildUpdateInventory();
    const asJson = process.argv.includes("--json");

    if (asJson) {
        process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    } else {
        process.stdout.write(`${formatUpdateInventory(inventory)}\n`);
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
