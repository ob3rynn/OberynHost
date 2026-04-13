const {
    createContext,
    fillHostedCheckout,
    findPurchaseByServerName,
    getBaseUrl,
    launchBrowser,
    makeRunId,
    snap,
    startCheckoutThroughUi,
    submitHostedCheckout,
    submitServerDetails,
    waitForSetupReady
} = require("./lib/liveStripeHarness");

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

async function main() {
    const baseUrl = getBaseUrl();
    const planType = process.argv.includes("--4gb") ? "4GB" : "2GB";
    const screenshotDir = process.argv.includes("--screenshots")
        ? "/tmp/oberynn-live-stripe"
        : "";
    const serverName = makeRunId("autotest-live");
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const context = await createContext(browser);
    const page = await context.newPage();

    try {
        const checkoutUrl = await startCheckoutThroughUi(page, baseUrl, planType);
        await snap(page, screenshotDir, "01-stripe-form");
        await fillHostedCheckout(page, FORM_VALUES);
        await snap(page, screenshotDir, "02-stripe-filled");
        await submitHostedCheckout(page, baseUrl);
        await snap(page, screenshotDir, "03-success");
        await waitForSetupReady(page);
        const finalStatus = await submitServerDetails(page, serverName);
        await snap(page, screenshotDir, "04-complete");

        const purchase = await findPurchaseByServerName(serverName);

        if (!purchase) {
            throw new Error("Purchase record was not found after successful setup.");
        }

        console.log(JSON.stringify({
            ok: true,
            baseUrl,
            checkoutUrl,
            finalUrl: page.url(),
            finalStatus,
            purchase: {
                id: purchase.id,
                status: purchase.status,
                serverId: purchase.serverId,
                serverStatus: purchase.serverStatus,
                serverType: purchase.serverType,
                email: purchase.email,
                serverName: purchase.serverName,
                stripeSessionId: purchase.stripeSessionId,
                stripeCustomerId: purchase.stripeCustomerId,
                stripeSubscriptionId: purchase.stripeSubscriptionId,
                stripeSubscriptionStatus: purchase.stripeSubscriptionStatus,
                stripeCurrentPeriodEnd: purchase.stripeCurrentPeriodEnd,
                stripeCancelAtPeriodEnd: purchase.stripeCancelAtPeriodEnd,
                stripePriceId: purchase.stripePriceId
            }
        }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error("LIVE_STRIPE_CHECKOUT_FAILED");
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
