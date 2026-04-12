const { PURCHASE_STATUS } = require("../constants/status");

const ORIGINAL_REFUND_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;
const SUBSCRIPTION_GRACE_PERIOD_MS = 1000 * 60 * 60 * 24 * 7;
const SUSPENSION_RETENTION_MS = 1000 * 60 * 60 * 24 * 30;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

function asTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function getPurchasePolicyState(purchase, now = Date.now()) {
    const createdAt = asTimestamp(purchase?.createdAt);
    const delinquentAt = asTimestamp(purchase?.subscriptionDelinquentAt);
    const suspendedAt = asTimestamp(purchase?.serviceSuspendedAt);
    const refundWindowEndsAt = createdAt ? createdAt + ORIGINAL_REFUND_WINDOW_MS : null;
    const gracePeriodEndsAt = delinquentAt ? delinquentAt + SUBSCRIPTION_GRACE_PERIOD_MS : null;
    const purgeEligibleAt = suspendedAt ? suspendedAt + SUSPENSION_RETENTION_MS : null;
    const subscriptionStatus = purchase?.stripeSubscriptionStatus || "";
    const isTerminalSubscription = TERMINAL_SUBSCRIPTION_STATUSES.has(subscriptionStatus);
    const hasLiveSubscription = ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus);
    const preFulfillmentRefundEligible =
        purchase?.status !== PURCHASE_STATUS.COMPLETED &&
        purchase?.status !== PURCHASE_STATUS.EXPIRED &&
        purchase?.status !== PURCHASE_STATUS.CANCELLED;
    const originalPurchaseRefundEligible = Boolean(
        refundWindowEndsAt &&
        now <= refundWindowEndsAt &&
        purchase?.status === PURCHASE_STATUS.COMPLETED
    );
    const inGracePeriod = Boolean(
        delinquentAt &&
        !suspendedAt &&
        gracePeriodEndsAt &&
        now < gracePeriodEndsAt
    );
    const suspensionRequired = Boolean(
        delinquentAt &&
        !suspendedAt &&
        gracePeriodEndsAt &&
        now >= gracePeriodEndsAt &&
        !isTerminalSubscription
    );
    const purgeRequired = Boolean(
        suspendedAt &&
        purgeEligibleAt &&
        now >= purgeEligibleAt
    );

    return {
        refundWindowEndsAt,
        preFulfillmentRefundEligible,
        originalPurchaseRefundEligible,
        delinquentAt,
        gracePeriodEndsAt,
        inGracePeriod,
        suspensionRequired,
        suspendedAt,
        purgeEligibleAt,
        purgeRequired,
        hasLiveSubscription,
        isTerminalSubscription,
        canReleaseInventory: isTerminalSubscription,
        requiresStripeCancellation: hasLiveSubscription && !isTerminalSubscription
    };
}

module.exports = {
    ACTIVE_SUBSCRIPTION_STATUSES,
    TERMINAL_SUBSCRIPTION_STATUSES,
    getPurchasePolicyState,
    ORIGINAL_REFUND_WINDOW_MS,
    SUBSCRIPTION_GRACE_PERIOD_MS,
    SUSPENSION_RETENTION_MS
};
