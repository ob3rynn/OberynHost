const SUPPORT_CATEGORY = {
    PANEL_ACCESS: "panel_access",
    SERVICE_NOT_READY: "service_not_ready",
    BILLING_SUBSCRIPTION: "billing_subscription",
    CANCELLATION: "cancellation",
    CONNECTION_HOSTNAME: "connection_hostname",
    PERFORMANCE_OR_LAG: "performance_or_lag",
    SERVER_WONT_START: "server_wont_start",
    PROVISIONING_FAILURE: "provisioning_failure",
    NODE_OR_PLATFORM_OUTAGE: "node_or_platform_outage",
    PLAN_ALLOCATION: "plan_allocation",
    CUSTOMER_PLUGIN_OR_CONFIG: "customer_plugin_or_config",
    ABUSE_OR_POLICY: "abuse_or_policy",
    ACCOUNT_SECURITY: "account_security",
    OTHER: "other"
};

const SUPPORT_SCOPE = {
    OBERYNHOST_RESPONSIBILITY: "oberynhost_responsibility",
    CUSTOMER_RESPONSIBILITY: "customer_responsibility",
    MIXED_DIAGNOSTIC: "mixed_diagnostic",
    BILLING_ACCOUNT: "billing_account",
    HUMAN_REQUIRED: "human_required",
    UNKNOWN: "unknown"
};

const SUPPORT_PRIORITY = {
    LOW: "low",
    NORMAL: "normal",
    ELEVATED: "elevated",
    URGENT: "urgent"
};

const SUPPORT_TICKET_STATUS = {
    WAITING_ON_CUSTOMER: "waiting_on_customer",
    NEEDS_ADMIN: "needs_admin",
    ADMIN_REVIEW: "admin_review",
    REPLIED: "replied",
    RESOLVED: "resolved",
    CLOSED_NO_RESPONSE: "closed_no_response"
};

const SUPPORT_MODEL_ELIGIBILITY = {
    STATIC_ONLY: "static_only",
    DETERMINISTIC_STATE_ANSWER: "deterministic_state_answer",
    DIAGNOSTIC_THEN_ANSWER: "diagnostic_then_answer",
    MODEL_DRAFT_ALLOWED: "model_draft_allowed",
    MODEL_CUSTOMER_SAFE_ALLOWED: "model_customer_safe_allowed",
    HUMAN_ONLY: "human_only"
};

const CATEGORY_LABELS = {
    [SUPPORT_CATEGORY.PANEL_ACCESS]: "Panel access",
    [SUPPORT_CATEGORY.SERVICE_NOT_READY]: "Service not ready",
    [SUPPORT_CATEGORY.BILLING_SUBSCRIPTION]: "Billing or subscription",
    [SUPPORT_CATEGORY.CANCELLATION]: "Cancellation",
    [SUPPORT_CATEGORY.CONNECTION_HOSTNAME]: "Connection or hostname",
    [SUPPORT_CATEGORY.PERFORMANCE_OR_LAG]: "Performance or lag",
    [SUPPORT_CATEGORY.SERVER_WONT_START]: "Server will not start",
    [SUPPORT_CATEGORY.PROVISIONING_FAILURE]: "Provisioning failure",
    [SUPPORT_CATEGORY.NODE_OR_PLATFORM_OUTAGE]: "Node or platform outage",
    [SUPPORT_CATEGORY.PLAN_ALLOCATION]: "Plan allocation",
    [SUPPORT_CATEGORY.CUSTOMER_PLUGIN_OR_CONFIG]: "Plugins or custom config",
    [SUPPORT_CATEGORY.ABUSE_OR_POLICY]: "Abuse or policy",
    [SUPPORT_CATEGORY.ACCOUNT_SECURITY]: "Account security",
    [SUPPORT_CATEGORY.OTHER]: "Other"
};

function valuesOf(object) {
    return Object.values(object);
}

function isKnownValue(object, value) {
    return valuesOf(object).includes(value);
}

function assertKnownValue(name, object, value) {
    if (!isKnownValue(object, value)) {
        throw new Error(`Unknown support ${name}: ${value}`);
    }

    return value;
}

function normalizeSupportCategory(value) {
    return assertKnownValue("category", SUPPORT_CATEGORY, String(value || "").trim());
}

function normalizeSupportScope(value) {
    return assertKnownValue("scope", SUPPORT_SCOPE, String(value || "").trim());
}

function normalizeSupportPriority(value) {
    return assertKnownValue("priority", SUPPORT_PRIORITY, String(value || "").trim());
}

function normalizeSupportStatus(value) {
    return assertKnownValue("status", SUPPORT_TICKET_STATUS, String(value || "").trim());
}

function normalizeModelEligibility(value) {
    return assertKnownValue("model eligibility", SUPPORT_MODEL_ELIGIBILITY, String(value || "").trim());
}

module.exports = {
    CATEGORY_LABELS,
    SUPPORT_CATEGORY,
    SUPPORT_MODEL_ELIGIBILITY,
    SUPPORT_PRIORITY,
    SUPPORT_SCOPE,
    SUPPORT_TICKET_STATUS,
    normalizeModelEligibility,
    normalizeSupportCategory,
    normalizeSupportPriority,
    normalizeSupportScope,
    normalizeSupportStatus
};
