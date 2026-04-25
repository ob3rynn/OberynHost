const { createStripeClient } = require("../lib/stripeClient");
const {
    closeDatabase,
    createDatabase,
    dbRun,
    listMarkedLiveishPurchases,
    loadHarnessEnv
} = require("./lib/liveishHarness");

function parseOptions(argv = process.argv) {
    return {
        applyLocal: argv.includes("--apply-local"),
        cancelStripe: argv.includes("--cancel-stripe"),
        forceReleaseLocalCapacityWithoutPelicanCleanup: argv.includes("--force-release-local-capacity-without-pelican-cleanup"),
        json: argv.includes("--json")
    };
}

function summarizePurchase(purchase) {
    return {
        id: purchase.id,
        status: purchase.status,
        fulfillmentStatus: purchase.fulfillmentStatus,
        serverId: purchase.serverId,
        serverStatus: purchase.serverStatus,
        email: purchase.email,
        serverName: purchase.serverName,
        hostname: purchase.hostname,
        stripeCustomerId: purchase.stripeCustomerId,
        stripeSubscriptionId: purchase.stripeSubscriptionId,
        pelicanServerId: purchase.pelicanServerId,
        pelicanServerIdentifier: purchase.pelicanServerIdentifier,
        pelicanAllocationId: purchase.pelicanAllocationId
    };
}

function hasPelicanResourceLinkage(purchase = {}) {
    return Boolean(
        String(purchase.pelicanServerId || "").trim() ||
        String(purchase.pelicanServerIdentifier || "").trim() ||
        String(purchase.pelicanAllocationId || "").trim()
    );
}

async function cancelStripeSubscriptions(purchases, options = {}) {
    if (!options.cancelStripe) {
        return [];
    }

    const stripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
    const stripeApiVersion = String(process.env.STRIPE_API_VERSION || "").trim();

    if (!stripeSecretKey) {
        throw new Error("STRIPE_SECRET_KEY is required for --cancel-stripe.");
    }

    if (!stripeSecretKey.startsWith("sk_test_")) {
        throw new Error("--cancel-stripe is only allowed with a Stripe test-mode secret key.");
    }

    const stripe = createStripeClient(stripeSecretKey, stripeApiVersion);
    const cancelled = [];

    for (const purchase of purchases) {
        const subscriptionId = String(purchase.stripeSubscriptionId || "").trim();

        if (!subscriptionId) {
            continue;
        }

        await stripe.subscriptions.cancel(subscriptionId);
        cancelled.push(subscriptionId);
    }

    return cancelled;
}

async function applyLocalCleanup(database, purchases, options = {}) {
    if (!options.applyLocal) {
        return {
            updatedPurchases: 0,
            releasedServers: 0,
            removedLinks: 0,
            manualPelicanCleanupRequired: [],
            forcedCapacityReleaseWithoutPelicanCleanup: []
        };
    }

    let updatedPurchases = 0;
    let releasedServers = 0;
    let removedLinks = 0;
    const manualPelicanCleanupRequired = [];
    const forcedCapacityReleaseWithoutPelicanCleanup = [];
    const now = Date.now();

    await dbRun(database, "BEGIN IMMEDIATE TRANSACTION");

    try {
        for (const purchase of purchases) {
            const purchaseUpdate = await dbRun(
                database,
                `UPDATE purchases
                 SET status = 'cancelled',
                     setupStatus = 'setup_submitted',
                     fulfillmentStatus = CASE
                         WHEN fulfillmentStatus = 'pending_activation' THEN 'pending_activation'
                         ELSE 'not_started'
                     END,
                     updatedAt = ?,
                     lastStateOwner = 'harness_cleanup'
                 WHERE id = ?`,
                [now, purchase.id]
            );
            updatedPurchases += purchaseUpdate.changes;

            const hasPelicanResources = hasPelicanResourceLinkage(purchase);
            const mayReleaseCapacity = purchase.serverId &&
                (!hasPelicanResources || options.forceReleaseLocalCapacityWithoutPelicanCleanup);

            if (hasPelicanResources) {
                const summary = summarizePurchase(purchase);

                if (options.forceReleaseLocalCapacityWithoutPelicanCleanup) {
                    forcedCapacityReleaseWithoutPelicanCleanup.push(summary);
                } else {
                    manualPelicanCleanupRequired.push(summary);
                }
            }

            if (mayReleaseCapacity) {
                const serverUpdate = await dbRun(
                    database,
                    `UPDATE servers
                     SET status = 'available',
                         reservationKey = NULL,
                         reservedAt = NULL,
                         allocatedAt = NULL
                     WHERE id = ?`,
                    [purchase.serverId]
                );
                releasedServers += serverUpdate.changes;
            }

            if (purchase.stripeCustomerId) {
                const linkUpdate = await dbRun(
                    database,
                    "DELETE FROM customerPelicanLinks WHERE stripeCustomerId = ?",
                    [purchase.stripeCustomerId]
                );
                removedLinks += linkUpdate.changes;
            }
        }

        await dbRun(database, "COMMIT");
    } catch (err) {
        await dbRun(database, "ROLLBACK").catch(() => {});
        throw err;
    }

    return {
        updatedPurchases,
        releasedServers,
        removedLinks,
        manualPelicanCleanupRequired,
        forcedCapacityReleaseWithoutPelicanCleanup
    };
}

async function cleanupLiveishHarness(options = {}) {
    const database = createDatabase();

    try {
        const purchases = await listMarkedLiveishPurchases(database);
        const stripeCancelled = await cancelStripeSubscriptions(purchases, options);
        const localCleanup = await applyLocalCleanup(database, purchases, options);

        return {
            ok: true,
            dryRun: !options.applyLocal && !options.cancelStripe,
            forceReleaseLocalCapacityWithoutPelicanCleanup: Boolean(
                options.forceReleaseLocalCapacityWithoutPelicanCleanup
            ),
            pelicanDestructiveCleanup: "not_implemented",
            localCleanup,
            stripeCancelled,
            candidates: purchases.map(summarizePurchase)
        };
    } finally {
        await closeDatabase(database).catch(() => {});
    }
}

function formatCleanupResult(result) {
    const lines = [
        "Live-ish harness cleanup",
        result.dryRun
            ? "Mode: dry-run. No local rows or Stripe subscriptions were changed."
            : "Mode: apply. Only marked live-ish artifacts were targeted.",
        "Pelican destructive cleanup: not implemented.",
        result.forceReleaseLocalCapacityWithoutPelicanCleanup
            ? "WARNING: forced local capacity release ran without Pelican cleanup confirmation."
            : "Local capacity with Pelican linkage is retained unless the explicit force flag is used.",
        `Candidates: ${result.candidates.length}`,
        `Local purchases updated: ${result.localCleanup.updatedPurchases}`,
        `Local servers released: ${result.localCleanup.releasedServers}`,
        `Local customer links removed: ${result.localCleanup.removedLinks}`,
        `Requires manual Pelican cleanup before local capacity release: ${result.localCleanup.manualPelicanCleanupRequired.length}`,
        `Forced local capacity releases without Pelican cleanup: ${result.localCleanup.forcedCapacityReleaseWithoutPelicanCleanup.length}`,
        `Stripe test subscriptions cancelled: ${result.stripeCancelled.length}`
    ];

    for (const candidate of result.candidates) {
        lines.push(
            `- #${candidate.id} ${candidate.serverName || candidate.email || "unnamed"} ` +
            `status=${candidate.status} fulfillment=${candidate.fulfillmentStatus || "unknown"}`
        );
    }

    for (const candidate of result.localCleanup.manualPelicanCleanupRequired) {
        lines.push(
            `- requires manual Pelican cleanup before local capacity release: ` +
            `#${candidate.id} ${candidate.serverName || candidate.email || "unnamed"}`
        );
    }

    for (const candidate of result.localCleanup.forcedCapacityReleaseWithoutPelicanCleanup) {
        lines.push(
            `- forced local capacity release without Pelican cleanup: ` +
            `#${candidate.id} ${candidate.serverName || candidate.email || "unnamed"}`
        );
    }

    return lines.join("\n");
}

async function main() {
    loadHarnessEnv();
    const options = parseOptions();
    const result = await cleanupLiveishHarness(options);

    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(formatCleanupResult(result));
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error("LIVEISH_HARNESS_CLEANUP_FAILED");
        console.error(err && err.stack ? err.stack : String(err));
        process.exit(1);
    });
}

module.exports = {
    applyLocalCleanup,
    cleanupLiveishHarness,
    formatCleanupResult,
    hasPelicanResourceLinkage,
    parseOptions,
    summarizePurchase
};
