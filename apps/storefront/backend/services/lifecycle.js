const {
    PURCHASE_STATUS,
    SETUP_STATUS,
    FULFILLMENT_STATUS,
    SERVICE_STATUS,
    CUSTOMER_RISK_STATUS
} = require("../constants/status");
const {
    TERMINAL_SUBSCRIPTION_STATUSES
} = require("./policyRules");

function hasServerName(purchase) {
    return Boolean((purchase?.serverName || "").trim());
}

function deriveSetupStatus(purchase) {
    if (hasServerName(purchase)) {
        return SETUP_STATUS.SETUP_SUBMITTED;
    }

    if (
        purchase?.status === PURCHASE_STATUS.PAID ||
        purchase?.status === PURCHASE_STATUS.COMPLETED
    ) {
        return SETUP_STATUS.SETUP_PENDING;
    }

    return SETUP_STATUS.NOT_STARTED;
}

function deriveFulfillmentStatus(purchase) {
    if (purchase?.status === PURCHASE_STATUS.COMPLETED) {
        return FULFILLMENT_STATUS.READY;
    }

    if (purchase?.fulfillmentStatus === FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW) {
        return FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW;
    }

    if (purchase?.fulfillmentStatus === FULFILLMENT_STATUS.DEAD_LETTER) {
        return FULFILLMENT_STATUS.DEAD_LETTER;
    }

    if (purchase?.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION) {
        return FULFILLMENT_STATUS.PENDING_ACTIVATION;
    }

    if (purchase?.fulfillmentStatus === FULFILLMENT_STATUS.RETRYABLE_FAILURE) {
        return FULFILLMENT_STATUS.RETRYABLE_FAILURE;
    }

    if (Number(purchase?.workerLeaseExpiresAt || 0) > Date.now()) {
        return FULFILLMENT_STATUS.PROVISIONING;
    }

    if (hasServerName(purchase) && purchase?.status === PURCHASE_STATUS.PAID) {
        return FULFILLMENT_STATUS.QUEUED;
    }

    return FULFILLMENT_STATUS.NOT_STARTED;
}

function deriveServiceStatus(purchase) {
    const subscriptionStatus = purchase?.stripeSubscriptionStatus || "";

    if (purchase?.status !== PURCHASE_STATUS.COMPLETED) {
        return SERVICE_STATUS.INACTIVE;
    }

    if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscriptionStatus)) {
        return SERVICE_STATUS.DELETED;
    }

    if (Number(purchase?.serviceSuspendedAt || 0) > 0) {
        return SERVICE_STATUS.SUSPENDED_FINAL_RECOVERY;
    }

    if (Number(purchase?.subscriptionDelinquentAt || 0) > 0) {
        return SERVICE_STATUS.GRACE_LIVE;
    }

    if (Number(purchase?.stripeCancelAtPeriodEnd || 0) > 0) {
        return SERVICE_STATUS.CANCEL_SCHEDULED;
    }

    return SERVICE_STATUS.ACTIVE;
}

function deriveCustomerRiskStatus(purchase) {
    if (purchase?.customerRiskStatus === CUSTOMER_RISK_STATUS.HARD_FLAGGED) {
        return CUSTOMER_RISK_STATUS.HARD_FLAGGED;
    }

    if (
        Number(purchase?.subscriptionDelinquentAt || 0) > 0 ||
        Number(purchase?.serviceSuspendedAt || 0) > 0
    ) {
        return CUSTOMER_RISK_STATUS.PURCHASE_BLOCKED_DELINQUENT;
    }

    return CUSTOMER_RISK_STATUS.CLEAR;
}

function deriveLifecycleState(purchase) {
    return {
        setupStatus: deriveSetupStatus(purchase),
        fulfillmentStatus: deriveFulfillmentStatus(purchase),
        serviceStatus: deriveServiceStatus(purchase),
        customerRiskStatus: deriveCustomerRiskStatus(purchase)
    };
}

function mergeLifecycleState(purchase, overrides = {}) {
    const nextPurchase = {
        ...(purchase || {}),
        ...(overrides || {})
    };

    return {
        ...nextPurchase,
        ...deriveLifecycleState(nextPurchase)
    };
}

module.exports = {
    deriveCustomerRiskStatus,
    deriveFulfillmentStatus,
    deriveLifecycleState,
    deriveServiceStatus,
    deriveSetupStatus,
    mergeLifecycleState
};
