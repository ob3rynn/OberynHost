const express = require("express");

const requireAdmin = require("../../middleware/auth");
const config = require("../../config");
const { createRateLimiter } = require("../../middleware/rateLimit");
const {
    PURCHASE_STATUS,
    SERVER_STATUS,
    SETUP_STATUS,
    FULFILLMENT_STATUS,
    CUSTOMER_RISK_STATUS
} = require("../../constants/status");
const { createStripeClient } = require("../../lib/stripeClient");
const { createAdminSession, destroyAdminSession } = require("../../services/adminSessions");
const {
    applyStripePriceMetadata,
    getPlanDefinition,
    listPlanDefinitions,
    previewPlanDefinition,
    savePlanDefinition
} = require("../../services/catalog");
const { validatePlanDefinition } = require("../../services/planDefinitions");
const { validateStripePriceId } = require("../../services/stripePrices");
const { markPurchasePaid, expirePurchase } = require("../../services/purchases");
const { enqueueReadyEmailForPurchase } = require("../../services/emailOutbox");
const {
    buildProvisioningIdempotencyKey,
    buildProvisioningPayload,
    FULFILLMENT_QUEUE_STATE,
    FULFILLMENT_TASK_TYPE
} = require("../../services/fulfillmentQueue");
const { PAID_SETUP_ADMIN_ESCALATION_DELAY_MS } = require("../../services/lifecycleEnforcement");
const {
    ProvisioningBlockedError,
    fetchPelicanPurchaseFacts
} = require("../../services/pelicanProvisioner");
const { clearCookie, parseCookies, serializeCookie } = require("../../utils/cookies");
const { assertEmailHeaderSafe } = require("../../utils/emailSafety");
const { allQuery, getQuery, runQuery } = require("../../db/queries");
const { rollbackTransaction } = require("../../db/transactions");
const {
    generateOpaqueToken,
    isOpaqueToken,
    timingSafeEqualString
} = require("../../utils/tokens");
const {
    ACTIVE_SUBSCRIPTION_STATUSES,
    TERMINAL_SUBSCRIPTION_STATUSES,
    getPurchasePolicyState
} = require("../../services/policyRules");
const { mergeLifecycleState } = require("../../services/lifecycle");

const stripe = createStripeClient(config.stripeSecretKey, config.stripeApiVersion);
const router = express.Router();
const STALE_PENDING_CHECKOUT_MS = 1000 * 60 * 30;
const loginLimiter = createRateLimiter({
    windowMs: 1000 * 60 * 15,
    max: 5,
    message: "Too many login attempts. Please wait before trying again."
});
const adminApiLimiter = createRateLimiter({
    windowMs: 1000 * 60,
    max: 60,
    message: "Too many admin requests. Please slow down."
});

const PURCHASE_STATUSES = new Set(Object.values(PURCHASE_STATUS));
const SERVER_STATUSES = new Set(Object.values(SERVER_STATUS));

function inferServerStatus(purchase) {
    if (
        purchase.status === PURCHASE_STATUS.COMPLETED &&
        purchase.stripeSubscriptionStatus &&
        TERMINAL_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus)
    ) {
        return SERVER_STATUS.AVAILABLE;
    }

    switch (purchase.status) {
        case PURCHASE_STATUS.COMPLETED:
            return SERVER_STATUS.ALLOCATED;
        case PURCHASE_STATUS.EXPIRED:
        case PURCHASE_STATUS.CANCELLED:
            return SERVER_STATUS.AVAILABLE;
        case PURCHASE_STATUS.CHECKOUT_PENDING:
            return SERVER_STATUS.HELD;
        case PURCHASE_STATUS.PAID:
            return purchase.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION
                ? SERVER_STATUS.ALLOCATED
                : SERVER_STATUS.HELD;
        default:
            return SERVER_STATUS.HELD;
    }
}

function addIssue(issues, condition, message) {
    if (condition) {
        issues.push(message);
    }
}

function buildDiagnostics(purchase) {
    const issues = [];
    const recommendedServerStatus = inferServerStatus(purchase);
    const createdAt = Number(purchase.createdAt) || 0;
    const paidAt = Number(purchase.paidAt || purchase.createdAt) || 0;
    const tokenExpired = Boolean(
        purchase.setupTokenExpiresAt &&
        Number(purchase.setupTokenExpiresAt) < Date.now()
    );
    const paidSetupEscalationDue = Boolean(
        purchase.status === PURCHASE_STATUS.PAID &&
        (!purchase.serverName || !String(purchase.serverName).trim()) &&
        paidAt > 0 &&
        (Date.now() - paidAt) >= PAID_SETUP_ADMIN_ESCALATION_DELAY_MS
    );
    const policy = getPurchasePolicyState(purchase);
    const stalePendingCheckout = Boolean(
        purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING &&
        purchase.stripeSessionId &&
        createdAt > 0 &&
        (Date.now() - createdAt) >= STALE_PENDING_CHECKOUT_MS
    );

    addIssue(
        issues,
        !purchase.stripeSessionId && purchase.status !== PURCHASE_STATUS.CANCELLED,
        "Purchase has no Stripe session ID."
    );
    addIssue(
        issues,
        purchase.serverStatus !== recommendedServerStatus,
        `Server status is ${purchase.serverStatus || "unknown"}, expected ${recommendedServerStatus}.`
    );
    addIssue(
        issues,
        !purchase.email && (
            purchase.status === PURCHASE_STATUS.PAID ||
            purchase.status === PURCHASE_STATUS.COMPLETED
        ),
        "Customer email is missing on a verified purchase."
    );
    addIssue(
        issues,
        !purchase.setupToken && purchase.status !== PURCHASE_STATUS.CANCELLED,
        "Setup token is missing."
    );
    addIssue(
        issues,
        (purchase.status === PURCHASE_STATUS.PAID || purchase.status === PURCHASE_STATUS.COMPLETED) &&
        !purchase.stripeSubscriptionId,
        "Stripe subscription ID is missing."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED &&
        !purchase.stripeSubscriptionStatus,
        "Subscription runtime has not been synced onto this fulfilled order."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED &&
        purchase.stripeSubscriptionStatus &&
        TERMINAL_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus) &&
        purchase.serverStatus !== SERVER_STATUS.AVAILABLE,
        "Subscription is no longer active, but the server is still allocated."
    );
    addIssue(
        issues,
        tokenExpired && (
            purchase.status === PURCHASE_STATUS.CHECKOUT_PENDING ||
            purchase.status === PURCHASE_STATUS.PAID ||
            purchase.status === PURCHASE_STATUS.COMPLETED
        ),
        "Setup token is expired."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED && !purchase.serverName,
        "Completed purchase has no saved server name."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.PAID &&
        purchase.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION &&
        !purchase.routingVerifiedAt,
        "Pending activation is waiting on operator routing verification."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.PAID &&
        purchase.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION &&
        !purchase.desiredRoutingArtifactJson,
        "Pending activation has no desired routing artifact."
    );
    addIssue(
        issues,
        purchase.status === PURCHASE_STATUS.COMPLETED && !purchase.readyEmailQueuedAt,
        "Completed purchase has no queued ready email record."
    );
    addIssue(
        issues,
        stalePendingCheckout,
        "Pending checkout has been held for over 30 minutes without payment confirmation."
    );
    addIssue(
        issues,
        paidSetupEscalationDue,
        "Paid purchase has been waiting on customer setup for over 72 hours and needs admin follow-up."
    );
    addIssue(
        issues,
        policy.inGracePeriod,
        `Renewal is in the 7-day grace period until ${new Date(policy.gracePeriodEndsAt).toLocaleString()}.`
    );
    addIssue(
        issues,
        policy.suspensionRequired,
        "Nonpayment grace period has expired. Suspend service before keeping this subscription live."
    );
    addIssue(
        issues,
        policy.purgeRequired,
        "Suspended service has reached the 30-day retention limit and is ready for purge handling."
    );
    addIssue(
        issues,
        purchase.customerRiskStatus === CUSTOMER_RISK_STATUS.HARD_FLAGGED,
        "Customer is hard-flagged after terminal delinquency handling."
    );
    addIssue(
        issues,
        purchase.pelicanReconcileStatus && purchase.pelicanReconcileStatus !== "ok",
        `Last Pelican reconcile reported ${String(purchase.pelicanReconcileStatus).replace(/_/g, " ")}.`
    );

    return {
        issues,
        issueCount: issues.length,
        recommendedServerStatus,
        tokenExpired,
        stalePendingCheckout,
        stripeSyncAvailable: Boolean(purchase.stripeSessionId),
        activeSubscription: Boolean(
            purchase.stripeSubscriptionStatus &&
            ACTIVE_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus)
        ),
        terminalSubscription: Boolean(
            purchase.stripeSubscriptionStatus &&
            TERMINAL_SUBSCRIPTION_STATUSES.has(purchase.stripeSubscriptionStatus)
        ),
        policy
    };
}

function parseAuditDetails(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseStateJson(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function formatCapabilityReason(errors, fallback = "Action is not available for this order.") {
    return errors.length ? errors.join("; ") : fallback;
}

function createAdminCapability(enabled, options = {}) {
    return {
        enabled: Boolean(enabled),
        reason: enabled ? "" : (options.reason || "Action is not available for this order."),
        dangerLevel: options.dangerLevel || "low",
        requiresConfirmation: Boolean(options.requiresConfirmation),
        inlineRecommended: Boolean(options.inlineRecommended)
    };
}

function createCapabilityFromErrors(errors, options = {}) {
    return createAdminCapability(errors.length === 0, {
        ...options,
        reason: formatCapabilityReason(errors, options.reason)
    });
}

function getPelicanReconcileErrors(purchase) {
    const errors = [];

    if (
        !purchase.stripeCustomerId &&
        !purchase.pelicanUserId &&
        !purchase.pelicanServerId &&
        !purchase.pelicanServerIdentifier
    ) {
        errors.push("No Stripe customer or Pelican linkage is available to check.");
    }

    return errors;
}

function getSuspendServiceErrors(purchase) {
    const errors = [];

    if (purchase.status !== PURCHASE_STATUS.COMPLETED) {
        errors.push("Only fulfilled subscriptions can be marked suspended.");
    }

    return errors;
}

function getReinstateServiceErrors(purchase) {
    const errors = [];
    const policy = getPurchasePolicyState(purchase);

    if (!purchase.serviceSuspendedAt) {
        errors.push("Service is not currently suspended.");
    }

    if (policy.isTerminalSubscription) {
        errors.push("Terminal subscriptions cannot be reinstated.");
    }

    return errors;
}

function getHardFlagErrors(purchase) {
    const errors = [];
    const policy = getPurchasePolicyState(purchase);

    if (!policy.purgeRequired) {
        errors.push("Purchase cannot be hard-flagged until suspended retention has reached purge review.");
    }

    if (purchase.customerRiskStatus === CUSTOMER_RISK_STATUS.HARD_FLAGGED) {
        errors.push("Purchase is already hard-flagged.");
    }

    return errors;
}

function getStatusOverrideErrors(purchase, status) {
    const errors = [];
    const policy = getPurchasePolicyState(purchase);

    if (
        (status === PURCHASE_STATUS.CANCELLED || status === PURCHASE_STATUS.EXPIRED) &&
        policy.requiresStripeCancellation
    ) {
        errors.push("Live subscriptions must be ended in Stripe first or set to cancel at period end.");
    }

    return errors;
}

function getServerStatusOverrideErrors(purchase, serverStatus, status = purchase.status) {
    const errors = [];
    const policy = getPurchasePolicyState(purchase);

    if (!purchase.serverId) {
        errors.push("Purchase has no inventory slot to update.");
    }

    if (
        serverStatus === SERVER_STATUS.AVAILABLE &&
        status === PURCHASE_STATUS.COMPLETED &&
        !policy.canReleaseInventory
    ) {
        errors.push("Active or recoverable subscriptions cannot release inventory from the admin panel.");
    }

    return errors;
}

function buildAdminCapabilities(purchase, existingProvisioningJob = null) {
    const policy = getPurchasePolicyState(purchase);
    const releaseErrors = getReadyReleaseErrors(purchase);
    const releaseReadyErrors = [...releaseErrors];

    if (!purchase.routingVerifiedAt) {
        releaseReadyErrors.push("Operator routing verification is required before release.");
    }

    const repairServerStateErrors = [];
    const recommendedServerStatus = inferServerStatus(purchase);

    if (!purchase.serverId) {
        repairServerStateErrors.push("Purchase has no inventory slot to repair.");
    }

    if (purchase.serverStatus === recommendedServerStatus) {
        repairServerStateErrors.push("Server state already matches the recommended state.");
    }

    return {
        reconcileStripe: createAdminCapability(Boolean(purchase.stripeSessionId), {
            reason: "Purchase has no Stripe session ID to check.",
            dangerLevel: "low",
            requiresConfirmation: false,
            inlineRecommended: Boolean(purchase.stripeSessionId)
        }),
        reconcilePelican: createCapabilityFromErrors(getPelicanReconcileErrors(purchase), {
            dangerLevel: "low",
            requiresConfirmation: false,
            inlineRecommended: Boolean(
                purchase.pelicanReconcileStatus ||
                purchase.pelicanUserId ||
                purchase.pelicanServerId ||
                purchase.pelicanServerIdentifier
            )
        }),
        verifyRouting: createCapabilityFromErrors(getRoutingVerificationErrors(purchase), {
            dangerLevel: "medium",
            requiresConfirmation: true,
            inlineRecommended: purchase.status === PURCHASE_STATUS.PAID &&
                purchase.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION &&
                !purchase.routingVerifiedAt
        }),
        releaseReady: createCapabilityFromErrors(releaseReadyErrors, {
            dangerLevel: "medium",
            requiresConfirmation: true,
            inlineRecommended: purchase.status === PURCHASE_STATUS.PAID &&
                purchase.fulfillmentStatus === FULFILLMENT_STATUS.PENDING_ACTIVATION
        }),
        requeueFulfillment: createCapabilityFromErrors(getFulfillmentRequeueErrors(purchase), {
            dangerLevel: "medium",
            requiresConfirmation: true,
            inlineRecommended: [
                FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW,
                FULFILLMENT_STATUS.DEAD_LETTER,
                FULFILLMENT_STATUS.RETRYABLE_FAILURE
            ].includes(purchase.fulfillmentStatus)
        }),
        reopenSetup: createCapabilityFromErrors(getSetupReopenErrors(purchase, existingProvisioningJob), {
            dangerLevel: "medium",
            requiresConfirmation: true,
            inlineRecommended: purchase.status === PURCHASE_STATUS.PAID &&
                !purchase.pelicanUserId &&
                !purchase.pelicanServerId &&
                !purchase.pelicanServerIdentifier
        }),
        suspendService: createCapabilityFromErrors(getSuspendServiceErrors(purchase), {
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: Boolean(policy.suspensionRequired && !purchase.serviceSuspendedAt)
        }),
        reinstateService: createCapabilityFromErrors(getReinstateServiceErrors(purchase), {
            dangerLevel: "medium",
            requiresConfirmation: true,
            inlineRecommended: Boolean(purchase.serviceSuspendedAt && !policy.purgeRequired)
        }),
        markHardFlag: createCapabilityFromErrors(getHardFlagErrors(purchase), {
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: Boolean(
                policy.purgeRequired &&
                purchase.customerRiskStatus !== CUSTOMER_RISK_STATUS.HARD_FLAGGED
            )
        }),
        repairServerState: createCapabilityFromErrors(repairServerStateErrors, {
            dangerLevel: "medium",
            requiresConfirmation: false,
            inlineRecommended: repairServerStateErrors.length === 0
        }),
        saveOverrides: createAdminCapability(true, {
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: false
        }),
        manualMarkPaid: createAdminCapability(purchase.status !== PURCHASE_STATUS.PAID, {
            reason: "Purchase is already marked paid.",
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: false
        }),
        resetPending: createAdminCapability(purchase.status !== PURCHASE_STATUS.CHECKOUT_PENDING, {
            reason: "Purchase is already pending checkout.",
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: false
        }),
        markExpired: createCapabilityFromErrors(getStatusOverrideErrors(purchase, PURCHASE_STATUS.EXPIRED), {
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: false
        }),
        cancelOrder: createCapabilityFromErrors(getStatusOverrideErrors(purchase, PURCHASE_STATUS.CANCELLED), {
            dangerLevel: "high",
            requiresConfirmation: true,
            inlineRecommended: false
        }),
        releaseServer: createCapabilityFromErrors(
            getServerStatusOverrideErrors(purchase, SERVER_STATUS.AVAILABLE),
            {
                dangerLevel: "high",
                requiresConfirmation: true,
                inlineRecommended: false
            }
        ),
        holdServer: createCapabilityFromErrors(
            getServerStatusOverrideErrors(purchase, SERVER_STATUS.HELD),
            {
                dangerLevel: "medium",
                requiresConfirmation: false,
                inlineRecommended: false
            }
        ),
        allocateServer: createCapabilityFromErrors(
            getServerStatusOverrideErrors(purchase, SERVER_STATUS.ALLOCATED),
            {
                dangerLevel: "high",
                requiresConfirmation: true,
                inlineRecommended: false
            }
        )
    };
}

function serializePurchase(purchase, stripeState = null, auditLog = [], emailOutbox = [], options = {}) {
    const purchaseWithLifecycle = mergeLifecycleState(purchase);

    return {
        ...purchaseWithLifecycle,
        pelicanUserState: parseStateJson(purchaseWithLifecycle.pelicanUserStateJson),
        pelicanServerState: parseStateJson(purchaseWithLifecycle.pelicanServerStateJson),
        desiredRoutingArtifact: parseStateJson(purchaseWithLifecycle.desiredRoutingArtifactJson),
        adminCapabilities: buildAdminCapabilities(
            purchaseWithLifecycle,
            options.existingProvisioningJob || null
        ),
        auditLog: auditLog.map(entry => ({
            ...entry,
            details: parseAuditDetails(entry.detailsJson)
        })),
        emailOutbox,
        diagnostics: {
            ...buildDiagnostics(purchaseWithLifecycle),
            stripe: stripeState
        }
    };
}

function normalizeOptionalText(value, maxLength = 255) {
    if (value === undefined) {
        return { present: false, value: undefined };
    }

    if (value === null) {
        return { present: true, value: "" };
    }

    if (typeof value !== "string") {
        throw new Error("Expected a string value.");
    }

    const normalized = value.trim();

    if (normalized.length > maxLength) {
        throw new Error(`Value must be ${maxLength} characters or fewer.`);
    }

    return { present: true, value: normalized };
}

async function getPurchaseRecord(purchaseId) {
    return getQuery(
        `SELECT
            p.*,
            s.status AS serverStatus,
            s.type AS serverType,
            s.price AS serverPrice,
            COALESCE(p.planType, s.type) AS planType
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.id = ?`,
        [purchaseId]
    );
}

async function getAuditLogMap(purchaseIds) {
    if (!purchaseIds.length) {
        return new Map();
    }

    const placeholders = purchaseIds.map(() => "?").join(", ");
    const rows = await allQuery(
        `SELECT *
         FROM adminAuditLog
         WHERE purchaseId IN (${placeholders})
         ORDER BY createdAt DESC, id DESC`,
        purchaseIds
    );
    const map = new Map();

    for (const row of rows) {
        if (!map.has(row.purchaseId)) {
            map.set(row.purchaseId, []);
        }

        const entries = map.get(row.purchaseId);

        if (entries.length < 8) {
            entries.push(row);
        }
    }

    return map;
}

async function getEmailOutboxMap(purchaseIds) {
    if (!purchaseIds.length) {
        return new Map();
    }

    const placeholders = purchaseIds.map(() => "?").join(", ");
    const rows = await allQuery(
        `SELECT
            id,
            purchaseId,
            kind,
            state,
            idempotencyKey,
            recipientEmail,
            subject,
            availableAt,
            attempts,
            createdAt,
            updatedAt,
            sentAt,
            provider,
            providerMessageId,
            providerStatusCode,
            providerErrorCode,
            lastError
         FROM emailOutbox
         WHERE purchaseId IN (${placeholders})
         ORDER BY createdAt DESC, id DESC`,
        purchaseIds
    );
    const map = new Map();

    for (const row of rows) {
        if (!map.has(row.purchaseId)) {
            map.set(row.purchaseId, []);
        }

        const entries = map.get(row.purchaseId);

        if (entries.length < 5) {
            entries.push(row);
        }
    }

    return map;
}

async function getProvisioningJobMap(purchaseIds) {
    if (!purchaseIds.length) {
        return new Map();
    }

    const idempotencyKeys = purchaseIds.map(id => buildProvisioningIdempotencyKey(id));
    const placeholders = idempotencyKeys.map(() => "?").join(", ");
    const rows = await allQuery(
        `SELECT *
         FROM fulfillmentQueue
         WHERE idempotencyKey IN (${placeholders})`,
        idempotencyKeys
    );
    const map = new Map();

    rows.forEach(row => {
        map.set(row.purchaseId, row);
    });

    return map;
}

async function loadSerializedPurchase(purchaseId, stripeState = null) {
    const purchase = await getPurchaseRecord(purchaseId);

    if (!purchase) {
        return null;
    }

    const auditMap = await getAuditLogMap([purchaseId]);
    const emailOutboxMap = await getEmailOutboxMap([purchaseId]);
    const provisioningJobMap = await getProvisioningJobMap([purchaseId]);
    return serializePurchase(
        purchase,
        stripeState,
        auditMap.get(purchaseId) || [],
        emailOutboxMap.get(purchaseId) || [],
        {
            existingProvisioningJob: provisioningJobMap.get(purchaseId) || null
        }
    );
}

async function recordAdminAction(req, purchaseId, actionType, note = "", details = null) {
    await runQuery(
        `INSERT INTO adminAuditLog
            (purchaseId, actionType, note, detailsJson, userAgent, createdAt, actorJson)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            purchaseId,
            actionType,
            note || "",
            details ? JSON.stringify(details) : null,
            req.headers["user-agent"] || "",
            Date.now(),
            JSON.stringify({ userAgent: req.headers["user-agent"] || "" })
        ]
    );
}

async function recordEntityAdminAction(req, entityType, entityCode, actionType, oldValue, newValue, note = "") {
    await runQuery(
        `INSERT INTO adminAuditLog
            (
                purchaseId,
                actionType,
                note,
                detailsJson,
                userAgent,
                createdAt,
                entityType,
                entityCode,
                oldValueJson,
                newValueJson,
                actorJson
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            null,
            actionType,
            note || "",
            JSON.stringify({ entityType, entityCode }),
            req.headers["user-agent"] || "",
            Date.now(),
            entityType,
            entityCode,
            oldValue === undefined ? null : JSON.stringify(oldValue),
            newValue === undefined ? null : JSON.stringify(newValue),
            JSON.stringify({ userAgent: req.headers["user-agent"] || "" })
        ]
    );
}

function parseRoutingVerified(value) {
    return value === true || value === "true";
}

function parseDesiredRoutingArtifact(purchase, errors) {
    if (!purchase.desiredRoutingArtifactJson) {
        errors.push("desired routing artifact is missing");
        return null;
    }

    try {
        return JSON.parse(purchase.desiredRoutingArtifactJson);
    } catch {
        errors.push("desired routing artifact is not valid JSON");
        return null;
    }
}

function getReadyReleaseErrors(purchase) {
    const errors = [];

    if (purchase.status !== PURCHASE_STATUS.PAID) {
        errors.push("purchase is not paid");
    }

    if (purchase.fulfillmentStatus !== FULFILLMENT_STATUS.PENDING_ACTIVATION) {
        errors.push("fulfillment is not pending activation");
    }

    if (purchase.serverStatus !== SERVER_STATUS.ALLOCATED) {
        errors.push("local inventory slot has not been consumed");
    }

    if (!purchase.email) errors.push("customer email is missing");
    if (!purchase.serverName) errors.push("server name is missing");
    if (!purchase.hostname || !purchase.hostnameReservationKey) errors.push("hostname reservation is missing");
    if (!purchase.pelicanUserId) errors.push("Pelican user linkage is missing");
    if (!purchase.pelicanUsername) errors.push("Pelican username is missing");
    if (!purchase.pelicanServerId) errors.push("Pelican server linkage is missing");
    if (!purchase.pelicanServerIdentifier) errors.push("Pelican server identifier is missing");
    if (!purchase.pelicanAllocationId) errors.push("Pelican allocation linkage is missing");
    if (!config.pelican?.panelUrl) errors.push("Pelican panel URL is not configured for ready email");

    const artifact = parseDesiredRoutingArtifact(purchase, errors);

    if (artifact) {
        if (artifact.hostname !== purchase.hostname) {
            errors.push("desired routing artifact hostname does not match the purchase");
        }

        if (String(artifact.pelicanServerIdentifier || "") !== String(purchase.pelicanServerIdentifier || "")) {
            errors.push("desired routing artifact server identifier does not match the purchase");
        }

        if (String(artifact.pelicanAllocationId || "") !== String(purchase.pelicanAllocationId || "")) {
            errors.push("desired routing artifact allocation does not match the purchase");
        }
    }

    return errors;
}

function getRoutingVerificationErrors(purchase) {
    const errors = [];

    if (purchase.status !== PURCHASE_STATUS.PAID) {
        errors.push("purchase is not paid");
    }

    if (purchase.fulfillmentStatus !== FULFILLMENT_STATUS.PENDING_ACTIVATION) {
        errors.push("fulfillment is not pending activation");
    }

    if (purchase.serverStatus !== SERVER_STATUS.ALLOCATED) {
        errors.push("local inventory slot has not been consumed");
    }

    if (!purchase.hostname || !purchase.hostnameReservationKey) {
        errors.push("hostname reservation is missing");
    }

    if (!purchase.pelicanServerIdentifier) {
        errors.push("Pelican server identifier is missing");
    }

    if (!purchase.pelicanAllocationId) {
        errors.push("Pelican allocation linkage is missing");
    }

    const artifact = parseDesiredRoutingArtifact(purchase, errors);

    if (artifact) {
        if (artifact.hostname !== purchase.hostname) {
            errors.push("desired routing artifact hostname does not match the purchase");
        }

        if (String(artifact.pelicanServerIdentifier || "") !== String(purchase.pelicanServerIdentifier || "")) {
            errors.push("desired routing artifact server identifier does not match the purchase");
        }

        if (String(artifact.pelicanAllocationId || "") !== String(purchase.pelicanAllocationId || "")) {
            errors.push("desired routing artifact allocation does not match the purchase");
        }
    }

    return errors;
}

function getFulfillmentRequeueErrors(purchase) {
    const errors = [];
    const requeueableStates = new Set([
        FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW,
        FULFILLMENT_STATUS.DEAD_LETTER,
        FULFILLMENT_STATUS.RETRYABLE_FAILURE
    ]);

    if (purchase.status !== PURCHASE_STATUS.PAID) {
        errors.push("purchase is not paid");
    }

    if (!requeueableStates.has(purchase.fulfillmentStatus)) {
        errors.push("fulfillment is not in a requeueable admin-review state");
    }

    if (purchase.setupStatus !== SETUP_STATUS.SETUP_SUBMITTED) {
        errors.push("setup has not been fully submitted");
    }

    if (!purchase.serverId || purchase.serverStatus !== SERVER_STATUS.HELD) {
        errors.push("reserved capacity is not held");
    }

    if (!purchase.serverName) errors.push("server name is missing");
    if (!purchase.hostname || !purchase.hostnameReservationKey) errors.push("hostname reservation is missing");
    if (!purchase.productCode) errors.push("product code is missing");
    if (!purchase.inventoryBucketCode) errors.push("inventory bucket is missing");
    if (!purchase.nodeGroupCode) errors.push("node group is missing");
    if (!purchase.provisioningTargetCode) errors.push("provisioning target is missing");
    if (!purchase.minecraftVersion) errors.push("Minecraft version is missing");
    if (!purchase.runtimeProfileCode || !purchase.runtimeJavaVersion) {
        errors.push("resolved runtime profile is missing");
    }
    if (!purchase.pelicanUsername) errors.push("Pelican username is missing");

    if (!purchase.pelicanUserId && !purchase.email) {
        errors.push("customer email is missing for Pelican user creation");
    }

    if (!purchase.pelicanUserId && (
        !purchase.pelicanPasswordCiphertext ||
        !purchase.pelicanPasswordIv ||
        !purchase.pelicanPasswordAuthTag
    )) {
        errors.push("first-time Pelican password is not staged");
    }

    return errors;
}

function getRemoteString(value) {
    return String(value ?? "").trim();
}

function getRemoteServerIdentifier(server) {
    return getRemoteString(server?.identifier || server?.uuid_short || server?.uuid);
}

function getRemoteServerAllocationId(server) {
    return getRemoteString(server?.allocation || server?.allocation_id);
}

function getRemoteServerUserId(server) {
    return getRemoteString(server?.user);
}

function getPelicanReconcileStatus(purchase, facts) {
    const server = facts.server;
    const user = facts.user;
    const localServerId = getRemoteString(purchase.pelicanServerId);
    const localServerIdentifier = getRemoteString(purchase.pelicanServerIdentifier);
    const localAllocationId = getRemoteString(purchase.pelicanAllocationId);
    const localUserId = getRemoteString(purchase.pelicanUserId);
    const localUsername = getRemoteString(purchase.pelicanUsername);

    if (!localServerId && !localServerIdentifier && !localAllocationId && !localUserId && !localUsername) {
        return "no_local_linkage";
    }

    if ((localServerId || localServerIdentifier || localAllocationId) && !server) {
        return "missing_server";
    }

    if (server) {
        if (localServerId && getRemoteString(server.id) !== localServerId) {
            return "server_mismatch";
        }

        if (localServerIdentifier && getRemoteServerIdentifier(server) !== localServerIdentifier) {
            return "server_mismatch";
        }

        if (localAllocationId && getRemoteServerAllocationId(server) !== localAllocationId) {
            return "allocation_mismatch";
        }

        if (localUserId && getRemoteServerUserId(server) && getRemoteServerUserId(server) !== localUserId) {
            return "user_mismatch";
        }
    }

    if ((localUserId || localUsername) && !user) {
        return "missing_user";
    }

    if (user) {
        if (localUserId && getRemoteString(user.id) !== localUserId) {
            return "user_mismatch";
        }

        if (localUsername && getRemoteString(user.username) !== localUsername) {
            return "user_mismatch";
        }
    }

    return "ok";
}

function getSetupReopenErrors(purchase, existingJob) {
    const errors = [];
    const reopenableFulfillmentStates = new Set([
        FULFILLMENT_STATUS.NOT_STARTED,
        FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW,
        FULFILLMENT_STATUS.DEAD_LETTER,
        FULFILLMENT_STATUS.RETRYABLE_FAILURE
    ]);

    if (purchase.status !== PURCHASE_STATUS.PAID) {
        errors.push("purchase is not paid");
    }

    if (!purchase.serverId || purchase.serverStatus !== SERVER_STATUS.HELD) {
        errors.push("reserved capacity is not held");
    }

    if (!reopenableFulfillmentStates.has(purchase.fulfillmentStatus)) {
        errors.push("fulfillment is not in a setup-reopenable state");
    }

    if (purchase.pelicanUserId || purchase.pelicanServerId || purchase.pelicanServerIdentifier || purchase.pelicanAllocationId) {
        errors.push("Pelican linkage already exists; use explicit operator recovery instead");
    }

    if (purchase.desiredRoutingArtifactJson || purchase.desiredRoutingArtifactGeneratedAt) {
        errors.push("routing artifact already exists; setup cannot be reopened safely");
    }

    if (
        existingJob &&
        (
            existingJob.state === FULFILLMENT_QUEUE_STATE.QUEUED ||
            existingJob.state === FULFILLMENT_QUEUE_STATE.LEASED ||
            existingJob.state === FULFILLMENT_QUEUE_STATE.COMPLETED
        )
    ) {
        errors.push("purchase has an active or completed provisioning job");
    }

    return errors;
}

router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

router.post("/admin/login", loginLimiter, (req, res) => {
    const submittedKey = typeof req.body?.key === "string"
        ? req.body.key.trim()
        : "";

    if (!submittedKey || !timingSafeEqualString(submittedKey, config.adminKey)) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    const session = createAdminSession({
        userAgent: req.headers["user-agent"]
    });

    res.setHeader("Set-Cookie", serializeCookie(config.adminSessionCookieName, session.token, {
        httpOnly: true,
        maxAgeMs: config.adminSessionTtlMs,
        path: "/",
        priority: "High",
        sameSite: "Strict",
        secure: config.secureCookies
    }));

    res.json({ success: true });
});

router.post("/admin/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.adminSessionCookieName];

    if (token) {
        destroyAdminSession(token);
    }

    res.setHeader("Set-Cookie", clearCookie(config.adminSessionCookieName, {
        httpOnly: true,
        path: "/",
        priority: "High",
        sameSite: "Strict",
        secure: config.secureCookies
    }));

    res.json({ success: true });
});

router.use(adminApiLimiter);
router.use(requireAdmin);

function deepMerge(base, patch) {
    const result = { ...(base || {}) };

    for (const [key, value] of Object.entries(patch || {})) {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            result[key] &&
            typeof result[key] === "object" &&
            !Array.isArray(result[key])
        ) {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }

    return result;
}

function parseJsonField(value, fallback = null) {
    if (!value) return fallback;

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function maybeValidatePlanStripe(definition) {
    if (!definition.status.active && !definition.status.storefrontVisible) {
        return null;
    }

    return validateStripePriceId(stripe, definition.stripe.priceId, {
        currency: "usd",
        requireRecurring: true
    });
}

function serializeAdminPlan(plan) {
    return {
        planKey: plan.definition.planKey,
        productCode: plan.definition.productCode,
        active: plan.active,
        storefrontVisible: plan.storefrontVisible,
        sortOrder: plan.sortOrder,
        stripePriceId: plan.stripePriceId,
        stripePriceMetadata: plan.stripePriceMetadata,
        validationStatus: plan.validationStatus,
        validationErrors: plan.validationErrors,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        definition: plan.definition
    };
}

router.get("/admin/plans", async (req, res) => {
    try {
        const plans = await listPlanDefinitions();
        res.json(plans.map(serializeAdminPlan));
    } catch (err) {
        console.error("Admin plan list failed:", err);
        res.status(500).json({ error: "Could not load plans" });
    }
});

router.post("/admin/plans/preview", async (req, res) => {
    try {
        const preview = await previewPlanDefinition(req.body || {});
        const { definition } = preview;
        let stripeValidation = null;

        if ((definition.status.active || definition.status.storefrontVisible) && preview.validation.valid) {
            stripeValidation = await maybeValidatePlanStripe(definition);
            if (stripeValidation?.metadata) {
                applyStripePriceMetadata(definition, stripeValidation);
            }
        }

        const errors = [
            ...preview.validation.errors,
            ...(stripeValidation && !stripeValidation.valid ? stripeValidation.errors : [])
        ];

        res.json({
            definition,
            validation: {
                valid: errors.length === 0,
                errors
            },
            generated: {
                ...preview.generated,
                sortOrder: definition.sortOrder,
                cpuLimit: definition.runtime.cpuLimit,
                priceLabel: definition.public.priceLabel,
                priceAmount: definition.public.priceAmount,
                priceCurrency: definition.stripe.priceMetadata?.currency || null,
                recurringInterval: definition.stripe.priceMetadata?.recurringInterval || null
            },
            stripe: stripeValidation
        });
    } catch (err) {
        res.status(400).json({ error: err.message || "Could not preview plan" });
    }
});

router.post("/admin/plans", async (req, res) => {
    try {
        const preview = await previewPlanDefinition(req.body || {});
        const stripeValidation = await maybeValidatePlanStripe(preview.definition);
        const result = await savePlanDefinition(req.body || {}, { stripeValidation });

        if (!result.saved) {
            return res.status(400).json({
                error: "Plan definition is invalid.",
                validation: result.validation,
                definition: result.definition
            });
        }

        await recordEntityAdminAction(
            req,
            "plan",
            result.definition.planKey,
            "plan_save",
            result.previous?.definition || null,
            result.definition
        );

        res.status(result.previous ? 200 : 201).json({
            plan: result.definition,
            validation: result.validation,
            stripe: stripeValidation
        });
    } catch (err) {
        console.error("Admin plan save failed:", err);
        res.status(500).json({ error: "Could not save plan" });
    }
});

router.patch("/admin/plans/:planKey", async (req, res) => {
    try {
        const existing = await getPlanDefinition(req.params.planKey);

        if (!existing) {
            return res.status(404).json({ error: "Plan not found" });
        }

        const merged = deepMerge(existing.definition, req.body || {});
        const preview = await previewPlanDefinition(merged);
        const { definition } = preview;

        if (definition.planKey !== existing.definition.planKey) {
            return res.status(400).json({ error: "Plan short name cannot be changed through edit." });
        }

        const stripeValidation = await maybeValidatePlanStripe(definition);
        const result = await savePlanDefinition(merged, { stripeValidation });

        if (!result.saved) {
            return res.status(400).json({
                error: "Plan definition is invalid.",
                validation: result.validation,
                definition: result.definition
            });
        }

        await recordEntityAdminAction(
            req,
            "plan",
            result.definition.planKey,
            "plan_update",
            existing.definition,
            result.definition
        );

        res.json({
            plan: result.definition,
            validation: result.validation,
            stripe: stripeValidation
        });
    } catch (err) {
        console.error("Admin plan update failed:", err);
        res.status(500).json({ error: "Could not update plan" });
    }
});

router.post("/admin/plans/:planKey/validate", async (req, res) => {
    try {
        const existing = await getPlanDefinition(req.params.planKey);

        if (!existing) {
            return res.status(404).json({ error: "Plan not found" });
        }

        const validation = validatePlanDefinition(existing.definition);
        const stripeValidation = await maybeValidatePlanStripe(existing.definition);
        const errors = [
            ...validation.errors,
            ...(stripeValidation && !stripeValidation.valid ? stripeValidation.errors : [])
        ];

        res.json({
            valid: errors.length === 0,
            errors,
            stripe: stripeValidation
        });
    } catch (err) {
        console.error("Admin plan validation failed:", err);
        res.status(500).json({ error: "Could not validate plan" });
    }
});

async function listInventoryBuckets() {
    return allQuery(
        `SELECT
            b.*,
            p.planType,
            p.displayName AS planName,
            p.active AS planActive,
            p.storefrontVisible AS planStorefrontVisible,
            COALESCE(counts.total, 0) AS totalSlots,
            COALESCE(counts.available, 0) AS available,
            COALESCE(counts.held, 0) AS reserved,
            COALESCE(counts.allocated, 0) AS consumed
         FROM inventoryBuckets b
         LEFT JOIN products p ON p.code = b.productCode
         LEFT JOIN (
            SELECT
                inventoryBucketCode,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
                SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END) AS held,
                SUM(CASE WHEN status = 'allocated' THEN 1 ELSE 0 END) AS allocated
            FROM servers
            GROUP BY inventoryBucketCode
         ) counts ON counts.inventoryBucketCode = b.code
         ORDER BY b.code ASC`
    );
}

router.get("/admin/inventory-buckets", async (req, res) => {
    try {
        const buckets = await listInventoryBuckets();

        res.json(buckets.map(bucket => ({
            ...bucket,
            active: Number(bucket.active) === 1,
            purchaseEnabled: Number(bucket.purchaseEnabled) === 1,
            planActive: Number(bucket.planActive) === 1,
            planStorefrontVisible: Number(bucket.planStorefrontVisible) === 1,
            totalSlots: Number(bucket.totalSlots || 0),
            available: Number(bucket.available || 0),
            reserved: Number(bucket.reserved || 0),
            consumed: Number(bucket.consumed || 0),
            soldOut: Number(bucket.available || 0) === 0
        })));
    } catch (err) {
        console.error("Admin inventory list failed:", err);
        res.status(500).json({ error: "Could not load inventory buckets" });
    }
});

router.patch("/admin/inventory-buckets/:bucketCode", async (req, res) => {
    const bucketCode = String(req.params.bucketCode || "").trim();

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const bucket = await getQuery(
            `SELECT b.*, p.planType, p.price, p.runtimeFamily, p.runtimeTemplate,
                    p.nodeGroupCode, p.provisioningTargetCode
             FROM inventoryBuckets b
             JOIN products p ON p.code = b.productCode
             WHERE b.code = ?`,
            [bucketCode]
        );

        if (!bucket) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Inventory bucket not found" });
        }

        const counts = await getQuery(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS available,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS reserved,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS consumed
             FROM servers
             WHERE inventoryBucketCode = ?`,
            [SERVER_STATUS.AVAILABLE, SERVER_STATUS.HELD, SERVER_STATUS.ALLOCATED, bucketCode]
        );
        const oldValue = { bucket, counts };
        const currentTotal = Number(counts.total || 0);
        const available = Number(counts.available || 0);
        const protectedUsage = Number(counts.reserved || 0) + Number(counts.consumed || 0);
        const totalSlots = req.body?.totalSlots === undefined
            ? currentTotal
            : Number(req.body.totalSlots);

        if (!Number.isInteger(totalSlots) || totalSlots < 0) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Total slots must be a non-negative integer." });
        }

        if (totalSlots < protectedUsage) {
            await rollbackTransaction();
            return res.status(409).json({ error: "Total slots cannot be reduced below reserved and consumed usage." });
        }

        if (totalSlots < currentTotal) {
            const removeCount = currentTotal - totalSlots;

            if (removeCount > available) {
                await rollbackTransaction();
                return res.status(409).json({ error: "Only available slots can be removed." });
            }

            await runQuery(
                `DELETE FROM servers
                 WHERE id IN (
                    SELECT id
                    FROM servers
                    WHERE inventoryBucketCode = ?
                      AND status = ?
                    ORDER BY id DESC
                    LIMIT ?
                 )`,
                [bucketCode, SERVER_STATUS.AVAILABLE, removeCount]
            );
        } else if (totalSlots > currentTotal) {
            for (let index = currentTotal; index < totalSlots; index += 1) {
                await runQuery(
                    `INSERT INTO servers
                        (
                            type,
                            price,
                            status,
                            productCode,
                            inventoryBucketCode,
                            nodeGroupCode,
                            provisioningTargetCode,
                            runtimeFamily,
                            runtimeTemplate
                        )
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        bucket.planType,
                        bucket.price,
                        SERVER_STATUS.AVAILABLE,
                        bucket.productCode,
                        bucketCode,
                        bucket.nodeGroupCode,
                        bucket.provisioningTargetCode,
                        bucket.runtimeFamily,
                        bucket.runtimeTemplate
                    ]
                );
            }
        }

        const purchaseEnabled = req.body?.purchaseEnabled === undefined
            ? Number(bucket.purchaseEnabled || 1)
            : (req.body.purchaseEnabled === true || req.body.purchaseEnabled === "true" ? 1 : 0);
        const active = req.body?.active === undefined
            ? Number(bucket.active || 1)
            : (req.body.active === true || req.body.active === "true" ? 1 : 0);
        const adminNotes = req.body?.adminNotes === undefined
            ? bucket.adminNotes
            : String(req.body.adminNotes || "").trim().slice(0, 1000);

        await runQuery(
            `UPDATE inventoryBuckets
             SET capacityTarget = ?,
                 purchaseEnabled = ?,
                 active = ?,
                 adminNotes = ?
             WHERE code = ?`,
            [totalSlots, purchaseEnabled, active, adminNotes || null, bucketCode]
        );

        await runQuery("COMMIT");

        const updated = (await listInventoryBuckets()).find(entry => entry.code === bucketCode);
        await recordEntityAdminAction(req, "inventory_bucket", bucketCode, "inventory_bucket_update", oldValue, updated);

        res.json({ bucket: updated });
    } catch (err) {
        await rollbackTransaction();
        console.error("Admin inventory update failed:", err);
        res.status(500).json({ error: "Could not update inventory bucket" });
    }
});

router.get("/admin/provisioning-targets", async (req, res) => {
    try {
        const targets = await allQuery(
            `SELECT
                t.*,
                g.displayName AS nodeGroupName,
                g.active AS nodeGroupActive,
                GROUP_CONCAT(DISTINCT b.code) AS linkedBuckets,
                GROUP_CONCAT(DISTINCT p.planType) AS linkedPlans
             FROM provisioningTargets t
             LEFT JOIN nodeGroups g ON g.code = t.nodeGroupCode
             LEFT JOIN products p ON p.provisioningTargetCode = t.code
             LEFT JOIN inventoryBuckets b ON b.productCode = p.code
             GROUP BY t.code
             ORDER BY t.code ASC`
        );

        res.json(targets.map(target => ({
            ...target,
            active: Number(target.active) === 1,
            nodeGroupActive: Number(target.nodeGroupActive) === 1,
            supportedVersions: parseJsonField(target.supportedVersionsJson, []),
            linkedBuckets: target.linkedBuckets ? target.linkedBuckets.split(",") : [],
            linkedPlans: target.linkedPlans ? target.linkedPlans.split(",") : []
        })));
    } catch (err) {
        console.error("Admin target list failed:", err);
        res.status(500).json({ error: "Could not load provisioning targets" });
    }
});

router.patch("/admin/provisioning-targets/:targetCode", async (req, res) => {
    const targetCode = String(req.params.targetCode || "").trim();

    try {
        const existing = await getQuery("SELECT * FROM provisioningTargets WHERE code = ?", [targetCode]);

        if (!existing) {
            return res.status(404).json({ error: "Provisioning target not found" });
        }

        const active = req.body?.active === undefined
            ? Number(existing.active || 1)
            : (req.body.active === true || req.body.active === "true" ? 1 : 0);
        const displayName = req.body?.displayName === undefined
            ? existing.displayName
            : String(req.body.displayName || "").trim().slice(0, 160);
        const adminNotes = req.body?.adminNotes === undefined
            ? existing.adminNotes
            : String(req.body.adminNotes || "").trim().slice(0, 1000);

        if (!displayName) {
            return res.status(400).json({ error: "Display name is required." });
        }

        await runQuery(
            `UPDATE provisioningTargets
             SET active = ?,
                 displayName = ?,
                 adminNotes = ?
             WHERE code = ?`,
            [active, displayName, adminNotes || null, targetCode]
        );

        const updated = await getQuery("SELECT * FROM provisioningTargets WHERE code = ?", [targetCode]);
        await recordEntityAdminAction(req, "provisioning_target", targetCode, "provisioning_target_update", existing, updated);

        res.json({ target: updated });
    } catch (err) {
        console.error("Admin target update failed:", err);
        res.status(500).json({ error: "Could not update provisioning target" });
    }
});

router.get("/admin/waitlist", async (req, res) => {
    const planKey = typeof req.query.planKey === "string" ? req.query.planKey.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const filters = [];
    const params = [];

    if (planKey) {
        filters.push("w.planKey = ?");
        params.push(planKey);
    }

    if (status) {
        filters.push("w.status = ?");
        params.push(status);
    }

    if (search) {
        filters.push("w.email LIKE ?");
        params.push(`%${search}%`);
    }

    try {
        const rows = await allQuery(
            `SELECT
                w.*,
                p.displayName AS planName,
                b.displayName AS bucketName
             FROM waitlistEntries w
             LEFT JOIN products p ON p.code = w.productCode
             LEFT JOIN inventoryBuckets b ON b.code = w.inventoryBucketCode
             ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
             ORDER BY w.createdAt DESC, w.id DESC
             LIMIT 250`,
            params
        );

        res.json(rows);
    } catch (err) {
        console.error("Admin waitlist list failed:", err);
        res.status(500).json({ error: "Could not load waitlist" });
    }
});

router.patch("/admin/waitlist/:id", async (req, res) => {
    const id = Number(req.params.id);
    const nextStatus = String(req.body?.status || "").trim();
    const allowedStatuses = new Set(["waiting", "notified", "converted", "closed"]);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid waitlist entry id." });
    }

    if (!allowedStatuses.has(nextStatus)) {
        return res.status(400).json({ error: "Invalid waitlist status." });
    }

    try {
        const existing = await getQuery("SELECT * FROM waitlistEntries WHERE id = ?", [id]);

        if (!existing) {
            return res.status(404).json({ error: "Waitlist entry not found" });
        }

        await runQuery(
            "UPDATE waitlistEntries SET status = ?, updatedAt = ? WHERE id = ?",
            [nextStatus, Date.now(), id]
        );

        const updated = await getQuery("SELECT * FROM waitlistEntries WHERE id = ?", [id]);
        await recordEntityAdminAction(
            req,
            "waitlist_entry",
            String(id),
            "waitlist_status_update",
            existing,
            updated
        );

        res.json({ entry: updated });
    } catch (err) {
        console.error("Admin waitlist update failed:", err);
        res.status(500).json({ error: "Could not update waitlist entry" });
    }
});

router.get("/purchases", async (req, res) => {
    try {
        const purchases = await allQuery(
            `SELECT
                p.*,
                s.status AS serverStatus,
                s.type AS serverType,
                s.price AS serverPrice,
                COALESCE(p.planType, s.type) AS planType
             FROM purchases p
             LEFT JOIN servers s ON s.id = p.serverId
             ORDER BY COALESCE(p.createdAt, 0) DESC, p.id DESC`
        );
        const auditMap = await getAuditLogMap(purchases.map(purchase => purchase.id));
        const emailOutboxMap = await getEmailOutboxMap(purchases.map(purchase => purchase.id));
        const provisioningJobMap = await getProvisioningJobMap(purchases.map(purchase => purchase.id));

        res.json(
            purchases.map(purchase => serializePurchase(
                purchase,
                null,
                auditMap.get(purchase.id) || [],
                emailOutboxMap.get(purchase.id) || [],
                {
                    existingProvisioningJob: provisioningJobMap.get(purchase.id) || null
                }
            ))
        );
    } catch (err) {
        console.error("Admin purchase list failed:", err);
        res.status(500).json({ error: "Could not load purchases" });
    }
});

router.post("/admin/purchases/:purchaseId/reconcile-stripe", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    const adminNote = normalizeOptionalText(req.body?.adminNote, 500);

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            return res.status(404).json({ error: "Purchase not found" });
        }

        if (!purchase.stripeSessionId) {
            return res.status(400).json({ error: "Purchase has no Stripe session ID to check." });
        }

        const session = await stripe.checkout.sessions.retrieve(purchase.stripeSessionId);
        const subscriptionId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        const subscription = subscriptionId
            ? await stripe.subscriptions.retrieve(subscriptionId)
            : null;
        let action = "no_change";

        if (session.payment_status === "paid") {
            await markPurchasePaid(session, subscription);
            action = "marked_paid";
        } else if (session.status === "expired") {
            await expirePurchase(session);
            action = "marked_expired";
        }

        await recordAdminAction(req, purchaseId, "reconcile_stripe", adminNote.value || "", {
            action,
            stripeSessionId: session.id,
            stripeSubscriptionId: subscription?.id || subscriptionId || "",
            stripeStatus: session.status,
            stripePaymentStatus: session.payment_status
        });

        const serialized = await loadSerializedPurchase(purchaseId, {
            id: session.id,
            status: session.status,
            paymentStatus: session.payment_status,
            customerEmail: session.customer_details?.email || session.customer_email || "",
            subscriptionId: subscription?.id || subscriptionId || "",
            subscriptionStatus: subscription?.status || "",
            currentPeriodEnd: subscription?.items?.data?.[0]?.current_period_end
                ? subscription.items.data[0].current_period_end * 1000
                : subscription?.current_period_end
                    ? subscription.current_period_end * 1000
                    : null,
            cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end)
        });

        res.json({
            success: true,
            action,
            purchase: serialized
        });
    } catch (err) {
        console.error("Stripe reconcile failed:", err);
        res.status(500).json({ error: "Could not reconcile purchase with Stripe" });
    }
});

router.post("/admin/purchases/:purchaseId/reconcile-pelican", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        await runQuery("COMMIT");

        const facts = await fetchPelicanPurchaseFacts(purchase);
        const reconcileStatus = getPelicanReconcileStatus(purchase, facts);
        const now = Date.now();

        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const currentPurchase = await getPurchaseRecord(purchaseId);

        if (!currentPurchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        await runQuery(
            `UPDATE purchases
             SET pelicanUserStateJson = ?,
                 pelicanServerStateJson = ?,
                 pelicanReconcileStatus = ?,
                 pelicanReconciledAt = ?,
                 reconciledAt = ?,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?`,
            [
                facts.user ? JSON.stringify(facts.user) : null,
                facts.server ? JSON.stringify(facts.server) : null,
                reconcileStatus,
                now,
                now,
                now,
                "admin",
                purchaseId
            ]
        );

        await recordAdminAction(req, purchaseId, "reconcile_pelican", adminNote.value || "", {
            reconcileStatus,
            lookup: facts.lookup,
            serverFound: Boolean(facts.server),
            userFound: Boolean(facts.user),
            local: {
                pelicanUserId: currentPurchase.pelicanUserId || null,
                pelicanUsername: currentPurchase.pelicanUsername || null,
                pelicanServerId: currentPurchase.pelicanServerId || null,
                pelicanServerIdentifier: currentPurchase.pelicanServerIdentifier || null,
                pelicanAllocationId: currentPurchase.pelicanAllocationId || null
            },
            remote: {
                userId: facts.user?.id || null,
                username: facts.user?.username || null,
                serverId: facts.server?.id || null,
                serverIdentifier: getRemoteServerIdentifier(facts.server),
                allocationId: getRemoteServerAllocationId(facts.server)
            }
        });

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            reconcileStatus,
            purchase: serialized
        });
    } catch (err) {
        await rollbackTransaction();

        if (err instanceof ProvisioningBlockedError) {
            return res.status(400).json({ error: err.message });
        }

        console.error("Pelican reconcile failed:", err);
        res.status(500).json({ error: "Could not reconcile purchase with Pelican" });
    }
});

router.patch("/admin/purchases/:purchaseId", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    let emailInput;
    let serverNameInput;
    let stripeSessionInput;
    let adminNote;

    try {
        emailInput = normalizeOptionalText(req.body?.email, 320);
        serverNameInput = normalizeOptionalText(req.body?.serverName, 64);
        stripeSessionInput = normalizeOptionalText(req.body?.stripeSessionId, 255);
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const nextStatus = req.body?.status;
    const nextServerStatus = req.body?.serverStatus;
    const setupTokenAction = typeof req.body?.setupTokenAction === "string"
        ? req.body.setupTokenAction.trim()
        : "keep";
    const serviceAccessAction = typeof req.body?.serviceAccessAction === "string"
        ? req.body.serviceAccessAction.trim()
        : "keep";

    if (nextStatus !== undefined && !PURCHASE_STATUSES.has(nextStatus)) {
        return res.status(400).json({ error: "Invalid purchase status override" });
    }

    if (nextServerStatus !== undefined && !SERVER_STATUSES.has(nextServerStatus)) {
        return res.status(400).json({ error: "Invalid server status override" });
    }

    if (!["keep", "refresh", "regenerate", "clear"].includes(setupTokenAction)) {
        return res.status(400).json({ error: "Invalid setup token action" });
    }

    if (!["keep", "suspend", "reinstate"].includes(serviceAccessAction)) {
        return res.status(400).json({ error: "Invalid service access action" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        const policy = getPurchasePolicyState(purchase);

        const status = nextStatus || purchase.status;
        let serverStatus = nextServerStatus || inferServerStatus({
            ...purchase,
            status
        });
        const email = emailInput.present ? emailInput.value : (purchase.email || "");
        const serverName = serverNameInput.present ? serverNameInput.value : (purchase.serverName || "");
        const stripeSessionId = stripeSessionInput.present
            ? (stripeSessionInput.value || null)
            : (purchase.stripeSessionId || null);

        let setupToken = purchase.setupToken || null;
        let setupTokenExpiresAt = purchase.setupTokenExpiresAt || null;
        let serviceSuspendedAt = purchase.serviceSuspendedAt || null;

        if (emailInput.present) {
            try {
                assertEmailHeaderSafe(email, "Email");
            } catch (err) {
                await rollbackTransaction();
                return res.status(400).json({ error: err.message });
            }
        }

        if (setupTokenAction === "clear") {
            setupToken = null;
            setupTokenExpiresAt = null;
        } else if (setupTokenAction === "regenerate" || !setupToken) {
            setupToken = generateOpaqueToken();
            setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;
        } else if (setupTokenAction === "refresh") {
            setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;
        }

        if (setupToken && !isOpaqueToken(setupToken)) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Generated setup token was invalid" });
        }

        if (
            (status === PURCHASE_STATUS.CANCELLED || status === PURCHASE_STATUS.EXPIRED) &&
            policy.requiresStripeCancellation
        ) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Live subscriptions must be ended in Stripe first or set to cancel at period end."
            });
        }

        if (
            serverStatus === SERVER_STATUS.AVAILABLE &&
            status === PURCHASE_STATUS.COMPLETED &&
            !policy.canReleaseInventory
        ) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Active or recoverable subscriptions cannot release inventory from the admin panel."
            });
        }

        if (serviceAccessAction === "suspend") {
            if (status !== PURCHASE_STATUS.COMPLETED) {
                await rollbackTransaction();
                return res.status(400).json({
                    error: "Only fulfilled subscriptions can be marked suspended."
                });
            }

            serviceSuspendedAt = Date.now();
            serverStatus = SERVER_STATUS.HELD;
        }

        if (serviceAccessAction === "reinstate") {
            if (policy.isTerminalSubscription) {
                await rollbackTransaction();
                return res.status(400).json({
                    error: "Terminal subscriptions cannot be reinstated."
                });
            }

            serviceSuspendedAt = null;

            if (status === PURCHASE_STATUS.COMPLETED) {
                serverStatus = SERVER_STATUS.ALLOCATED;
            }
        }

        const nextPurchase = mergeLifecycleState(purchase, {
            status,
            serverName,
            serviceSuspendedAt,
            lastStateOwner: "admin"
        });

        await runQuery(
            `UPDATE purchases
             SET status = ?,
                 email = ?,
                 serverName = ?,
                 stripeSessionId = ?,
                 setupToken = ?,
                 setupTokenExpiresAt = ?,
                 serviceSuspendedAt = ?,
                 setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 customerRiskStatus = ?,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?`,
            [
                nextPurchase.status,
                email,
                serverName,
                stripeSessionId,
                setupToken,
                setupTokenExpiresAt,
                serviceSuspendedAt,
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                nextPurchase.customerRiskStatus,
                Date.now(),
                nextPurchase.lastStateOwner,
                purchaseId
            ]
        );

        if (purchase.serverId) {
            await runQuery(
                "UPDATE servers SET status = ? WHERE id = ?",
                [serverStatus, purchase.serverId]
            );
        }

        await recordAdminAction(req, purchaseId, "manual_override", adminNote.value || "", {
            from: {
                status: purchase.status,
                serverStatus: purchase.serverStatus,
                email: purchase.email || "",
                serverName: purchase.serverName || "",
                stripeSessionId: purchase.stripeSessionId || "",
                setupTokenPresent: Boolean(purchase.setupToken),
                serviceSuspendedAt: purchase.serviceSuspendedAt || null
            },
            to: {
                status,
                serverStatus,
                email,
                serverName,
                stripeSessionId: stripeSessionId || "",
                setupTokenAction,
                serviceAccessAction,
                serviceSuspendedAt
            }
        });

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            purchase: serialized,
            overrideSummary: {
                status,
                serverStatus,
                setupTokenAction
            }
        });
    } catch (err) {
        await rollbackTransaction();

        if (String(err.message || "").includes("UNIQUE constraint failed")) {
            return res.status(400).json({
                error: "That Stripe session or setup token is already attached elsewhere."
            });
        }

        console.error("Purchase override failed:", err);
        res.status(500).json({ error: "Could not apply purchase override" });
    }
});

router.post("/admin/purchases/:purchaseId/requeue-fulfillment", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        const requeueErrors = getFulfillmentRequeueErrors(purchase);

        if (requeueErrors.length > 0) {
            await rollbackTransaction();
            return res.status(400).json({
                error: `Purchase cannot be requeued yet: ${requeueErrors.join("; ")}.`
            });
        }

        const idempotencyKey = buildProvisioningIdempotencyKey(purchase.id);
        const existingJob = await getQuery(
            `SELECT *
             FROM fulfillmentQueue
             WHERE idempotencyKey = ?`,
            [idempotencyKey]
        );

        if (
            existingJob &&
            (existingJob.state === FULFILLMENT_QUEUE_STATE.QUEUED ||
                existingJob.state === FULFILLMENT_QUEUE_STATE.LEASED)
        ) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "This purchase already has an active provisioning job."
            });
        }

        const now = Date.now();
        const payloadJson = JSON.stringify(buildProvisioningPayload(purchase));

        if (existingJob) {
            await runQuery(
                `UPDATE fulfillmentQueue
                 SET purchaseId = ?,
                     taskType = ?,
                     state = ?,
                     payloadJson = ?,
                     availableAt = ?,
                     lockedAt = NULL,
                     attempts = 0,
                     lastError = NULL,
                     leaseKey = NULL,
                     leaseExpiresAt = NULL,
                     completedAt = NULL,
                     updatedAt = ?
                 WHERE id = ?
                   AND state NOT IN (?, ?)`,
                [
                    purchase.id,
                    FULFILLMENT_TASK_TYPE.PROVISION_INITIAL_SERVER,
                    FULFILLMENT_QUEUE_STATE.QUEUED,
                    payloadJson,
                    now,
                    now,
                    existingJob.id,
                    FULFILLMENT_QUEUE_STATE.QUEUED,
                    FULFILLMENT_QUEUE_STATE.LEASED
                ]
            );
        } else {
            await runQuery(
                `INSERT INTO fulfillmentQueue
                    (
                        purchaseId,
                        taskType,
                        state,
                        idempotencyKey,
                        payloadJson,
                        availableAt,
                        createdAt,
                        updatedAt
                    )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    purchase.id,
                    FULFILLMENT_TASK_TYPE.PROVISION_INITIAL_SERVER,
                    FULFILLMENT_QUEUE_STATE.QUEUED,
                    idempotencyKey,
                    payloadJson,
                    now,
                    now,
                    now
                ]
            );
        }

        const nextPurchase = mergeLifecycleState(purchase, {
            fulfillmentStatus: FULFILLMENT_STATUS.QUEUED,
            fulfillmentFailureClass: null,
            needsAdminReviewReason: null,
            lastProvisioningError: null,
            workerLeaseKey: null,
            workerLeaseExpiresAt: null,
            lastStateOwner: "admin"
        });

        await runQuery(
            `UPDATE purchases
             SET fulfillmentStatus = ?,
                 fulfillmentFailureClass = NULL,
                 needsAdminReviewReason = NULL,
                 lastProvisioningError = NULL,
                 workerLeaseKey = NULL,
                 workerLeaseExpiresAt = NULL,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?`,
            [
                nextPurchase.fulfillmentStatus,
                now,
                nextPurchase.lastStateOwner,
                purchase.id
            ]
        );

        await recordAdminAction(req, purchaseId, "requeue_fulfillment", adminNote.value || "", {
            fromFulfillmentStatus: purchase.fulfillmentStatus,
            toFulfillmentStatus: nextPurchase.fulfillmentStatus,
            queueIdempotencyKey: idempotencyKey
        });

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            purchase: serialized
        });
    } catch (err) {
        await rollbackTransaction();
        console.error("Fulfillment requeue failed:", err);
        res.status(500).json({ error: "Could not requeue fulfillment" });
    }
});

router.post("/admin/purchases/:purchaseId/reopen-setup", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        const idempotencyKey = buildProvisioningIdempotencyKey(purchase.id);
        const existingJob = await getQuery(
            `SELECT *
             FROM fulfillmentQueue
             WHERE idempotencyKey = ?`,
            [idempotencyKey]
        );
        const reopenErrors = getSetupReopenErrors(purchase, existingJob);

        if (reopenErrors.length > 0) {
            await rollbackTransaction();
            return res.status(400).json({
                error: `Setup cannot be reopened yet: ${reopenErrors.join("; ")}.`
            });
        }

        const now = Date.now();
        const nextPurchase = mergeLifecycleState(purchase, {
            serverName: null,
            hostname: null,
            hostnameReservationKey: null,
            minecraftVersion: null,
            runtimeProfileCode: null,
            runtimeJavaVersion: null,
            pelicanUsername: null,
            fulfillmentStatus: FULFILLMENT_STATUS.NOT_STARTED,
            fulfillmentFailureClass: null,
            needsAdminReviewReason: null,
            lastProvisioningError: null,
            lastProvisioningAttemptAt: null,
            workerLeaseKey: null,
            workerLeaseExpiresAt: null,
            lastStateOwner: "admin"
        });

        await runQuery(
            `UPDATE purchases
             SET serverName = NULL,
                 hostname = NULL,
                 hostnameReservationKey = NULL,
                 hostnameReservedAt = NULL,
                 hostnameReleasedAt = NULL,
                 minecraftVersion = NULL,
                 runtimeProfileCode = NULL,
                 runtimeJavaVersion = NULL,
                 pelicanUsername = NULL,
                 pelicanPasswordCiphertext = NULL,
                 pelicanPasswordIv = NULL,
                 pelicanPasswordAuthTag = NULL,
                 pelicanPasswordStoredAt = NULL,
                 setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 customerRiskStatus = ?,
                 fulfillmentFailureClass = NULL,
                 needsAdminReviewReason = NULL,
                 lastProvisioningError = NULL,
                 lastProvisioningAttemptAt = NULL,
                 workerLeaseKey = NULL,
                 workerLeaseExpiresAt = NULL,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?`,
            [
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                nextPurchase.customerRiskStatus,
                now,
                nextPurchase.lastStateOwner,
                purchase.id
            ]
        );

        await recordAdminAction(req, purchaseId, "reopen_setup", adminNote.value || "", {
            from: {
                setupStatus: purchase.setupStatus,
                fulfillmentStatus: purchase.fulfillmentStatus,
                serverName: purchase.serverName || "",
                hostname: purchase.hostname || "",
                minecraftVersion: purchase.minecraftVersion || "",
                runtimeProfileCode: purchase.runtimeProfileCode || "",
                pelicanUsername: purchase.pelicanUsername || "",
                queueState: existingJob?.state || null
            },
            to: {
                setupStatus: nextPurchase.setupStatus,
                fulfillmentStatus: nextPurchase.fulfillmentStatus,
                setupTokenExpiresAt: purchase.setupTokenExpiresAt || null,
                queueState: existingJob?.state || null
            }
        });

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            purchase: serialized
        });
    } catch (err) {
        await rollbackTransaction();
        console.error("Setup reopen failed:", err);
        res.status(500).json({ error: "Could not reopen setup" });
    }
});

router.post("/admin/purchases/:purchaseId/mark-hard-flag", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        const policy = getPurchasePolicyState(purchase);

        if (!policy.purgeRequired) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Purchase cannot be hard-flagged until suspended retention has reached purge review."
            });
        }

        if (purchase.customerRiskStatus === CUSTOMER_RISK_STATUS.HARD_FLAGGED) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Purchase is already hard-flagged."
            });
        }

        const now = Date.now();
        const nextPurchase = mergeLifecycleState(purchase, {
            customerRiskStatus: CUSTOMER_RISK_STATUS.HARD_FLAGGED,
            lastStateOwner: "admin"
        });

        await runQuery(
            `UPDATE purchases
             SET customerRiskStatus = ?,
                 setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?`,
            [
                nextPurchase.customerRiskStatus,
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                now,
                nextPurchase.lastStateOwner,
                purchase.id
            ]
        );

        await recordAdminAction(
            req,
            purchase.id,
            "admin_mark_hard_flag",
            adminNote.value || "",
            {
                serviceSuspendedAt: Number(purchase.serviceSuspendedAt || 0) || null,
                purgeEligibleAt: policy.purgeEligibleAt || null,
                serverId: purchase.serverId || null,
                serverStatus: purchase.serverStatus || null,
                pelicanServerId: purchase.pelicanServerId || null,
                pelicanServerIdentifier: purchase.pelicanServerIdentifier || null,
                pelicanAllocationId: purchase.pelicanAllocationId || null,
                destructiveCleanupPerformedExternally: true
            }
        );

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            purchase: serialized
        });
    } catch (err) {
        await rollbackTransaction();
        console.error("Hard flag failed:", err);
        res.status(500).json({ error: "Could not mark purchase hard-flagged" });
    }
});

router.post("/admin/purchases/:purchaseId/verify-routing", async (req, res) => {
    const purchaseId = Number(req.params.purchaseId);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(404).json({ error: "Purchase not found" });
        }

        const verificationErrors = getRoutingVerificationErrors(purchase);

        if (verificationErrors.length > 0) {
            await rollbackTransaction();
            return res.status(400).json({
                error: `Routing cannot be verified yet: ${verificationErrors.join("; ")}.`
            });
        }

        if (purchase.routingVerifiedAt) {
            await rollbackTransaction();
            const serialized = await loadSerializedPurchase(purchaseId);

            return res.json({
                success: true,
                action: "already_verified",
                purchase: serialized
            });
        }

        const now = Date.now();

        await runQuery(
            `UPDATE purchases
             SET routingVerifiedAt = ?,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?
               AND routingVerifiedAt IS NULL`,
            [
                now,
                now,
                "admin",
                purchaseId
            ]
        );

        await recordAdminAction(req, purchaseId, "verify_routing", adminNote.value || "", {
            hostname: purchase.hostname,
            pelicanServerIdentifier: purchase.pelicanServerIdentifier,
            pelicanAllocationId: purchase.pelicanAllocationId,
            desiredRoutingArtifactGeneratedAt: purchase.desiredRoutingArtifactGeneratedAt || null,
            routingVerifiedAt: now
        });

        await runQuery("COMMIT");

        const serialized = await loadSerializedPurchase(purchaseId);

        res.json({
            success: true,
            action: "verified",
            purchase: serialized
        });
    } catch (err) {
        await rollbackTransaction();
        console.error("Routing verification failed:", err);
        res.status(500).json({ error: "Could not verify routing" });
    }
});

router.post("/complete", async (req, res) => {
    const purchaseId = Number(req.body?.purchaseId);
    const routingVerified = parseRoutingVerified(req.body?.routingVerified);
    let adminNote;

    try {
        adminNote = normalizeOptionalText(req.body?.adminNote, 500);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase id" });
    }

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getPurchaseRecord(purchaseId);

        if (!purchase) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Purchase not found" });
        }

        if (purchase.status === PURCHASE_STATUS.COMPLETED) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Purchase already completed" });
        }

        const releaseErrors = getReadyReleaseErrors(purchase);

        if (releaseErrors.length > 0) {
            await rollbackTransaction();
            return res.status(400).json({
                error: `Purchase cannot be released yet: ${releaseErrors.join("; ")}.`
            });
        }

        if (!routingVerified && !purchase.routingVerifiedAt) {
            await rollbackTransaction();
            return res.status(400).json({
                error: "Operator routing verification is required before release."
            });
        }

        const releasedAt = Date.now();
        const routingVerifiedAt = purchase.routingVerifiedAt || releasedAt;
        const nextPurchase = mergeLifecycleState(purchase, {
            status: PURCHASE_STATUS.COMPLETED,
            routingVerifiedAt,
            readyEmailQueuedAt: purchase.readyEmailQueuedAt || releasedAt,
            lastStateOwner: "admin"
        });

        await runQuery(
            `UPDATE purchases
             SET status = ?,
                 setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 customerRiskStatus = ?,
                 completedAt = COALESCE(completedAt, ?),
                 releasedAt = COALESCE(releasedAt, ?),
                 adminReleaseActionAt = COALESCE(adminReleaseActionAt, ?),
                 routingVerifiedAt = COALESCE(routingVerifiedAt, ?),
                 readyEmailQueuedAt = COALESCE(readyEmailQueuedAt, ?),
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?
               AND status = ?`,
            [
                nextPurchase.status,
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                nextPurchase.customerRiskStatus,
                releasedAt,
                releasedAt,
                releasedAt,
                routingVerifiedAt,
                releasedAt,
                releasedAt,
                nextPurchase.lastStateOwner,
                purchaseId,
                PURCHASE_STATUS.PAID
            ]
        );

        const readyPurchase = {
            ...purchase,
            ...nextPurchase,
            routingVerifiedAt,
            readyEmailQueuedAt: purchase.readyEmailQueuedAt || releasedAt
        };
        const readyEmail = await enqueueReadyEmailForPurchase(readyPurchase, { now: releasedAt });

        await recordAdminAction(req, purchaseId, "release_ready", adminNote.value || "", {
            serverId: purchase.serverId,
            hostname: purchase.hostname,
            pelicanUsername: purchase.pelicanUsername,
            pelicanServerIdentifier: purchase.pelicanServerIdentifier,
            pelicanAllocationId: purchase.pelicanAllocationId,
            routingVerifiedAt,
            readyEmailIdempotencyKey: readyEmail.idempotencyKey,
            fromStatus: purchase.status,
            toStatus: PURCHASE_STATUS.COMPLETED
        });
        await runQuery("COMMIT");

        res.json({ success: true });
    } catch (err) {
        await rollbackTransaction();
        console.error("Admin completion failed:", err);
        res.status(500).json({ error: "Could not complete purchase" });
    }
});

module.exports = router;
