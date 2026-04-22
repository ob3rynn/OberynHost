const PURCHASE_STATUS = {
    CHECKOUT_PENDING: "checkout_pending",
    PAID: "paid",
    COMPLETED: "completed",
    EXPIRED: "expired",
    CANCELLED: "cancelled"
};

const SERVER_STATUS = {
    AVAILABLE: "available",
    HELD: "held",
    ALLOCATED: "allocated"
};

const SETUP_STATUS = {
    NOT_STARTED: "not_started",
    SETUP_PENDING: "setup_pending",
    SETUP_SUBMITTED: "setup_submitted"
};

const FULFILLMENT_STATUS = {
    NOT_STARTED: "not_started",
    QUEUED: "queued",
    PROVISIONING: "provisioning",
    PENDING_ACTIVATION: "pending_activation",
    RETRYABLE_FAILURE: "retryable_failure",
    READY: "ready",
    NEEDS_ADMIN_REVIEW: "needs_admin_review",
    DEAD_LETTER: "dead_letter",
    DELETED: "deleted"
};

const SERVICE_STATUS = {
    INACTIVE: "inactive",
    ACTIVE: "active",
    CANCEL_SCHEDULED: "cancel_scheduled",
    GRACE_LIVE: "grace_live",
    SUSPENDED_FINAL_RECOVERY: "suspended_final_recovery",
    DELETED: "deleted"
};

const CUSTOMER_RISK_STATUS = {
    CLEAR: "clear",
    PURCHASE_BLOCKED_DELINQUENT: "purchase_blocked_delinquent",
    HARD_FLAGGED: "hard_flagged"
};

module.exports = {
    PURCHASE_STATUS,
    SERVER_STATUS,
    SETUP_STATUS,
    FULFILLMENT_STATUS,
    SERVICE_STATUS,
    CUSTOMER_RISK_STATUS
};
