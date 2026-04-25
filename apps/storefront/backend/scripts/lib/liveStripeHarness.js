const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { chromium } = require("playwright");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

function resolveDatabasePath() {
    const configuredDatabasePath = (process.env.DATABASE_PATH || "").trim();

    if (!configuredDatabasePath) {
        return path.join(__dirname, "../../data.db");
    }

    return path.isAbsolute(configuredDatabasePath)
        ? configuredDatabasePath
        : path.resolve(__dirname, "../../", configuredDatabasePath);
}

function createDatabase() {
    return new sqlite3.Database(resolveDatabasePath());
}

function dbGet(sql, params = []) {
    const db = createDatabase();

    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            db.close();

            if (err) {
                reject(err);
                return;
            }

            resolve(row || null);
        });
    });
}

function dbAll(sql, params = []) {
    const db = createDatabase();

    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            db.close();

            if (err) {
                reject(err);
                return;
            }

            resolve(rows || []);
        });
    });
}

function dbRun(sql, params = []) {
    const db = createDatabase();

    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            db.close();

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

function getBaseUrl() {
    return (process.env.BASE_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
}

function makeRunId(prefix = "autotest") {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function launchBrowser(options = {}) {
    return chromium.launch({
        headless: options.headless !== false
    });
}

async function createContext(browser, options = {}) {
    return browser.newContext({
        viewport: options.viewport || { width: 1280, height: 900 }
    });
}

async function snap(page, dir, name) {
    if (!dir) return;

    await page.screenshot({
        path: path.join(dir, `${name}.png`),
        fullPage: true
    }).catch(() => {});
}

async function gotoPricing(page, baseUrl) {
    await page.goto(`${baseUrl}/pricing`, {
        waitUntil: "domcontentloaded",
        timeout: 30000
    });
    await page.waitForTimeout(1000);
}

async function clickPlanCheckout(page, planType) {
    const planCard = page.locator(".plan-card", {
        has: page.locator(`text=${planType}`)
    }).first();

    const button = planCard.locator("button:has-text('Start Checkout')");
    await button.click();
}

async function startCheckoutThroughUi(page, baseUrl, planType) {
    await gotoPricing(page, baseUrl);
    await clickPlanCheckout(page, planType);
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
    await page.waitForTimeout(1000);
    return page.url();
}

async function apiRequest(page, requestPath, options = {}) {
    return page.evaluate(async ({ requestPath: pathValue, optionsValue }) => {
        const response = await fetch(pathValue, {
            method: optionsValue.method || "GET",
            headers: optionsValue.headers || {},
            body: optionsValue.body || undefined
        });

        let json = null;

        try {
            json = await response.json();
        } catch {
            json = null;
        }

        return {
            status: response.status,
            ok: response.ok,
            json
        };
    }, {
        requestPath,
        optionsValue: options
    });
}

async function fillHostedCheckout(page, values) {
    await page.locator('input[name="email"]').fill(values.email);
    await page.locator('input[name="cardNumber"]').fill(values.cardNumber);
    await page.locator('input[name="cardExpiry"]').fill(values.cardExpiry);
    await page.locator('input[name="cardCvc"]').fill(values.cardCvc);
    await page.locator('input[name="billingName"]').fill(values.billingName);
    await page.locator('select[name="billingCountry"]').selectOption(values.billingCountry);
    await page.locator('input[name="billingPostalCode"]').fill(values.billingPostalCode);

    const saveInfo = page.locator('input[name="enableStripePass"]');

    if (await saveInfo.count()) {
        if (values.saveInformation) {
            await saveInfo.check();
        } else if (await saveInfo.isChecked()) {
            await saveInfo.uncheck();
        }
    }
}

async function submitHostedCheckout(page, baseUrl) {
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/success`), {
        timeout: 45000
    });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
}

async function waitForSetupReady(page, timeoutMs = 30000) {
    const serverNameInput = page.locator("#serverName");
    await serverNameInput.waitFor({ state: "visible", timeout: 20000 });

    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (!(await serverNameInput.isDisabled())) {
            return;
        }

        const statusText = await page.locator("#status").innerText().catch(() => "");

        if (/not valid|couldn't find|expired|error/i.test(statusText)) {
            throw new Error(`Setup page entered an invalid state: ${statusText}`);
        }

        await page.waitForTimeout(2000);
    }

    throw new Error(`Server name input never became editable. Final status: ${await page.locator("#status").innerText()}`);
}

function buildDefaultPelicanUsername(serverName) {
    const normalized = String(serverName || "autotest")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
        .slice(0, 32)
        .replace(/[^A-Za-z0-9]+$/g, "");

    return normalized.length >= 3 ? normalized : `user${Date.now().toString().slice(-8)}`;
}

async function submitServerDetails(page, serverName, options = {}) {
    const minecraftVersion = options.minecraftVersion || "1.20.6";
    const pelicanUsername = options.pelicanUsername || buildDefaultPelicanUsername(serverName);
    const pelicanPassword = options.pelicanPassword || `${serverName}-password1`;

    await page.locator("#serverName").fill(serverName);
    await page.locator("#minecraftVersion").selectOption(minecraftVersion);

    if (await page.locator("#pelicanUsername:enabled").count()) {
        await page.locator("#pelicanUsername").fill(pelicanUsername);
        await page.locator("#pelicanPassword").fill(pelicanPassword);
    }

    await page.locator("#completeBtn").click();

    const startedAt = Date.now();

    while (Date.now() - startedAt < 15000) {
        const statusText = await page.locator("#status").innerText().catch(() => "");

        if (/all set|watch your email/i.test(statusText)) {
            return statusText;
        }

        await page.waitForTimeout(500);
    }

    throw new Error(`Setup confirmation did not appear. Final status: ${await page.locator("#status").innerText()}`);
}

async function findPurchaseByServerName(serverName) {
    return dbGet(
        `SELECT p.*, s.status AS serverStatus, s.type AS serverType
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.serverName = ?
         ORDER BY p.id DESC
         LIMIT 1`,
        [serverName]
    );
}

async function latestPurchases(limit = 10) {
    return dbAll(
        `SELECT p.*, s.status AS serverStatus, s.type AS serverType
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         ORDER BY p.id DESC
         LIMIT ?`,
        [limit]
    );
}

module.exports = {
    apiRequest,
    buildDefaultPelicanUsername,
    createContext,
    dbAll,
    dbGet,
    dbRun,
    fillHostedCheckout,
    findPurchaseByServerName,
    getBaseUrl,
    gotoPricing,
    latestPurchases,
    launchBrowser,
    makeRunId,
    snap,
    startCheckoutThroughUi,
    submitHostedCheckout,
    submitServerDetails,
    waitForSetupReady
};
