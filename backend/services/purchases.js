const config = require("../config");
const { runQuery, getQuery } = require("../db/queries");
const { PURCHASE_STATUS, SERVER_STATUS } = require("../constants/status");
const { generateOpaqueToken } = require("../utils/tokens");

const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

function asMilliseconds(timestampSeconds) {
    const number = Number(timestampSeconds);
    return Number.isFinite(number) && number > 0 ? number * 1000 : null;
}

function getStripeObjectId(value) {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value === "object" && typeof value.id === "string") return value.id;
    return null;
}

function extractPriceIdFromSubscription(subscription) {
    return subscription?.items?.data?.[0]?.price?.id || null;
}

function extractCurrentPeriodEnd(subscription) {
    const itemPeriodEnd = subscription?.items?.data?.[0]?.current_period_end;

    if (itemPeriodEnd) {
        return asMilliseconds(itemPeriodEnd);
    }

    return asMilliseconds(subscription?.current_period_end);
}

function buildSubscriptionRuntime(subscription, overrides = {}) {
    return {
        stripeCustomerId: overrides.stripeCustomerId ?? getStripeObjectId(subscription?.customer),
        stripeSubscriptionId: overrides.stripeSubscriptionId ?? getStripeObjectId(subscription),
        stripeSubscriptionStatus: overrides.stripeSubscriptionStatus ?? subscription?.status ?? null,
        stripeCurrentPeriodEnd: overrides.stripeCurrentPeriodEnd ?? extractCurrentPeriodEnd(subscription),
        stripeCancelAtPeriodEnd: Number(
            overrides.stripeCancelAtPeriodEnd ?? Boolean(subscription?.cancel_at_period_end)
        ),
        stripePriceId: overrides.stripePriceId ?? extractPriceIdFromSubscription(subscription)
    };
}

async function findPurchaseForStripeEvent({ purchaseId = null, stripeSessionId = null, stripeSubscriptionId = null }) {
    return getQuery(
        `SELECT *
         FROM purchases
         WHERE id = ?
            OR stripeSessionId = ?
            OR stripeSubscriptionId = ?
         ORDER BY id ASC
         LIMIT 1`,
        [purchaseId || 0, stripeSessionId || "", stripeSubscriptionId || ""]
    );
}

async function releaseServerIfNeeded(serverId) {
    if (!serverId) return;

    await runQuery(
        "UPDATE servers SET status = ? WHERE id = ? AND status IN (?, ?)",
        [SERVER_STATUS.AVAILABLE, serverId, SERVER_STATUS.HELD, SERVER_STATUS.ALLOCATED]
    );
}

async function cancelPurchaseAndRelease(purchaseId, serverId) {
    if (purchaseId) {
        await runQuery(
            "UPDATE purchases SET status = ? WHERE id = ? AND status = ?",
            [PURCHASE_STATUS.CANCELLED, purchaseId, PURCHASE_STATUS.CHECKOUT_PENDING]
        );
    }

    if (serverId) {
        await releaseServerIfNeeded(serverId);
    }
}

async function savePurchaseRuntime(purchase, values) {
    await runQuery(
        `UPDATE purchases
         SET status = ?,
             stripeSessionId = ?,
             stripeCustomerId = ?,
             stripeSubscriptionId = ?,
             stripeSubscriptionStatus = ?,
             stripeCurrentPeriodEnd = ?,
             stripeCancelAtPeriodEnd = ?,
             stripePriceId = ?,
             subscriptionDelinquentAt = ?,
             serviceSuspendedAt = ?,
             email = ?,
             setupToken = ?,
             setupTokenExpiresAt = ?
         WHERE id = ?`,
        [
            values.status,
            values.stripeSessionId,
            values.stripeCustomerId,
            values.stripeSubscriptionId,
            values.stripeSubscriptionStatus,
            values.stripeCurrentPeriodEnd,
            values.stripeCancelAtPeriodEnd,
            values.stripePriceId,
            values.subscriptionDelinquentAt,
            values.serviceSuspendedAt,
            values.email,
            values.setupToken,
            values.setupTokenExpiresAt,
            purchase.id
        ]
    );
}

async function markPurchasePaid(session, subscription = null) {
    const email = session.customer_details?.email || session.customer_email || "";
    const fallbackSetupToken = generateOpaqueToken();
    const setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;
    const purchaseId = Number(session.metadata?.purchaseId);
    const stripeSubscriptionId = getStripeObjectId(session.subscription) || getStripeObjectId(subscription);
    const purchase = await findPurchaseForStripeEvent({
        purchaseId,
        stripeSessionId: session.id,
        stripeSubscriptionId
    });

    if (!purchase) {
        return;
    }

    const runtime = buildSubscriptionRuntime(subscription, {
        stripeCustomerId: getStripeObjectId(session.customer),
        stripeSubscriptionId
    });

    const nextStatus = purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING
        ? PURCHASE_STATUS.PAID
        : purchase.status;

    await savePurchaseRuntime(purchase, {
        status: nextStatus,
        stripeSessionId: purchase.stripeSessionId || session.id,
        stripeCustomerId: runtime.stripeCustomerId || purchase.stripeCustomerId || null,
        stripeSubscriptionId: runtime.stripeSubscriptionId || purchase.stripeSubscriptionId || null,
        stripeSubscriptionStatus: runtime.stripeSubscriptionStatus || purchase.stripeSubscriptionStatus || null,
        stripeCurrentPeriodEnd: runtime.stripeCurrentPeriodEnd || purchase.stripeCurrentPeriodEnd || null,
        stripeCancelAtPeriodEnd: runtime.stripeSubscriptionId
            ? runtime.stripeCancelAtPeriodEnd
            : Number(purchase.stripeCancelAtPeriodEnd || 0),
        stripePriceId: runtime.stripePriceId || purchase.stripePriceId || null,
        subscriptionDelinquentAt: null,
        serviceSuspendedAt: null,
        email: email || purchase.email || "",
        setupToken: purchase.setupToken || fallbackSetupToken,
        setupTokenExpiresAt
    });
}

async function syncPurchaseSubscription(subscription, overrides = {}) {
    const stripeSubscriptionId = overrides.stripeSubscriptionId || getStripeObjectId(subscription);
    const purchase = await findPurchaseForStripeEvent({
        purchaseId: Number(overrides.purchaseId),
        stripeSessionId: overrides.stripeSessionId || null,
        stripeSubscriptionId
    });

    if (!purchase) {
        return null;
    }

    const runtime = buildSubscriptionRuntime(subscription, overrides);
    const isTerminal = TERMINAL_SUBSCRIPTION_STATUSES.has(runtime.stripeSubscriptionStatus);
    const isDelinquent = runtime.stripeSubscriptionStatus === "past_due" ||
        runtime.stripeSubscriptionStatus === "unpaid";
    let nextStatus = purchase.status;

    if (isTerminal && (
        purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING ||
        purchase.status === PURCHASE_STATUS.PAID
    )) {
        nextStatus = PURCHASE_STATUS.CANCELLED;
    }

    await savePurchaseRuntime(purchase, {
        status: nextStatus,
        stripeSessionId: overrides.stripeSessionId || purchase.stripeSessionId || null,
        stripeCustomerId: runtime.stripeCustomerId || purchase.stripeCustomerId || null,
        stripeSubscriptionId: runtime.stripeSubscriptionId || purchase.stripeSubscriptionId || null,
        stripeSubscriptionStatus: runtime.stripeSubscriptionStatus || purchase.stripeSubscriptionStatus || null,
        stripeCurrentPeriodEnd: runtime.stripeCurrentPeriodEnd || purchase.stripeCurrentPeriodEnd || null,
        stripeCancelAtPeriodEnd: runtime.stripeSubscriptionId
            ? runtime.stripeCancelAtPeriodEnd
            : Number(purchase.stripeCancelAtPeriodEnd || 0),
        stripePriceId: runtime.stripePriceId || purchase.stripePriceId || null,
        subscriptionDelinquentAt: overrides.subscriptionDelinquentAt !== undefined
            ? overrides.subscriptionDelinquentAt
            : isDelinquent
                ? purchase.subscriptionDelinquentAt || Date.now()
                : null,
        serviceSuspendedAt: overrides.serviceSuspendedAt !== undefined
            ? overrides.serviceSuspendedAt
            : isDelinquent
                ? purchase.serviceSuspendedAt || null
                : null,
        email: overrides.email || purchase.email || "",
        setupToken: purchase.setupToken || generateOpaqueToken(),
        setupTokenExpiresAt: purchase.setupTokenExpiresAt || (Date.now() + config.setupTokenTtlMs)
    });

    if (isTerminal) {
        await releaseServerIfNeeded(purchase.serverId);
    }

    return runtime;
}

async function expirePurchase(session) {
    const purchaseId = Number(session.metadata?.purchaseId);
    const purchase = await findPurchaseForStripeEvent({
        purchaseId,
        stripeSessionId: session.id
    });

    if (!purchase) return;
    if (purchase.status !== PURCHASE_STATUS.CHECKOUT_PENDING) return;

    const update = await runQuery(
        "UPDATE purchases SET status = ? WHERE id = ? AND status = ?",
        [PURCHASE_STATUS.EXPIRED, purchase.id, PURCHASE_STATUS.CHECKOUT_PENDING]
    );

    if (update.changes === 0) return;

    await releaseServerIfNeeded(purchase.serverId);
}

module.exports = {
    TERMINAL_SUBSCRIPTION_STATUSES,
    cancelPurchaseAndRelease,
    markPurchasePaid,
    syncPurchaseSubscription,
    expirePurchase,
    getStripeObjectId
};
