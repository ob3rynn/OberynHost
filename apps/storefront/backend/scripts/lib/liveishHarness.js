const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const dotenv = require("dotenv");

const { PLAN_DEFINITIONS } = require("../../config/plans");

const BACKEND_ROOT = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(BACKEND_ROOT, ".env");
const LIVEISH_ENV_PATH = path.join(BACKEND_ROOT, ".env.liveish");
const LIVEISH_PLAN_TYPE = "paper-2gb";
const LIVEISH_PRODUCT_CODE = "minecraft-paper-2gb";
const LIVEISH_DISPLAY_NAME = "Paper 2 GB";
const LIVEISH_CONTAINER_MEMORY_MB = 2424;
const LIVEISH_JVM_MEMORY_MB = 2024;
const LIVEISH_MARKER_PREFIX = "liveish-";
const LEGACY_PRODUCT_ENV_NAMES = [
    "STRIPE_PRICE_2GB",
    "STRIPE_PRICE_3GB",
    "STRIPE_PRICE_4GB"
];

function loadHarnessEnv() {
    if (fs.existsSync(ENV_PATH)) {
        dotenv.config({ path: ENV_PATH, override: false, quiet: true });
    }

    if (fs.existsSync(LIVEISH_ENV_PATH)) {
        dotenv.config({ path: LIVEISH_ENV_PATH, override: true, quiet: true });
    }
}

function resolveDatabasePath(env = process.env) {
    const configuredDatabasePath = String(env.DATABASE_PATH || "").trim();

    if (!configuredDatabasePath) {
        return path.join(BACKEND_ROOT, "data.db");
    }

    return path.isAbsolute(configuredDatabasePath)
        ? configuredDatabasePath
        : path.resolve(BACKEND_ROOT, configuredDatabasePath);
}

function createDatabase(databasePath = resolveDatabasePath()) {
    return new sqlite3.Database(databasePath);
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

function dbRun(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function onRun(err) {
            if (err) {
                reject(err);
                return;
            }

            resolve({
                lastID: this.lastID,
                changes: this.changes
            });
        });
    });
}

function randomSuffix(length = 6) {
    return Math.random().toString(36).slice(2, 2 + length);
}

function createLiveishMarker(label = "") {
    const timestamp = new Date()
        .toISOString()
        .replace(/[-:TZ.]/g, "")
        .slice(0, 14);
    const suffix = randomSuffix();
    const normalizedLabel = String(label || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 12);

    return [
        LIVEISH_MARKER_PREFIX.replace(/-$/, ""),
        timestamp,
        normalizedLabel,
        suffix
    ].filter(Boolean).join("-");
}

function isLiveishValue(value) {
    return String(value || "").trim().toLowerCase().startsWith(LIVEISH_MARKER_PREFIX);
}

function isMarkedLiveishPurchase(purchase = {}) {
    return [
        purchase.email,
        purchase.serverName,
        purchase.hostname,
        purchase.hostnameReservationKey
    ].some(isLiveishValue);
}

function getLiveishPlan() {
    return PLAN_DEFINITIONS[LIVEISH_PLAN_TYPE] || null;
}

function getProductTruthErrors() {
    const errors = [];
    const planEntries = Object.entries(PLAN_DEFINITIONS);
    const plan = getLiveishPlan();

    if (planEntries.length !== 1) {
        errors.push(`expected exactly one launch product, found ${planEntries.length}`);
    }

    if (!plan) {
        errors.push(`missing ${LIVEISH_PLAN_TYPE} launch product`);
        return errors;
    }

    if (plan.code !== LIVEISH_PRODUCT_CODE) {
        errors.push(`active product code must be ${LIVEISH_PRODUCT_CODE}`);
    }

    if (plan.displayName !== LIVEISH_DISPLAY_NAME) {
        errors.push(`active display name must be ${LIVEISH_DISPLAY_NAME}`);
    }

    if (plan.runtimeFamily !== "paper") {
        errors.push("active runtime family must be paper");
    }

    if (Number(plan.containerMemoryMb) !== LIVEISH_CONTAINER_MEMORY_MB) {
        errors.push(`container memory must be ${LIVEISH_CONTAINER_MEMORY_MB} MB`);
    }

    if (Number(plan.jvmMemoryMb) !== LIVEISH_JVM_MEMORY_MB) {
        errors.push(`JVM target must be ${LIVEISH_JVM_MEMORY_MB} MB`);
    }

    return errors;
}

function parseJsonObject(rawValue, name) {
    let parsed;

    try {
        parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    } catch {
        return {
            parsed: null,
            errors: [`${name} must be valid JSON`]
        };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            parsed: null,
            errors: [`${name} must be an object`]
        };
    }

    return {
        parsed,
        errors: []
    };
}

function targetValueContains(value, expected) {
    if (value === null || value === undefined) {
        return false;
    }

    if (typeof value === "object") {
        return Object.values(value).some(entry => targetValueContains(entry, expected));
    }

    return String(value).includes(String(expected));
}

function targetContainsJvmTarget(target, jvmMemoryMb = LIVEISH_JVM_MEMORY_MB) {
    return targetValueContains(target.startup, jvmMemoryMb) ||
        targetValueContains(target.environment, jvmMemoryMb) ||
        targetValueContains(target.environmentByRuntimeProfile, jvmMemoryMb);
}

function validateLiveishTargetConfig(rawValue, options = {}) {
    const name = options.name || "PELICAN_PROVISIONING_TARGETS_JSON";
    const parsedResult = parseJsonObject(rawValue, name);
    const errors = [...parsedResult.errors];
    const warnings = [];
    const parsed = parsedResult.parsed;
    const plan = getLiveishPlan();
    const requiredTargetCodes = options.requiredTargetCodes ||
        [plan?.provisioningTargetCode].filter(Boolean);

    if (!parsed) {
        return {
            ok: false,
            errors,
            warnings,
            parsed: null
        };
    }

    for (const targetCode of requiredTargetCodes) {
        const target = parsed[targetCode];

        if (!target || typeof target !== "object" || Array.isArray(target)) {
            errors.push(`missing target ${targetCode}`);
            continue;
        }

        if (!Array.isArray(target.allocationIds) || target.allocationIds.length === 0) {
            errors.push(`${targetCode}.allocationIds must contain at least one allocation`);
        }

        if (Number(target.limits?.memory) !== LIVEISH_CONTAINER_MEMORY_MB) {
            errors.push(`${targetCode}.limits.memory must be ${LIVEISH_CONTAINER_MEMORY_MB}`);
        }

        if (!targetContainsJvmTarget(target)) {
            errors.push(`${targetCode} must include JVM target ${LIVEISH_JVM_MEMORY_MB} in startup or environment`);
        }

        if (!target.egg) {
            errors.push(`${targetCode}.egg is required`);
        }

        if (!target.dockerImage) {
            errors.push(`${targetCode}.dockerImage is required`);
        }

        if (!target.startup) {
            errors.push(`${targetCode}.startup is required`);
        }
    }

    const extraTargetCodes = Object.keys(parsed).filter(code => !requiredTargetCodes.includes(code));
    if (extraTargetCodes.length > 0) {
        warnings.push(`extra target codes are present: ${extraTargetCodes.join(", ")}`);
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        parsed
    };
}

function normalizePanelUrl(panelUrl) {
    const raw = String(panelUrl || "").trim().replace(/\/+$/, "");

    if (!raw) {
        throw new Error("PELICAN_PANEL_URL is required.");
    }

    return raw;
}

async function pelicanRequest({ panelUrl, apiKey, path: requestPath, method = "GET", body = null }) {
    const baseUrl = normalizePanelUrl(panelUrl);
    const key = String(apiKey || "").trim();

    if (!key) {
        throw new Error("Pelican API key is required.");
    }

    const response = await fetch(`${baseUrl}${requestPath}`, {
        method,
        headers: {
            Accept: "Application/vnd.pterodactyl.v1+json, application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`
        },
        body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let json = null;

    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }

    if (!response.ok) {
        const suffix = text ? ` ${text.slice(0, 500)}` : "";
        throw new Error(`Pelican API ${method} ${requestPath} failed with HTTP ${response.status}.${suffix}`);
    }

    return json || {};
}

function unwrapAttributes(payload) {
    return payload?.attributes || payload?.data?.attributes || payload?.data || payload || {};
}

function encodeExternalId(value) {
    return encodeURIComponent(String(value || "").trim());
}

async function fetchPelicanServerByExternalId(panelUrl, applicationApiKey, externalId) {
    const payload = await pelicanRequest({
        panelUrl,
        apiKey: applicationApiKey,
        path: `/api/application/servers/external/${encodeExternalId(externalId)}`
    });

    return unwrapAttributes(payload);
}

async function fetchPelicanUserByExternalId(panelUrl, applicationApiKey, externalId) {
    const payload = await pelicanRequest({
        panelUrl,
        apiKey: applicationApiKey,
        path: `/api/application/users/external/${encodeExternalId(externalId)}`
    });

    return unwrapAttributes(payload);
}

async function fetchClientServerResources(panelUrl, clientApiKey, serverIdentifier) {
    return pelicanRequest({
        panelUrl,
        apiKey: clientApiKey,
        path: `/api/client/servers/${encodeURIComponent(String(serverIdentifier || "").trim())}/resources`
    });
}

async function waitFor(predicate, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 120000);
    const intervalMs = Number(options.intervalMs || 2000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const value = await predicate();

        if (value) {
            return value;
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(options.message || "Timed out waiting for live-ish harness condition.");
}

async function listMarkedLiveishPurchases(database) {
    const columns = await dbAll(database, "PRAGMA table_info(purchases)");
    const columnNames = new Set(columns.map(column => column.name));
    const markerColumns = [
        "email",
        "serverName",
        "hostname",
        "hostnameReservationKey"
    ].filter(columnName => columnNames.has(columnName));

    if (markerColumns.length === 0) {
        return [];
    }

    const markerPredicate = markerColumns
        .map(columnName => `LOWER(COALESCE(p.${columnName}, '')) LIKE 'liveish-%'`)
        .join(" OR ");
    const rows = await dbAll(
        database,
        `SELECT p.*, s.status AS serverStatus
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE ${markerPredicate}
         ORDER BY p.id ASC`
    );

    return rows.filter(isMarkedLiveishPurchase);
}

module.exports = {
    BACKEND_ROOT,
    LEGACY_PRODUCT_ENV_NAMES,
    LIVEISH_CONTAINER_MEMORY_MB,
    LIVEISH_DISPLAY_NAME,
    LIVEISH_ENV_PATH,
    LIVEISH_JVM_MEMORY_MB,
    LIVEISH_MARKER_PREFIX,
    LIVEISH_PLAN_TYPE,
    LIVEISH_PRODUCT_CODE,
    closeDatabase,
    createDatabase,
    createLiveishMarker,
    dbAll,
    dbGet,
    dbRun,
    fetchClientServerResources,
    fetchPelicanServerByExternalId,
    fetchPelicanUserByExternalId,
    getLiveishPlan,
    getProductTruthErrors,
    isLiveishValue,
    isMarkedLiveishPurchase,
    listMarkedLiveishPurchases,
    loadHarnessEnv,
    pelicanRequest,
    resolveDatabasePath,
    targetContainsJvmTarget,
    unwrapAttributes,
    validateLiveishTargetConfig,
    waitFor
};
