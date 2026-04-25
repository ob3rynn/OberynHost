const fs = require("fs");

const {
    LEGACY_PRODUCT_ENV_NAMES,
    LIVEISH_CONTAINER_MEMORY_MB,
    LIVEISH_JVM_MEMORY_MB,
    LIVEISH_PLAN_TYPE,
    closeDatabase,
    createDatabase,
    getLiveishPlan,
    getProductTruthErrors,
    listMarkedLiveishPurchases,
    loadHarnessEnv,
    resolveDatabasePath,
    validateLiveishTargetConfig
} = require("./lib/liveishHarness");

function createReport() {
    return {
        title: "Live-ish Fulfillment Harness Audit",
        generatedAt: new Date().toISOString(),
        results: []
    };
}

function addResult(report, section, level, summary, details = "") {
    report.results.push({
        section,
        level,
        summary,
        details
    });
}

function summarize(report) {
    return report.results.reduce((counts, result) => {
        counts[result.level] = (counts[result.level] || 0) + 1;
        return counts;
    }, {
        pass: 0,
        warn: 0,
        fail: 0,
        info: 0
    });
}

function isStrictMode(env = process.env, argv = process.argv) {
    return env.OBERYNHOST_RUN_LIVEISH === "1" || argv.includes("--strict");
}

function getMissingEnv(env, names) {
    return names.filter(name => !String(env[name] || "").trim());
}

function addProductChecks(report) {
    const errors = getProductTruthErrors();
    const plan = getLiveishPlan();

    if (errors.length === 0) {
        addResult(
            report,
            "product",
            "pass",
            "Active launch product is Paper 2 GB",
            `${LIVEISH_PLAN_TYPE}, memory=${LIVEISH_CONTAINER_MEMORY_MB}, jvm=${LIVEISH_JVM_MEMORY_MB}`
        );
    } else {
        addResult(report, "product", "fail", "Active launch product drift was found", errors.join("; "));
    }

    if (plan?.provisioningTargetCode) {
        addResult(
            report,
            "product",
            "info",
            "Active provisioning target code",
            plan.provisioningTargetCode
        );
    }
}

function addStripeChecks(report, env, strict) {
    const missing = getMissingEnv(env, [
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_PAPER_2GB"
    ]);

    if (missing.length === 0) {
        addResult(report, "stripe", "pass", "Stripe live-ish env is present");
    } else {
        addResult(
            report,
            "stripe",
            strict ? "fail" : "warn",
            "Stripe live-ish env is incomplete",
            missing.join(", ")
        );
    }

    const stripeSecretKey = String(env.STRIPE_SECRET_KEY || "").trim();

    if (stripeSecretKey) {
        addResult(
            report,
            "stripe",
            stripeSecretKey.startsWith("sk_test_") ? "pass" : "fail",
            stripeSecretKey.startsWith("sk_test_")
                ? "Stripe secret key is test mode"
                : "Stripe secret key must be test mode for the harness"
        );
    }

    const legacyEnv = LEGACY_PRODUCT_ENV_NAMES.filter(name => String(env[name] || "").trim());

    if (legacyEnv.length === 0) {
        addResult(report, "stripe", "pass", "No legacy Stripe product env vars are set");
    } else {
        addResult(report, "stripe", "fail", "Legacy Stripe product env vars are still set", legacyEnv.join(", "));
    }
}

function addEmailChecks(report, env) {
    const provider = String(env.EMAIL_PROVIDER || "log").trim().toLowerCase() || "log";

    addResult(
        report,
        "email",
        provider === "log" ? "pass" : "warn",
        provider === "log"
            ? "Email provider defaults to local log delivery"
            : "Core live-ish harness does not require Postmark",
        `EMAIL_PROVIDER=${provider}`
    );
}

function addPelicanChecks(report, env, strict) {
    const missing = getMissingEnv(env, [
        "PELICAN_PANEL_URL",
        "PELICAN_APPLICATION_API_KEY",
        "PELICAN_PROVISIONING_TARGETS_JSON"
    ]);

    if (missing.length === 0) {
        addResult(report, "pelican", "pass", "Pelican Application API env is present");
    } else {
        addResult(
            report,
            "pelican",
            strict ? "fail" : "warn",
            "Pelican Application API env is incomplete",
            missing.join(", ")
        );
    }

    const targetJson = String(env.PELICAN_PROVISIONING_TARGETS_JSON || "").trim();
    if (targetJson) {
        const targetValidation = validateLiveishTargetConfig(targetJson);

        if (targetValidation.ok) {
            addResult(
                report,
                "pelican",
                "pass",
                "Pelican provisioning target matches Paper 2 GB launch resources",
                `limits.memory=${LIVEISH_CONTAINER_MEMORY_MB}, jvm=${LIVEISH_JVM_MEMORY_MB}`
            );
        } else {
            addResult(report, "pelican", "fail", "Pelican provisioning target is not live-ish safe", targetValidation.errors.join("; "));
        }

        for (const warning of targetValidation.warnings) {
            addResult(report, "pelican", "warn", "Pelican target warning", warning);
        }
    }

    const missingClient = getMissingEnv(env, [
        "LIVEISH_HARNESS_PELICAN_USER_ID",
        "LIVEISH_HARNESS_PELICAN_USERNAME",
        "LIVEISH_HARNESS_PELICAN_CLIENT_API_KEY"
    ]);

    if (missingClient.length === 0) {
        addResult(report, "client-api", "pass", "Reusable Pelican harness user and Client API key are configured");
    } else {
        addResult(
            report,
            "client-api",
            strict ? "fail" : "warn",
            "Reusable Pelican harness user is incomplete",
            missingClient.join(", ")
        );
    }
}

async function addCleanupChecks(report, env = process.env) {
    const databasePath = resolveDatabasePath(env);

    try {
        if (!fs.existsSync(databasePath)) {
            addResult(
                report,
                "cleanup",
                "info",
                "Database file was not found for cleanup discovery",
                databasePath
            );
            return;
        }

        const database = createDatabase(databasePath);
        try {
            const marked = await listMarkedLiveishPurchases(database);
            addResult(
                report,
                "cleanup",
                "pass",
                "Cleanup discovery is marker-limited",
                `${marked.length} marked live-ish purchase(s) currently match`
            );
        } finally {
            await closeDatabase(database);
        }
    } catch (err) {
        addResult(
            report,
            "cleanup",
            "warn",
            "Could not inspect local cleanup candidates",
            `${databasePath}: ${err.message}`
        );
    }

    addResult(
        report,
        "cleanup",
        "pass",
        "Pelican destructive cleanup is not implemented by the harness"
    );
}

async function buildLiveishAuditReport(options = {}) {
    if (options.loadEnv !== false) {
        loadHarnessEnv();
    }

    const env = options.env || process.env;
    const strict = options.strict ?? isStrictMode(env, options.argv || process.argv);
    const report = createReport();

    addProductChecks(report);
    addStripeChecks(report, env, strict);
    addEmailChecks(report, env);
    addPelicanChecks(report, env, strict);
    await addCleanupChecks(report, env);

    return report;
}

function formatReport(report) {
    const counts = summarize(report);
    const lines = [
        report.title,
        `Generated: ${report.generatedAt}`,
        `Summary: pass=${counts.pass || 0}, warn=${counts.warn || 0}, fail=${counts.fail || 0}, info=${counts.info || 0}`,
        ""
    ];

    for (const result of report.results) {
        lines.push(`[${result.level.toUpperCase()}] ${result.section}: ${result.summary}`);
        if (result.details) {
            lines.push(`  ${result.details}`);
        }
    }

    return lines.join("\n");
}

async function main() {
    const asJson = process.argv.includes("--json");
    const report = await buildLiveishAuditReport();

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

if (require.main === module) {
    main().catch(err => {
        console.error("LIVEISH_HARNESS_AUDIT_FAILED");
        console.error(err && err.stack ? err.stack : String(err));
        process.exit(1);
    });
}

module.exports = {
    buildLiveishAuditReport,
    formatReport,
    isStrictMode,
    summarize
};
