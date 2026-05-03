const { PURCHASE_STATUS, FULFILLMENT_STATUS, SERVICE_STATUS } = require("../constants/status");
const {
    CATEGORY_LABELS,
    SUPPORT_CATEGORY,
    SUPPORT_MODEL_ELIGIBILITY,
    SUPPORT_PRIORITY,
    SUPPORT_SCOPE,
    SUPPORT_TICKET_STATUS,
    normalizeSupportCategory
} = require("../support/taxonomy");

const HUMAN_REQUIRED_CATEGORIES = new Set([
    SUPPORT_CATEGORY.ABUSE_OR_POLICY,
    SUPPORT_CATEGORY.ACCOUNT_SECURITY
]);

function buildRecommendation({
    category,
    scopeClassification,
    priority = SUPPORT_PRIORITY.NORMAL,
    macroId,
    customerGuidance,
    humanRequired = false,
    modelEligibility = SUPPORT_MODEL_ELIGIBILITY.STATIC_ONLY,
    escalationReason = null
}) {
    return {
        category,
        categoryLabel: CATEGORY_LABELS[category] || category,
        scopeClassification,
        priority,
        macroId,
        customerGuidance,
        humanRequired,
        modelEligibility,
        escalationReason,
        defaultStatus: humanRequired
            ? SUPPORT_TICKET_STATUS.NEEDS_ADMIN
            : SUPPORT_TICKET_STATUS.WAITING_ON_CUSTOMER
    };
}

function guidanceForServiceNotReady(purchase) {
    if (!purchase) {
        return "We could not load a verified service state for this request, so the founder will review it.";
    }

    if (purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING) {
        return "Stripe payment confirmation can take a few moments. If the page does not update, keep your receipt email handy and we will review it.";
    }

    if (purchase.status === PURCHASE_STATUS.PAID && !purchase.serverName) {
        return "Payment is verified, but server details still need to be submitted before provisioning can begin.";
    }

    if (
        purchase.fulfillmentStatus === FULFILLMENT_STATUS.QUEUED ||
        purchase.fulfillmentStatus === FULFILLMENT_STATUS.PROVISIONING
    ) {
        return "Your server is being prepared. You will receive the panel access email when final setup is complete.";
    }

    if (purchase.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION) {
        return "Your server is prepared and waiting on final routing checks. You will receive the access email when that final check is complete.";
    }

    return "We will review the current service state and follow up if anything needs manual attention.";
}

function recommendSupportAction(categoryInput, context = {}) {
    const category = normalizeSupportCategory(categoryInput);
    const purchase = context.purchase || null;

    if (HUMAN_REQUIRED_CATEGORIES.has(category)) {
        return buildRecommendation({
            category,
            scopeClassification: SUPPORT_SCOPE.HUMAN_REQUIRED,
            priority: category === SUPPORT_CATEGORY.ACCOUNT_SECURITY
                ? SUPPORT_PRIORITY.ELEVATED
                : SUPPORT_PRIORITY.URGENT,
            macroId: "escalation_received",
            customerGuidance: "This needs founder review. We have recorded the request and will handle it carefully.",
            humanRequired: true,
            modelEligibility: SUPPORT_MODEL_ELIGIBILITY.HUMAN_ONLY,
            escalationReason: "human_required_category"
        });
    }

    switch (category) {
        case SUPPORT_CATEGORY.CUSTOMER_PLUGIN_OR_CONFIG:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.CUSTOMER_RESPONSIBILITY,
                priority: SUPPORT_PRIORITY.LOW,
                macroId: "plugin_support_boundary",
                customerGuidance: "OberynHost supports the hosting platform, panel access, allocation, and baseline templates. Plugin setup, plugin conflicts, custom configs, gameplay, moderation, and server administration remain self-managed.",
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.STATIC_ONLY
            });

        case SUPPORT_CATEGORY.BILLING_SUBSCRIPTION:
        case SUPPORT_CATEGORY.CANCELLATION:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.BILLING_ACCOUNT,
                macroId: category === SUPPORT_CATEGORY.CANCELLATION
                    ? "billing_portal_cancellation"
                    : "billing_portal_first",
                customerGuidance: "Billing changes are handled through Stripe Billing Portal when the verified service has enough billing context. If the portal is not available or the state looks wrong, this ticket gives us the context to review it.",
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.DETERMINISTIC_STATE_ANSWER
            });

        case SUPPORT_CATEGORY.PANEL_ACCESS:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.OBERYNHOST_RESPONSIBILITY,
                macroId: "panel_access_info",
                customerGuidance: "If your service is ready, the support hub can show the panel URL and hostname and can resend the ready-access email when eligible. We will review anything that still does not line up.",
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.DETERMINISTIC_STATE_ANSWER
            });

        case SUPPORT_CATEGORY.SERVICE_NOT_READY:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.OBERYNHOST_RESPONSIBILITY,
                priority: (
                    purchase?.fulfillmentStatus === FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW ||
                    purchase?.fulfillmentStatus === FULFILLMENT_STATUS.DEAD_LETTER
                )
                    ? SUPPORT_PRIORITY.ELEVATED
                    : SUPPORT_PRIORITY.NORMAL,
                macroId: "service_not_ready_state",
                customerGuidance: guidanceForServiceNotReady(purchase),
                humanRequired: Boolean(
                    purchase?.fulfillmentStatus === FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW ||
                    purchase?.fulfillmentStatus === FULFILLMENT_STATUS.DEAD_LETTER
                ),
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.DETERMINISTIC_STATE_ANSWER,
                escalationReason: (
                    purchase?.fulfillmentStatus === FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW ||
                    purchase?.fulfillmentStatus === FULFILLMENT_STATUS.DEAD_LETTER
                )
                    ? "fulfillment_needs_review"
                    : null
            });

        case SUPPORT_CATEGORY.CONNECTION_HOSTNAME:
        case SUPPORT_CATEGORY.PROVISIONING_FAILURE:
        case SUPPORT_CATEGORY.NODE_OR_PLATFORM_OUTAGE:
        case SUPPORT_CATEGORY.PLAN_ALLOCATION:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.OBERYNHOST_RESPONSIBILITY,
                priority: category === SUPPORT_CATEGORY.NODE_OR_PLATFORM_OUTAGE
                    ? SUPPORT_PRIORITY.ELEVATED
                    : SUPPORT_PRIORITY.NORMAL,
                macroId: "platform_issue_acknowledged",
                customerGuidance: "This sounds tied to the hosting platform, routing, provisioning, or allocated service. We recorded the service context so founder review can start from the current state.",
                humanRequired: category === SUPPORT_CATEGORY.NODE_OR_PLATFORM_OUTAGE,
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.DETERMINISTIC_STATE_ANSWER,
                escalationReason: category === SUPPORT_CATEGORY.NODE_OR_PLATFORM_OUTAGE
                    ? "possible_platform_outage"
                    : null
            });

        case SUPPORT_CATEGORY.PERFORMANCE_OR_LAG:
        case SUPPORT_CATEGORY.SERVER_WONT_START:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.MIXED_DIAGNOSTIC,
                macroId: "diagnostic_needed",
                customerGuidance: "Performance and startup issues can come from hosting state or customer-managed plugins, worlds, entities, view distance, and custom config. We recorded the service context and will review whether this points to the platform or to self-managed server work.",
                humanRequired: false,
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.DIAGNOSTIC_THEN_ANSWER
            });

        case SUPPORT_CATEGORY.OTHER:
        default:
            return buildRecommendation({
                category,
                scopeClassification: SUPPORT_SCOPE.UNKNOWN,
                macroId: "escalation_received",
                customerGuidance: "We recorded the request and will review it with the verified service context.",
                humanRequired: true,
                modelEligibility: SUPPORT_MODEL_ELIGIBILITY.HUMAN_ONLY,
                escalationReason: "unknown_or_ambiguous_category"
            });
    }
}

function serializeRuleRecommendation(recommendation) {
    return {
        category: recommendation.category,
        categoryLabel: recommendation.categoryLabel,
        scopeClassification: recommendation.scopeClassification,
        priority: recommendation.priority,
        macroId: recommendation.macroId,
        humanRequired: recommendation.humanRequired,
        modelEligibility: recommendation.modelEligibility,
        escalationReason: recommendation.escalationReason,
        defaultStatus: recommendation.defaultStatus
    };
}

module.exports = {
    HUMAN_REQUIRED_CATEGORIES,
    recommendSupportAction,
    serializeRuleRecommendation
};
