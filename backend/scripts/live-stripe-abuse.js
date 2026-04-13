const {
    apiRequest,
    createContext,
    dbAll,
    dbGet,
    fillHostedCheckout,
    findPurchaseByServerName,
    getBaseUrl,
    gotoPricing,
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

async function countPendingHeld() {
    const row = await dbGet(
        `SELECT COUNT(*) AS count
         FROM purchases p
         JOIN servers s ON s.id = p.serverId
         WHERE p.status = 'checkout_pending' AND s.status = 'held'`
    );

    return Number(row?.count || 0);
}

async function latestPendingPurchases(limit = 10) {
    return dbAll(
        `SELECT p.id, p.serverId, p.status, p.stripeSessionId, p.createdAt, s.type AS serverType, s.status AS serverStatus
         FROM purchases p
         JOIN servers s ON s.id = p.serverId
         WHERE p.status = 'checkout_pending'
         ORDER BY p.id DESC
         LIMIT ?`,
        [limit]
    );
}

async function scenarioPendingSetupBlocked(browser, baseUrl, evidenceDir) {
    const context = await createContext(browser);
    const page = await context.newPage();

    try {
        const checkoutUrl = await startCheckoutThroughUi(page, baseUrl, "2GB");
        await page.goto(`${baseUrl}/success`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
        await snap(page, evidenceDir, "pending-setup-status");

        const statusText = await page.locator("#status").innerText();
        const disabled = await page.locator("#serverName").isDisabled();

        const completeAttempt = await apiRequest(page, "/api/complete-setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serverName: "should-not-save" })
        });

        return {
            name: "pending_setup_blocked",
            ok: disabled && completeAttempt.status === 400,
            details: {
                checkoutUrl,
                statusText,
                setupInputDisabled: disabled,
                completeAttempt
            }
        };
    } finally {
        await context.close();
    }
}

async function scenarioResumeConflict(browser, baseUrl) {
    const context = await createContext(browser);
    const page = await context.newPage();

    try {
        const firstCheckoutUrl = await startCheckoutThroughUi(page, baseUrl, "2GB");
        await gotoPricing(page, baseUrl);

        const samePlanResume = await apiRequest(page, "/api/create-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planType: "2GB" })
        });

        const differentPlanConflict = await apiRequest(page, "/api/create-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planType: "4GB" })
        });

        const pending = await latestPendingPurchases(5);

        return {
            name: "resume_conflict_and_no_second_hold",
            ok: samePlanResume.ok &&
                samePlanResume.json?.url === firstCheckoutUrl &&
                differentPlanConflict.status === 409 &&
                Boolean(differentPlanConflict.json?.resumeUrl),
            details: {
                firstCheckoutUrl,
                samePlanResume,
                differentPlanConflict,
                latestPending: pending
            }
        };
    } finally {
        await context.close();
    }
}

async function scenarioParallelTabsDuplicateHold(browser, baseUrl) {
    const context = await createContext(browser);
    const pageOne = await context.newPage();
    const pageTwo = await context.newPage();

    try {
        await Promise.all([gotoPricing(pageOne, baseUrl), gotoPricing(pageTwo, baseUrl)]);

        const before = await countPendingHeld();

        const [first, second] = await Promise.all([
            apiRequest(pageOne, "/api/create-checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ planType: "2GB" })
            }),
            apiRequest(pageTwo, "/api/create-checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ planType: "2GB" })
            })
        ]);

        const after = await countPendingHeld();

        return {
            name: "parallel_tabs_duplicate_hold",
            ok: first.ok &&
                second.ok &&
                Boolean(first.json?.url) &&
                first.json?.url === second.json?.url &&
                after - before === 1,
            details: {
                before,
                after,
                delta: after - before,
                first,
                second
            }
        };
    } finally {
        await context.close();
    }
}

async function scenarioSetupDoubleSubmitLocked(browser, baseUrl) {
    const context = await createContext(browser);
    const page = await context.newPage();
    const serverName = makeRunId("autotest-abuse");

    try {
        await startCheckoutThroughUi(page, baseUrl, "2GB");
        await fillHostedCheckout(page, FORM_VALUES);
        await submitHostedCheckout(page, baseUrl);
        await waitForSetupReady(page);
        await submitServerDetails(page, serverName);

        const secondAttempt = await apiRequest(page, "/api/complete-setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serverName: `${serverName}-changed` })
        });

        const purchase = await findPurchaseByServerName(serverName);

        return {
            name: "setup_double_submit_locked",
            ok: secondAttempt.status === 400 && purchase?.serverName === serverName,
            details: {
                secondAttempt,
                purchase: purchase
                    ? {
                        id: purchase.id,
                        status: purchase.status,
                        serverName: purchase.serverName,
                        stripeSubscriptionStatus: purchase.stripeSubscriptionStatus
                    }
                    : null
            }
        };
    } finally {
        await context.close();
    }
}

async function scenarioSuccessWithoutCookie(browser, baseUrl, evidenceDir) {
    const primaryContext = await createContext(browser);
    const primaryPage = await primaryContext.newPage();
    const serverName = makeRunId("autotest-cookie");

    try {
        await startCheckoutThroughUi(primaryPage, baseUrl, "2GB");
        await fillHostedCheckout(primaryPage, FORM_VALUES);
        await submitHostedCheckout(primaryPage, baseUrl);
        await waitForSetupReady(primaryPage);

        const secondContext = await createContext(browser);
        const secondPage = await secondContext.newPage();

        try {
            await secondPage.goto(`${baseUrl}/success`, { waitUntil: "domcontentloaded" });
            await secondPage.waitForTimeout(1500);
            await snap(secondPage, evidenceDir, "success-without-cookie");

            const statusText = await secondPage.locator("#status").innerText();
            const leadText = await secondPage.locator("#lead").innerText();
            const blocked = /active setup session|not valid|couldn't find/i.test(leadText) ||
                /active setup session|not valid|couldn't find/i.test(statusText);

            await submitServerDetails(primaryPage, serverName);

            return {
                name: "success_without_cookie_is_blocked",
                ok: blocked,
                details: {
                    leadText,
                    statusText
                }
            };
        } finally {
            await secondContext.close();
        }
    } finally {
        await primaryContext.close();
    }
}

async function main() {
    const baseUrl = getBaseUrl();
    const browser = await launchBrowser({
        headless: !process.argv.includes("--headed")
    });
    const evidenceDir = process.argv.includes("--screenshots")
        ? "/tmp/oberynn-live-stripe-abuse"
        : "";

    try {
        const results = [];

        results.push(await scenarioPendingSetupBlocked(browser, baseUrl, evidenceDir));
        results.push(await scenarioResumeConflict(browser, baseUrl));
        results.push(await scenarioParallelTabsDuplicateHold(browser, baseUrl));
        results.push(await scenarioSetupDoubleSubmitLocked(browser, baseUrl));
        results.push(await scenarioSuccessWithoutCookie(browser, baseUrl, evidenceDir));

        const failed = results.filter(result => !result.ok);

        console.log(JSON.stringify({
            ok: failed.length === 0,
            baseUrl,
            results
        }, null, 2));

        if (failed.length > 0) {
            process.exitCode = 1;
        }
    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error("LIVE_STRIPE_ABUSE_FAILED");
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
