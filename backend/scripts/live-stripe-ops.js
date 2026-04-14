const path = require("path");
const dotenv = require("dotenv");

const { createStripeClient } = require("../lib/stripeClient");
const {
    createContext,
    dbGet,
    dbRun,
    fillHostedCheckout,
    findPurchaseByServerName,
    getBaseUrl,
    launchBrowser,
    makeRunId,
    startCheckoutThroughUi,
    submitHostedCheckout,
    submitServerDetails,
    waitForSetupReady
} = require("./lib/liveStripeHarness");
const { getPurchasePolicyState } = require("../services/policyRules");

dotenv.config({ path: path.join(__dirname, "../.env") });

const stripe = createStripeClient(
    process.env.STRIPE_SECRET_KEY,
    (process.env.STRIPE_API_VERSION || "").trim()
);
const baseUrl = getBaseUrl();
const adminKey = process.env.ADMIN_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const FORM_VALUES = {
    email: "stripe@test.com",
    cardNumber: "4242 4242 4242 4242",
    cardExpiry: "09 / 29",
    cardCvc: "000",
    billingName: "autotest",
    billingCountry: "US",
    billingPostalCode: "99999",
    saveInformation: false
};

function parseSessionId(url) {
    return url.match(/\/c\/pay\/(cs_[A-Za-z0-9_]+)/)?.[1] || "";
}

function createSignedWebhookHeader(payload) {
    return stripe.webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret
    });
}

function getSetCookie(response) {
    const cookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);

    return cookies.map(cookie => cookie.split(";")[0]).join("; ");
}

async function postSignedWebhook(event) {
    const payload = JSON.stringify(event);
    const signature = createSignedWebhookHeader(payload);

    const response = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": signature
        },
        body: payload
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
}

async function adminLogin() {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: baseUrl,
            "user-agent": "StripeOpsDrill/1.0"
        },
        body: JSON.stringify({ key: adminKey })
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
        json,
        cookie: getSetCookie(response)
    };
}

async function fetchPurchaseForSession(sessionId) {
    return dbGet(
        `SELECT p.*, s.status AS serverStatus, s.type AS serverType, s.price AS serverPrice
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.stripeSessionId = ?
         ORDER BY p.id DESC
         LIMIT 1`,
        [sessionId]
    );
}

async function waitFor(predicate, timeoutMs = 30000, intervalMs = 1000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const value = await predicate();

        if (value) {
            return value;
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error("Timed out waiting for condition.");
}

async function createPaidPurchase(options = {}) {
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const context = await createContext(browser, {
        viewport: options.viewport
    });
    const page = await context.newPage();
    const serverName = makeRunId(options.serverNamePrefix || "autotest-ops");

    try {
        const checkoutUrl = await startCheckoutThroughUi(page, baseUrl, options.planType || "2GB");
        await fillHostedCheckout(page, FORM_VALUES);
        await submitHostedCheckout(page, baseUrl);
        await waitForSetupReady(page);
        const finalStatus = await submitServerDetails(page, serverName);
        const purchase = await findPurchaseByServerName(serverName);

        return {
            checkoutUrl,
            finalUrl: page.url(),
            finalStatus,
            purchase
        };
    } finally {
        await context.close();
        await browser.close();
    }
}

async function scenarioOutageReconcile() {
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const context = await createContext(browser);
    const page = await context.newPage();

    let checkoutUrl = "";
    let sessionId = "";

    try {
        await page.route("**/success*", route => route.abort());
        checkoutUrl = await startCheckoutThroughUi(page, baseUrl, "2GB");
        sessionId = parseSessionId(checkoutUrl);
        await fillHostedCheckout(page, FORM_VALUES);
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(6000);
    } finally {
        await context.close();
        await browser.close();
    }

    const before = await fetchPurchaseForSession(sessionId);
    const login = await adminLogin();

    const reconcileResponse = await fetch(`${baseUrl}/api/admin/purchases/${before.id}/reconcile-stripe`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: baseUrl,
            cookie: login.cookie,
            "user-agent": "StripeOpsDrill/1.0"
        },
        body: JSON.stringify({ adminNote: "Webhook outage drill" })
    });
    const reconcileJson = await reconcileResponse.json();
    const after = await fetchPurchaseForSession(sessionId);

    return {
        ok: login.ok && reconcileResponse.ok && before?.status === "checkout_pending" && after?.status === "paid",
        checkoutUrl,
        sessionId,
        before,
        login,
        reconcile: {
            status: reconcileResponse.status,
            body: reconcileJson
        },
        after
    };
}

async function scenarioExpiryRelease() {
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const context = await createContext(browser);
    const page = await context.newPage();

    let checkoutUrl = "";
    let sessionId = "";

    try {
        checkoutUrl = await startCheckoutThroughUi(page, baseUrl, "2GB");
        sessionId = parseSessionId(checkoutUrl);
    } finally {
        await context.close();
        await browser.close();
    }

    await stripe.checkout.sessions.expire(sessionId);

    const purchase = await waitFor(async () => {
        const row = await fetchPurchaseForSession(sessionId);
        if (row?.status === "expired" && row?.serverStatus === "available") {
            return row;
        }

        return null;
    }, 30000, 1000);

    return {
        ok: true,
        checkoutUrl,
        sessionId,
        purchase
    };
}

async function scenarioSubscriptionPolicy() {
    const paid = await createPaidPurchase({
        serverNamePrefix: "autotest-policy"
    });
    const purchase = paid.purchase;

    const failedEvent = {
        id: `evt_test_failed_${Date.now()}`,
        type: "invoice.payment_failed",
        data: {
            object: {
                id: `in_test_failed_${Date.now()}`,
                subscription: purchase.stripeSubscriptionId,
                customer: purchase.stripeCustomerId,
                lines: {
                    data: [
                        {
                            price: {
                                id: purchase.stripePriceId
                            }
                        }
                    ]
                }
            }
        }
    };

    const failedResponse = await postSignedWebhook(failedEvent);
    const afterFailure = await waitFor(async () => {
        const row = await fetchPurchaseForSession(purchase.stripeSessionId);
        if (row?.subscriptionDelinquentAt) {
            return row;
        }

        return null;
    }, 15000, 500);

    await dbRun(
        "UPDATE purchases SET subscriptionDelinquentAt = ?, serviceSuspendedAt = NULL WHERE id = ?",
        [Date.now() - (8 * 24 * 60 * 60 * 1000), purchase.id]
    );
    const suspensionPolicy = getPurchasePolicyState(await fetchPurchaseForSession(purchase.stripeSessionId));

    await dbRun(
        "UPDATE purchases SET serviceSuspendedAt = ? WHERE id = ?",
        [Date.now() - (31 * 24 * 60 * 60 * 1000), purchase.id]
    );
    const purgePolicy = getPurchasePolicyState(await fetchPurchaseForSession(purchase.stripeSessionId));

    const paidEvent = {
        id: `evt_test_paid_${Date.now()}`,
        type: "invoice.paid",
        data: {
            object: {
                id: `in_test_paid_${Date.now()}`,
                subscription: purchase.stripeSubscriptionId,
                customer: purchase.stripeCustomerId,
                lines: {
                    data: [
                        {
                            price: {
                                id: purchase.stripePriceId
                            }
                        }
                    ]
                }
            }
        }
    };

    const paidResponse = await postSignedWebhook(paidEvent);
    const afterPaid = await waitFor(async () => {
        const row = await fetchPurchaseForSession(purchase.stripeSessionId);
        if (!row?.subscriptionDelinquentAt && !row?.serviceSuspendedAt) {
            return row;
        }

        return null;
    }, 15000, 500);

    return {
        ok: failedResponse.ok &&
            paidResponse.ok &&
            Boolean(afterFailure?.subscriptionDelinquentAt) &&
            suspensionPolicy.suspensionRequired === true &&
            purgePolicy.purgeRequired === true &&
            Boolean(afterPaid),
        purchase: {
            id: purchase.id,
            stripeSessionId: purchase.stripeSessionId,
            stripeSubscriptionId: purchase.stripeSubscriptionId
        },
        failedResponse,
        afterFailure,
        suspensionPolicy,
        purgePolicy,
        paidResponse,
        afterPaid
    };
}

async function scenarioCancelAtPeriodEnd() {
    const paid = await createPaidPurchase({
        serverNamePrefix: "autotest-cancel"
    });
    const purchase = paid.purchase;

    await stripe.subscriptions.update(purchase.stripeSubscriptionId, {
        cancel_at_period_end: true
    });

    const cancelling = await waitFor(async () => {
        const row = await fetchPurchaseForSession(purchase.stripeSessionId);
        if (Number(row?.stripeCancelAtPeriodEnd) === 1) {
            return row;
        }

        return null;
    }, 30000, 1000);

    await stripe.subscriptions.update(purchase.stripeSubscriptionId, {
        cancel_at_period_end: false
    });

    const resumed = await waitFor(async () => {
        const row = await fetchPurchaseForSession(purchase.stripeSessionId);
        if (Number(row?.stripeCancelAtPeriodEnd) === 0) {
            return row;
        }

        return null;
    }, 30000, 1000);

    return {
        ok: Boolean(cancelling) && Boolean(resumed),
        purchase: {
            id: purchase.id,
            stripeSessionId: purchase.stripeSessionId,
            stripeSubscriptionId: purchase.stripeSubscriptionId
        },
        cancelling,
        resumed
    };
}

async function scenarioMobilePass() {
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const context = await createContext(browser, {
        viewport: { width: 390, height: 844 }
    });
    const page = await context.newPage();
    const serverName = makeRunId("autotest-mobile");

    try {
        await page.setExtraHTTPHeaders({
            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        });
        const checkoutUrl = await startCheckoutThroughUi(page, baseUrl, "2GB");
        await fillHostedCheckout(page, FORM_VALUES);
        await submitHostedCheckout(page, baseUrl);
        await waitForSetupReady(page);
        const finalStatus = await submitServerDetails(page, serverName);
        const purchase = await findPurchaseByServerName(serverName);

        return {
            ok: Boolean(purchase),
            checkoutUrl,
            finalUrl: page.url(),
            finalStatus,
            purchase
        };
    } finally {
        await context.close();
        await browser.close();
    }
}

const scenarios = {
    "outage-reconcile": scenarioOutageReconcile,
    "expiry-release": scenarioExpiryRelease,
    "subscription-policy": scenarioSubscriptionPolicy,
    "cancel-at-period-end": scenarioCancelAtPeriodEnd,
    "mobile-pass": scenarioMobilePass
};

async function main() {
    const scenarioName = process.argv[2];
    const scenario = scenarios[scenarioName];

    if (!scenario) {
        console.error(`Unknown scenario: ${scenarioName}`);
        process.exit(1);
    }

    const result = await scenario();
    console.log(JSON.stringify({
        ok: result.ok,
        scenario: scenarioName,
        baseUrl,
        result
    }, null, 2));

    if (!result.ok) {
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error("LIVE_STRIPE_OPS_FAILED");
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
