const {
    apiRequest,
    createContext,
    dbGet: harnessDbGet,
    fillHostedCheckout,
    getBaseUrl,
    launchBrowser,
    snap,
    startCheckoutThroughUi,
    submitHostedCheckout,
    waitForSetupReady
} = require("./lib/liveStripeHarness");
const {
    closeDatabase,
    createDatabase,
    createLiveishMarker,
    dbGet,
    dbRun,
    fetchClientServerResources,
    fetchPelicanServerByExternalId,
    fetchPelicanUserByExternalId,
    isMarkedLiveishPurchase,
    loadHarnessEnv,
    pelicanRequest,
    waitFor
} = require("./lib/liveishHarness");

const PLAN_TYPE = "paper-2gb";
const DEFAULT_MINECRAFT_VERSION = "1.20.6";
const FORM_VALUES = {
    cardNumber: "4242 4242 4242 4242",
    cardExpiry: "09 / 29",
    cardCvc: "000",
    billingName: "liveish harness",
    billingCountry: "US",
    billingPostalCode: "99999",
    saveInformation: false
};

function shouldRunLiveish(env = process.env) {
    return env.OBERYNHOST_RUN_LIVEISH === "1";
}

function makePelicanUsername(marker) {
    return `lh${String(marker).replace(/[^a-z0-9]/gi, "").slice(-24)}`.slice(0, 32);
}

function requireEnv(names, env = process.env) {
    const missing = names.filter(name => !String(env[name] || "").trim());

    if (missing.length > 0) {
        throw new Error(`Missing live-ish harness env: ${missing.join(", ")}`);
    }
}

async function findPurchaseByEmail(email) {
    return harnessDbGet(
        `SELECT p.*, s.status AS serverStatus
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.email = ?
         ORDER BY p.id DESC
         LIMIT 1`,
        [email]
    );
}

async function findPurchaseById(database, purchaseId) {
    return dbGet(
        database,
        `SELECT p.*, s.status AS serverStatus
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.id = ?`,
        [purchaseId]
    );
}

async function runCheckout(browser, baseUrl, marker, screenshotDir = "") {
    const context = await createContext(browser);
    const page = await context.newPage();
    const email = `${marker}@example.com`;

    try {
        const checkoutUrl = await startCheckoutThroughUi(page, baseUrl, PLAN_TYPE);
        await snap(page, screenshotDir, `${marker}-01-stripe-form`);
        await fillHostedCheckout(page, {
            ...FORM_VALUES,
            email
        });
        await snap(page, screenshotDir, `${marker}-02-stripe-filled`);
        await submitHostedCheckout(page, baseUrl);
        await snap(page, screenshotDir, `${marker}-03-success`);
        await waitForSetupReady(page);

        const purchase = await waitFor(async () => {
            const row = await findPurchaseByEmail(email);

            if (row?.status === "paid" && row.stripeCustomerId) {
                return row;
            }

            return null;
        }, {
            timeoutMs: 45000,
            intervalMs: 1000,
            message: "Stripe test checkout did not create a paid live-ish purchase."
        });

        return {
            context,
            page,
            checkoutUrl,
            email,
            purchase
        };
    } catch (err) {
        await context.close().catch(() => {});
        throw err;
    }
}

async function submitSetup(page, details) {
    const response = await apiRequest(page, "/api/complete-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            serverName: details.serverName,
            minecraftVersion: details.minecraftVersion || DEFAULT_MINECRAFT_VERSION,
            pelicanUsername: details.pelicanUsername || "",
            pelicanPassword: details.pelicanPassword || ""
        })
    });

    if (!response.ok || !response.json?.success) {
        throw new Error(`Setup submission failed with HTTP ${response.status}: ${JSON.stringify(response.json)}`);
    }

    return response;
}

async function waitForPendingActivation(database, purchaseId) {
    return waitFor(async () => {
        const purchase = await findPurchaseById(database, purchaseId);

        if (purchase?.fulfillmentStatus === "pending_activation") {
            return purchase;
        }

        if (
            purchase?.fulfillmentStatus === "needs_admin_review" ||
            purchase?.fulfillmentStatus === "dead_letter"
        ) {
            throw new Error(`Fulfillment stopped at ${purchase.fulfillmentStatus}: ${purchase.needsAdminReviewReason || purchase.lastProvisioningError || "no reason saved"}`);
        }

        return null;
    }, {
        timeoutMs: 180000,
        intervalMs: 2500,
        message: `Purchase ${purchaseId} did not reach pending_activation.`
    });
}

function assertPendingActivationPurchase(purchase) {
    const errors = [];

    if (!isMarkedLiveishPurchase(purchase)) errors.push("purchase is not marked as a live-ish artifact");
    if (purchase.status !== "paid") errors.push(`purchase status is ${purchase.status}, expected paid`);
    if (purchase.fulfillmentStatus !== "pending_activation") errors.push(`fulfillmentStatus is ${purchase.fulfillmentStatus}`);
    if (!purchase.pelicanUserId) errors.push("pelicanUserId is missing");
    if (!purchase.pelicanServerId) errors.push("pelicanServerId is missing");
    if (!purchase.pelicanServerIdentifier) errors.push("pelicanServerIdentifier is missing");
    if (!purchase.pelicanAllocationId) errors.push("pelicanAllocationId is missing");
    if (!purchase.desiredRoutingArtifactJson) errors.push("desired routing artifact is missing");
    if (purchase.pelicanPasswordCiphertext || purchase.pelicanPasswordIv || purchase.pelicanPasswordAuthTag) {
        errors.push("staged Pelican password fields were not cleared");
    }
    if (purchase.readyEmailQueuedAt || purchase.releasedAt || purchase.routingVerifiedAt) {
        errors.push("purchase appears to have been released automatically");
    }

    if (errors.length > 0) {
        throw new Error(errors.join("; "));
    }

    const artifact = JSON.parse(purchase.desiredRoutingArtifactJson);
    if (
        artifact.hostname !== purchase.hostname ||
        String(artifact.pelicanServerIdentifier) !== String(purchase.pelicanServerIdentifier) ||
        String(artifact.pelicanAllocationId) !== String(purchase.pelicanAllocationId)
    ) {
        throw new Error("desired routing artifact does not match the saved purchase linkage");
    }

    return artifact;
}

async function verifyApplicationApiLinkage(purchase, options = {}) {
    const panelUrl = process.env.PELICAN_PANEL_URL;
    const apiKey = process.env.PELICAN_APPLICATION_API_KEY;
    const server = await fetchPelicanServerByExternalId(panelUrl, apiKey, `purchase:${purchase.id}`);
    const user = options.expectExternalUser === false
        ? await pelicanRequest({
            panelUrl,
            apiKey,
            path: `/api/application/users/${encodeURIComponent(String(purchase.pelicanUserId))}`
        })
        : await fetchPelicanUserByExternalId(panelUrl, apiKey, `stripe:${purchase.stripeCustomerId}`);
    const userAttributes = user?.attributes || user?.data?.attributes || user?.data || user || {};

    if (String(server.id || "") !== String(purchase.pelicanServerId)) {
        throw new Error("Pelican Application API server lookup did not match local pelicanServerId.");
    }

    if (String(userAttributes.id || "") !== String(purchase.pelicanUserId)) {
        throw new Error("Pelican Application API user lookup did not match local pelicanUserId.");
    }

    return {
        serverId: server.id,
        serverIdentifier: server.identifier || server.uuid_short || server.uuid || "",
        userId: userAttributes.id,
        username: userAttributes.username || ""
    };
}

async function assertLocalCustomerLink(database, purchase) {
    const link = await dbGet(
        database,
        `SELECT *
         FROM customerPelicanLinks
         WHERE stripeCustomerId = ?`,
        [purchase.stripeCustomerId]
    );

    if (!link) {
        throw new Error("local customerPelicanLinks row was not saved");
    }

    if (String(link.pelicanUserId || "") !== String(purchase.pelicanUserId || "")) {
        throw new Error("local customerPelicanLinks row does not match purchase Pelican user id");
    }

    return link;
}

async function ensureReusableHarnessLink(database, purchase) {
    const harnessUserId = String(process.env.LIVEISH_HARNESS_PELICAN_USER_ID || "").trim();
    const harnessUsername = String(process.env.LIVEISH_HARNESS_PELICAN_USERNAME || "").trim();
    const existing = await dbGet(
        database,
        `SELECT *
         FROM customerPelicanLinks
         WHERE pelicanUsername = ? COLLATE NOCASE
           AND stripeCustomerId != ?`,
        [harnessUsername, purchase.stripeCustomerId]
    );

    if (existing) {
        throw new Error(
            `Reusable Pelican harness username ${harnessUsername} is already linked to ${existing.stripeCustomerId}. Run cleanup:liveish or choose a clean harness user.`
        );
    }

    const now = Date.now();
    await dbRun(
        database,
        `INSERT INTO customerPelicanLinks
            (stripeCustomerId, pelicanUserId, pelicanUsername, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(stripeCustomerId) DO UPDATE SET
            pelicanUserId = excluded.pelicanUserId,
            pelicanUsername = excluded.pelicanUsername,
            updatedAt = excluded.updatedAt`,
        [
            purchase.stripeCustomerId,
            harnessUserId,
            harnessUsername,
            now,
            now
        ]
    );
}

async function runFirstTimeScenario(browser, database, baseUrl, screenshotDir) {
    const marker = createLiveishMarker("first");
    const checkout = await runCheckout(browser, baseUrl, marker, screenshotDir);

    try {
        const pelicanUsername = makePelicanUsername(marker);
        await submitSetup(checkout.page, {
            serverName: marker,
            minecraftVersion: DEFAULT_MINECRAFT_VERSION,
            pelicanUsername,
            pelicanPassword: `${marker}-Password1`
        });

        const purchase = await waitForPendingActivation(database, checkout.purchase.id);
        const routingArtifact = assertPendingActivationPurchase(purchase);
        const applicationApi = await verifyApplicationApiLinkage(purchase, {
            expectExternalUser: true
        });
        const customerLink = await assertLocalCustomerLink(database, purchase);

        return {
            name: "first_time_customer",
            ok: true,
            marker,
            purchase: summarizePurchase(purchase),
            routingArtifact,
            applicationApi,
            customerLink: {
                stripeCustomerId: customerLink.stripeCustomerId,
                pelicanUserId: customerLink.pelicanUserId,
                pelicanUsername: customerLink.pelicanUsername
            }
        };
    } finally {
        await checkout.context.close();
    }
}

async function runReusableUserScenario(browser, database, baseUrl, screenshotDir) {
    const marker = createLiveishMarker("reuse");
    const checkout = await runCheckout(browser, baseUrl, marker, screenshotDir);

    try {
        await ensureReusableHarnessLink(database, checkout.purchase);
        await submitSetup(checkout.page, {
            serverName: marker,
            minecraftVersion: DEFAULT_MINECRAFT_VERSION,
            pelicanUsername: process.env.LIVEISH_HARNESS_PELICAN_USERNAME
        });

        const purchase = await waitForPendingActivation(database, checkout.purchase.id);
        const routingArtifact = assertPendingActivationPurchase(purchase);
        const applicationApi = await verifyApplicationApiLinkage(purchase, {
            expectExternalUser: false
        });
        const resources = await waitForClientServerResources(
            process.env.PELICAN_PANEL_URL,
            process.env.LIVEISH_HARNESS_PELICAN_CLIENT_API_KEY,
            purchase.pelicanServerIdentifier
        );
        const resourceAttributes = resources?.attributes || resources || {};

        if (!resourceAttributes.current_state) {
            throw new Error("Pelican Client API resources response did not include current_state.");
        }

        return {
            name: "reusable_user_client_api",
            ok: true,
            marker,
            purchase: summarizePurchase(purchase),
            routingArtifact,
            applicationApi,
            clientApi: {
                currentState: resourceAttributes.current_state,
                isSuspended: resourceAttributes.is_suspended ?? null,
                resources: resourceAttributes.resources || null
            }
        };
    } finally {
        await checkout.context.close();
    }
}

function isClientResourcesNotReadyError(err) {
    return /HTTP 409/.test(String(err?.message || "")) &&
        /not yet completed its installation process/i.test(String(err?.message || ""));
}

async function waitForClientServerResources(panelUrl, clientApiKey, serverIdentifier) {
    return waitFor(async () => {
        try {
            const resources = await fetchClientServerResources(panelUrl, clientApiKey, serverIdentifier);
            const resourceAttributes = resources?.attributes || resources || {};

            return resourceAttributes.current_state ? resources : null;
        } catch (err) {
            if (isClientResourcesNotReadyError(err)) {
                return null;
            }

            throw err;
        }
    }, {
        timeoutMs: 180000,
        intervalMs: 2500,
        message: `Pelican Client API resources were not ready for server ${serverIdentifier}.`
    });
}

function summarizePurchase(purchase) {
    return {
        id: purchase.id,
        status: purchase.status,
        setupStatus: purchase.setupStatus,
        fulfillmentStatus: purchase.fulfillmentStatus,
        serviceStatus: purchase.serviceStatus,
        serverName: purchase.serverName,
        hostname: purchase.hostname,
        stripeCustomerId: purchase.stripeCustomerId,
        stripeSubscriptionId: purchase.stripeSubscriptionId,
        pelicanUserId: purchase.pelicanUserId,
        pelicanUsername: purchase.pelicanUsername,
        pelicanServerId: purchase.pelicanServerId,
        pelicanServerIdentifier: purchase.pelicanServerIdentifier,
        pelicanAllocationId: purchase.pelicanAllocationId,
        desiredRoutingArtifactGeneratedAt: purchase.desiredRoutingArtifactGeneratedAt
    };
}

async function runSmoke() {
    requireEnv([
        "PELICAN_PANEL_URL",
        "PELICAN_APPLICATION_API_KEY",
        "LIVEISH_HARNESS_PELICAN_USER_ID",
        "LIVEISH_HARNESS_PELICAN_USERNAME",
        "LIVEISH_HARNESS_PELICAN_CLIENT_API_KEY"
    ]);

    const baseUrl = getBaseUrl();
    const screenshotDir = process.argv.includes("--screenshots")
        ? "/tmp/oberynn-liveish-fulfillment"
        : "";
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const database = createDatabase();

    try {
        const scenarios = [];
        scenarios.push(await runFirstTimeScenario(browser, database, baseUrl, screenshotDir));
        scenarios.push(await runReusableUserScenario(browser, database, baseUrl, screenshotDir));

        return {
            ok: true,
            baseUrl,
            scenarios
        };
    } finally {
        await closeDatabase(database).catch(() => {});
        await browser.close();
    }
}

async function main() {
    loadHarnessEnv();

    if (!shouldRunLiveish()) {
        console.log("LIVEISH_HARNESS_SKIPPED: set OBERYNHOST_RUN_LIVEISH=1 to run the live-ish fulfillment harness smoke.");
        return;
    }

    const result = await runSmoke();
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch(err => {
        console.error("LIVEISH_FULFILLMENT_SMOKE_FAILED");
        console.error(err && err.stack ? err.stack : String(err));
        process.exit(1);
    });
}

module.exports = {
    assertPendingActivationPurchase,
    isClientResourcesNotReadyError,
    makePelicanUsername,
    runSmoke,
    shouldRunLiveish
};
