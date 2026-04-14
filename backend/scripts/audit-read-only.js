const {
    buildReadOnlyAuditReport,
    formatReport,
    summarize
} = require("./lib/readOnlyAudit");

async function main() {
    const report = await buildReadOnlyAuditReport();
    const asJson = process.argv.includes("--json");

    if (asJson) {
        process.stdout.write(`${JSON.stringify({
            ...report,
            summary: summarize(report)
        }, null, 2)}\n`);
    } else {
        process.stdout.write(`${formatReport(report)}\n`);
    }

    process.exitCode = report.results.some(result => result.level === "fail") ? 1 : 0;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
