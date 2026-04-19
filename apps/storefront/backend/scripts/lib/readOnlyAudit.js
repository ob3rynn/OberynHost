const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sqlite3 = require("sqlite3").verbose();
const dotenv = require("dotenv");

const {
    ACTIVE_SUBSCRIPTION_STATUSES,
    TERMINAL_SUBSCRIPTION_STATUSES,
    getPurchasePolicyState
} = require("../../services/policyRules");
const { PURCHASE_STATUS } = require("../../constants/status");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const BACKEND_ROOT = path.join(REPO_ROOT, "backend");
const PACKAGE_JSON_PATH = path.join(BACKEND_ROOT, "package.json");
const PACKAGE_LOCK_PATH = path.join(BACKEND_ROOT, "package-lock.json");
const ENV_PATH = path.join(BACKEND_ROOT, ".env");
const NVMRC_PATH = path.join(REPO_ROOT, ".nvmrc");
const SHARED_STRIPE_CLIENT_PATH = path.join(BACKEND_ROOT, "lib", "stripeClient.js");

const REQUIRED_ENV_NAMES = [
    "BASE_URL",
    "ADMIN_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_API_VERSION",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_2GB",
    "STRIPE_PRICE_4GB"
];

const AUDIT_SCRIPT_SUFFIXES = new Set([
    path.join("scripts", "audit-config.js"),
    path.join("scripts", "audit-runtime.js"),
    path.join("scripts", "audit-read-only.js"),
    path.join("scripts", "lib", "readOnlyAudit.js")
]);

function loadLocalEnv() {
    if (fs.existsSync(ENV_PATH)) {
        dotenv.config({
            path: ENV_PATH,
            override: false,
            quiet: true
        });
    }
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createReport(title) {
    return {
        title,
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
    const counts = {
        pass: 0,
        warn: 0,
        fail: 0,
        info: 0
    };

    for (const result of report.results) {
        counts[result.level] += 1;
    }

    return counts;
}

function isExactVersion(spec) {
    return typeof spec === "string" && /^\d+\.\d+\.\d+$/.test(spec.trim());
}

function listRangeDependencies(dependencies = {}) {
    return Object.entries(dependencies)
        .filter(([, spec]) => typeof spec === "string" && !isExactVersion(spec))
        .map(([name, spec]) => `${name}@${spec}`);
}

function readOptionalJson(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return readJson(filePath);
}

function safeReadInstalledPackageVersion(packageName) {
    const packagePath = path.join(BACKEND_ROOT, "node_modules", packageName, "package.json");

    if (!fs.existsSync(packagePath)) {
        return null;
    }

    try {
        return readJson(packagePath).version || null;
    } catch {
        return null;
    }
}

function safeGit(args) {
    try {
        return execFileSync("git", args, {
            cwd: REPO_ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
        }).trim();
    } catch {
        return null;
    }
}

function resolveDatabasePath() {
    const configuredDatabasePath = (process.env.DATABASE_PATH || "").trim();

    if (!configuredDatabasePath) {
        return path.join(BACKEND_ROOT, "data.db");
    }

    return path.isAbsolute(configuredDatabasePath)
        ? configuredDatabasePath
        : path.resolve(BACKEND_ROOT, configuredDatabasePath);
}

function inspectDatabasePath(databasePath) {
    const databaseDirectory = path.dirname(databasePath);

    if (fs.existsSync(databasePath) && fs.statSync(databasePath).isDirectory()) {
        return {
            level: "fail",
            summary: "DATABASE_PATH points to a directory, not a SQLite file",
            details: databasePath
        };
    }

    if (!fs.existsSync(databaseDirectory)) {
        return {
            level: "fail",
            summary: "SQLite database directory does not exist",
            details: databaseDirectory
        };
    }

    if (!fs.statSync(databaseDirectory).isDirectory()) {
        return {
            level: "fail",
            summary: "SQLite database parent path is not a directory",
            details: databaseDirectory
        };
    }

    try {
        fs.accessSync(databaseDirectory, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
        return {
            level: "fail",
            summary: "SQLite database directory is not readable and writable",
            details: `${databaseDirectory}: ${err.message}`
        };
    }

    return {
        level: "pass",
        summary: "SQLite database directory is readable and writable",
        details: databaseDirectory
    };
}

function openReadOnlyDatabase(databasePath) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(
            `file:${databasePath}?mode=ro`,
            sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
            err => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(database);
            }
        );
    });
}

function dbGet(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(row || null);
        });
    });
}

function dbAll(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(rows || []);
        });
    });
}

function closeDatabase(database) {
    return new Promise((resolve, reject) => {
        database.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

function formatCounts(rows) {
    if (!rows.length) {
        return "none";
    }

    return rows
        .map(row => `${row.status || "unknown"}=${row.count}`)
        .join(", ");
}

function walkJavaScriptFiles(rootPath, files = []) {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name === "node_modules") {
            continue;
        }

        const fullPath = path.join(rootPath, entry.name);

        if (entry.isDirectory()) {
            walkJavaScriptFiles(fullPath, files);
            continue;
        }

        if (entry.isFile() && fullPath.endsWith(".js")) {
            files.push(fullPath);
        }
    }

    return files;
}

function relativeToBackend(filePath) {
    return path.relative(BACKEND_ROOT, filePath);
}

function findRawStripeClients() {
    const files = walkJavaScriptFiles(BACKEND_ROOT);
    const offenders = [];

    for (const filePath of files) {
        const relativePath = relativeToBackend(filePath);

        if (filePath === SHARED_STRIPE_CLIENT_PATH || AUDIT_SCRIPT_SUFFIXES.has(relativePath)) {
            continue;
        }

        const source = fs.readFileSync(filePath, "utf8");

        if (/new\s+Stripe\s*\(/.test(source)) {
            offenders.push(relativePath);
        }
    }

    return offenders.sort();
}

function maskablePlaceholder(value) {
    return typeof value === "string" && /replace_me|price_replace_me|your-domain\.example/i.test(value);
}

async function buildConfigAuditReport() {
    loadLocalEnv();

    const report = createReport("Read-Only Config Audit");
    const packageJson = readJson(PACKAGE_JSON_PATH);
    const packageLock = readOptionalJson(PACKAGE_LOCK_PATH);
    const expectedNodeMajor = fs.existsSync(NVMRC_PATH)
        ? fs.readFileSync(NVMRC_PATH, "utf8").trim()
        : "";

    if (expectedNodeMajor) {
        if (process.version.replace(/^v/, "").startsWith(`${expectedNodeMajor}.`) || process.version === `v${expectedNodeMajor}`) {
            addResult(report, "runtime", "pass", "Node runtime matches .nvmrc", `expected ${expectedNodeMajor}, running ${process.version}`);
        } else {
            addResult(report, "runtime", "warn", "Node runtime does not match .nvmrc", `expected major ${expectedNodeMajor}, running ${process.version}`);
        }
    } else {
        addResult(report, "runtime", "info", "No .nvmrc version was found");
    }

    const missingEnv = REQUIRED_ENV_NAMES.filter(name => !(process.env[name] || "").trim());
    const placeholderEnv = REQUIRED_ENV_NAMES
        .filter(name => maskablePlaceholder((process.env[name] || "").trim()));

    if (missingEnv.length === 0) {
        addResult(report, "config", "pass", "Required Stripe, admin, and pricing environment variables are present");
    } else {
        addResult(report, "config", "fail", "Required environment variables are missing", missingEnv.join(", "));
    }

    if (placeholderEnv.length > 0) {
        addResult(report, "config", "fail", "Placeholder environment values are still in use", placeholderEnv.join(", "));
    }

    const baseUrl = (process.env.BASE_URL || "").trim();

    if (baseUrl) {
        try {
            const parsed = new URL(baseUrl);
            if (parsed.protocol === "https:") {
                addResult(report, "config", "pass", "BASE_URL is a valid HTTPS URL", parsed.origin);
            } else {
                addResult(report, "config", "warn", "BASE_URL is not HTTPS", `${parsed.origin} will disable secure cookies`);
            }
        } catch {
            addResult(report, "config", "fail", "BASE_URL is not a valid absolute URL", baseUrl);
        }
    }

    const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || "").trim();
    if (rawAllowedOrigins) {
        try {
            const normalizedOrigins = rawAllowedOrigins
                .split(",")
                .map(origin => origin.trim())
                .filter(Boolean)
                .map(origin => new URL(origin).origin);
            addResult(
                report,
                "config",
                "pass",
                "ALLOWED_ORIGINS entries are valid absolute URLs",
                normalizedOrigins.join(", ")
            );
        } catch {
            addResult(
                report,
                "config",
                "fail",
                "ALLOWED_ORIGINS contains an invalid absolute URL",
                rawAllowedOrigins
            );
        }
    } else {
        addResult(
            report,
            "config",
            "info",
            "ALLOWED_ORIGINS is unset, so only BASE_URL origin is allowed for state-changing requests"
        );
    }

    const databasePath = resolveDatabasePath();
    addResult(
        report,
        "database",
        process.env.DATABASE_PATH ? "pass" : "info",
        process.env.DATABASE_PATH
            ? "DATABASE_PATH is set explicitly"
            : "DATABASE_PATH is unset and will default to backend/data.db",
        databasePath
    );
    const databasePathInspection = inspectDatabasePath(databasePath);
    addResult(
        report,
        "database",
        databasePathInspection.level,
        databasePathInspection.summary,
        databasePathInspection.details
    );

    const stripeApiVersion = (process.env.STRIPE_API_VERSION || "").trim();

    if (/^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9]+$/.test(stripeApiVersion)) {
        addResult(report, "stripe", "pass", "STRIPE_API_VERSION is pinned to an explicit Stripe version", stripeApiVersion);
    } else if (stripeApiVersion) {
        addResult(report, "stripe", "warn", "STRIPE_API_VERSION does not match the expected format", stripeApiVersion);
    }

    const stripeSpec = packageJson.dependencies?.stripe;
    const lockSpec = packageLock?.packages?.[""]?.dependencies?.stripe || null;
    const lockedStripeVersion = packageLock?.packages?.["node_modules/stripe"]?.version || null;
    const installedStripeVersion = safeReadInstalledPackageVersion("stripe");

    if (isExactVersion(stripeSpec)) {
        addResult(report, "stripe", "pass", "Stripe dependency is pinned to an exact package version", stripeSpec);
    } else {
        addResult(report, "stripe", "fail", "Stripe dependency is not pinned exactly in package.json", String(stripeSpec || ""));
    }

    if (lockSpec === stripeSpec && lockedStripeVersion === stripeSpec) {
        addResult(report, "stripe", "pass", "package-lock.json agrees with the pinned Stripe version", stripeSpec);
    } else {
        addResult(report, "stripe", "fail", "package-lock.json is out of sync with the pinned Stripe version", `package.json=${stripeSpec || "missing"}, lock root=${lockSpec || "missing"}, lock package=${lockedStripeVersion || "missing"}`);
    }

    if (installedStripeVersion) {
        if (installedStripeVersion === stripeSpec) {
            addResult(report, "stripe", "pass", "Installed Stripe package matches the pinned version", installedStripeVersion);
        } else {
            addResult(report, "stripe", "warn", "Installed Stripe package differs from the pinned version", `installed ${installedStripeVersion}, pinned ${stripeSpec}`);
        }
    } else {
        addResult(report, "stripe", "info", "Stripe is not installed under backend/node_modules");
    }

    const rawStripeClients = findRawStripeClients();

    if (rawStripeClients.length === 0) {
        addResult(report, "stripe", "pass", "Stripe clients are centralized through backend/lib/stripeClient.js");
    } else {
        addResult(report, "stripe", "fail", "Raw Stripe client construction was found outside the shared helper", rawStripeClients.join(", "));
    }

    const rangedDependencies = listRangeDependencies(packageJson.dependencies);

    if (rangedDependencies.length > 0) {
        addResult(report, "dependencies", "info", "Some runtime dependencies still use semver ranges in package.json", rangedDependencies.join(", "));
    } else {
        addResult(report, "dependencies", "pass", "All runtime dependencies are pinned exactly");
    }

    const currentBranch = safeGit(["branch", "--show-current"]);
    if (currentBranch) {
        addResult(report, "git", "info", "Current branch", currentBranch);
    } else {
        addResult(report, "git", "warn", "Could not determine the current git branch");
    }

    const gitStatus = safeGit(["status", "--short", "--untracked-files=all"]);
    if (gitStatus === null) {
        addResult(report, "git", "warn", "Could not read git status");
    } else if (!gitStatus) {
        addResult(report, "git", "pass", "Git worktree is clean");
    } else {
        const dirtyCount = gitStatus.split("\n").filter(Boolean).length;
        addResult(report, "git", "warn", "Git worktree has local changes", `${dirtyCount} path(s) differ from HEAD`);
    }

    return report;
}

async function buildRuntimeAuditReport() {
    loadLocalEnv();

    const report = createReport("Read-Only Runtime Audit");
    const databasePath = resolveDatabasePath();

    if (!fs.existsSync(databasePath)) {
        addResult(report, "database", "warn", "Database file was not found", databasePath);
        return report;
    }

    const databaseStats = fs.statSync(databasePath);
    addResult(report, "database", "info", "Database file is present", `${databasePath} (${databaseStats.size} bytes)`);

    let database = null;

    try {
        database = await openReadOnlyDatabase(databasePath);

        const tables = await dbAll(
            database,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('purchases', 'servers') ORDER BY name"
        );
        const tableNames = new Set(tables.map(row => row.name));

        if (!tableNames.has("purchases") || !tableNames.has("servers")) {
            addResult(report, "database", "fail", "Expected purchases/servers tables are missing", Array.from(tableNames).join(", "));
            return report;
        }

        const purchaseCounts = await dbAll(
            database,
            "SELECT status, COUNT(*) AS count FROM purchases GROUP BY status ORDER BY status"
        );
        const serverCounts = await dbAll(
            database,
            "SELECT status, COUNT(*) AS count FROM servers GROUP BY status ORDER BY status"
        );

        addResult(report, "database", "info", "Purchase counts by status", formatCounts(purchaseCounts));
        addResult(report, "database", "info", "Server counts by status", formatCounts(serverCounts));

        const stalePending = await dbGet(
            database,
            `SELECT COUNT(*) AS count
             FROM purchases
             WHERE status = ?
               AND stripeSessionId IS NOT NULL
               AND createdAt > 0
               AND createdAt <= ?`,
            [PURCHASE_STATUS.CHECKOUT_PENDING, Date.now() - (1000 * 60 * 30)]
        );

        if (Number(stalePending?.count || 0) === 0) {
            addResult(report, "checkout", "pass", "No stale pending Stripe checkouts were found");
        } else {
            addResult(report, "checkout", "warn", "Some Stripe checkouts have been pending for over 30 minutes", `${stalePending.count} purchase(s)`);
        }

        const pendingWithoutSession = await dbGet(
            database,
            `SELECT COUNT(*) AS count
             FROM purchases
             WHERE status = ?
               AND (stripeSessionId IS NULL OR TRIM(stripeSessionId) = '')`,
            [PURCHASE_STATUS.CHECKOUT_PENDING]
        );

        if (Number(pendingWithoutSession?.count || 0) === 0) {
            addResult(report, "checkout", "pass", "All pending purchases have a Stripe session id");
        } else {
            addResult(report, "checkout", "warn", "Some pending purchases are missing a Stripe session id", `${pendingWithoutSession.count} purchase(s)`);
        }

        const missingSubscriptionIds = await dbGet(
            database,
            `SELECT COUNT(*) AS count
             FROM purchases
             WHERE status IN (?, ?)
               AND (stripeSubscriptionId IS NULL OR TRIM(stripeSubscriptionId) = '')`,
            [PURCHASE_STATUS.PAID, PURCHASE_STATUS.COMPLETED]
        );

        if (Number(missingSubscriptionIds?.count || 0) === 0) {
            addResult(report, "stripe", "pass", "Paid and completed purchases have Stripe subscription ids");
        } else {
            addResult(report, "stripe", "warn", "Some paid or completed purchases are missing Stripe subscription ids", `${missingSubscriptionIds.count} purchase(s)`);
        }

        const completedWithoutName = await dbGet(
            database,
            `SELECT COUNT(*) AS count
             FROM purchases
             WHERE status = ?
               AND (serverName IS NULL OR TRIM(serverName) = '')`,
            [PURCHASE_STATUS.COMPLETED]
        );

        if (Number(completedWithoutName?.count || 0) === 0) {
            addResult(report, "setup", "pass", "Completed purchases all have a server name");
        } else {
            addResult(report, "setup", "warn", "Some completed purchases are missing a server name", `${completedWithoutName.count} purchase(s)`);
        }

        const unreleasedTerminalSubscriptions = await dbGet(
            database,
            `SELECT COUNT(*) AS count
             FROM purchases p
             JOIN servers s ON s.id = p.serverId
             WHERE p.status = ?
               AND p.stripeSubscriptionStatus IN (${Array.from(TERMINAL_SUBSCRIPTION_STATUSES).map(() => "?").join(", ")})
               AND s.status <> 'available'`,
            [PURCHASE_STATUS.COMPLETED, ...Array.from(TERMINAL_SUBSCRIPTION_STATUSES)]
        );

        if (Number(unreleasedTerminalSubscriptions?.count || 0) === 0) {
            addResult(report, "policy", "pass", "Completed purchases with terminal subscriptions have released inventory");
        } else {
            addResult(report, "policy", "warn", "Some terminal subscriptions still have allocated inventory", `${unreleasedTerminalSubscriptions.count} purchase(s)`);
        }

        const policyCandidates = await dbAll(
            database,
            `SELECT id, status, stripeSubscriptionStatus, createdAt, subscriptionDelinquentAt, serviceSuspendedAt
             FROM purchases
             WHERE subscriptionDelinquentAt IS NOT NULL
                OR serviceSuspendedAt IS NOT NULL
                OR stripeSubscriptionStatus IN (${Array.from(new Set([
                    ...ACTIVE_SUBSCRIPTION_STATUSES,
                    ...TERMINAL_SUBSCRIPTION_STATUSES
                ])).map(() => "?").join(", ")})`,
            Array.from(new Set([
                ...ACTIVE_SUBSCRIPTION_STATUSES,
                ...TERMINAL_SUBSCRIPTION_STATUSES
            ]))
        );

        let graceCount = 0;
        let suspensionCount = 0;
        let purgeCount = 0;

        for (const purchase of policyCandidates) {
            const policy = getPurchasePolicyState(purchase);

            if (policy.inGracePeriod) graceCount += 1;
            if (policy.suspensionRequired) suspensionCount += 1;
            if (policy.purgeRequired) purgeCount += 1;
        }

        addResult(report, "policy", "info", "Renewal policy counts", `grace=${graceCount}, suspend=${suspensionCount}, purge=${purgeCount}`);

        if (suspensionCount > 0) {
            addResult(report, "policy", "warn", "Some purchases are past grace period and need suspension review", `${suspensionCount} purchase(s)`);
        }

        if (purgeCount > 0) {
            addResult(report, "policy", "warn", "Some suspended purchases have reached purge eligibility", `${purgeCount} purchase(s)`);
        }
    } catch (err) {
        addResult(report, "database", "fail", "Runtime audit could not read the database", err.message);
    } finally {
        if (database) {
            await closeDatabase(database).catch(() => {});
        }
    }

    return report;
}

async function buildReadOnlyAuditReport() {
    const configReport = await buildConfigAuditReport();
    const runtimeReport = await buildRuntimeAuditReport();

    return {
        title: "Read-Only Audit",
        generatedAt: new Date().toISOString(),
        results: [
            ...configReport.results,
            ...runtimeReport.results
        ]
    };
}

function formatReport(report) {
    const counts = summarize(report);
    const lines = [
        report.title,
        `Generated: ${report.generatedAt}`,
        `Summary: pass=${counts.pass} warn=${counts.warn} fail=${counts.fail} info=${counts.info}`
    ];

    let currentSection = "";

    for (const result of report.results) {
        if (result.section !== currentSection) {
            currentSection = result.section;
            lines.push("");
            lines.push(`${currentSection.toUpperCase()}`);
        }

        lines.push(`[${result.level.toUpperCase()}] ${result.summary}`);

        if (result.details) {
            lines.push(`  ${result.details}`);
        }
    }

    return lines.join("\n");
}

module.exports = {
    buildConfigAuditReport,
    buildRuntimeAuditReport,
    buildReadOnlyAuditReport,
    formatReport,
    summarize
};
