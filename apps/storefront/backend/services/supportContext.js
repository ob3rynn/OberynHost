const config = require("../config");
const { getQuery, allQuery } = require("../db/queries");
const { parseCookies } = require("../utils/cookies");
const { isOpaqueToken } = require("../utils/tokens");
const {
    PURCHASE_STATUS,
    FULFILLMENT_STATUS,
    SERVICE_STATUS,
    SETUP_STATUS
} = require("../constants/status");
const { getPurchasePolicyState } = require("./policyRules");
const { verifyServiceAccessToken } = require("./serviceAccessLinks");

function getSetupTokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = typeof cookies[config.setupSessionCookieName] === "string"
        ? cookies[config.setupSessionCookieName].trim()
        : "";
    const bodyToken = typeof req.body?.setupToken === "string"
        ? req.body.setupToken.trim()
        : "";

    return cookieToken || bodyToken;
}

function getServiceAccessTokenFromRequest(req) {
    const bodyToken = typeof req.body?.accessToken === "string"
        ? req.body.accessToken.trim()
        : "";
    const paramToken = typeof req.params?.accessToken === "string"
        ? req.params.accessToken.trim()
        : "";

    return bodyToken || paramToken;
}

function parseJson(value, fallback = null) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function publicSetupStatusText(purchase) {
    switch (purchase?.setupStatus) {
        case SETUP_STATUS.SETUP_PENDING:
            return "Payment is verified. Server details are still needed before provisioning can begin.";
        case SETUP_STATUS.SETUP_SUBMITTED:
            return "Server details were received and provisioning is in progress or awaiting final checks.";
        case SETUP_STATUS.NOT_STARTED:
        default:
            if (purchase?.status === PURCHASE_STATUS.CHECKOUT_PENDING) {
                return "Payment is still being verified.";
            }
            return "Setup has not started yet.";
    }
}

function publicFulfillmentStatusText(purchase) {
    switch (purchase?.fulfillmentStatus) {
        case FULFILLMENT_STATUS.READY:
            return "Your service is ready.";
        case FULFILLMENT_STATUS.PENDING_ACTIVATION:
            return "Your service is prepared and waiting on final routing checks.";
        case FULFILLMENT_STATUS.PROVISIONING:
        case FULFILLMENT_STATUS.QUEUED:
            return "Your service is being prepared.";
        case FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW:
        case FULFILLMENT_STATUS.RETRYABLE_FAILURE:
        case FULFILLMENT_STATUS.DEAD_LETTER:
            return "Your service needs an OberynHost review before it can continue.";
        case FULFILLMENT_STATUS.DELETED:
            return "This service is no longer active.";
        case FULFILLMENT_STATUS.NOT_STARTED:
        default:
            return "Provisioning has not started yet.";
    }
}

function publicServiceStatusText(purchase) {
    switch (purchase?.serviceStatus) {
        case SERVICE_STATUS.ACTIVE:
            return "Your service is active.";
        case SERVICE_STATUS.CANCEL_SCHEDULED:
            return "Your service is active until the scheduled cancellation date.";
        case SERVICE_STATUS.GRACE_LIVE:
            return "Your service is in a payment grace period. Please update billing to avoid suspension.";
        case SERVICE_STATUS.SUSPENDED_FINAL_RECOVERY:
            return "Your service is suspended for nonpayment and may be recoverable for a limited time.";
        case SERVICE_STATUS.DELETED:
            return "This service has been closed.";
        case SERVICE_STATUS.INACTIVE:
        default:
            return "This service is not active yet.";
    }
}

function isReadyForCustomerAccess(purchase) {
    return Boolean(
        purchase?.status === PURCHASE_STATUS.COMPLETED &&
        purchase?.fulfillmentStatus === FULFILLMENT_STATUS.READY &&
        purchase?.serviceStatus === SERVICE_STATUS.ACTIVE &&
        purchase?.email &&
        purchase?.pelicanUsername &&
        config.pelican?.panelUrl
    );
}

function sanitizePurchaseForSnapshot(purchase) {
    if (!purchase) {
        return null;
    }

    const policy = getPurchasePolicyState(purchase);

    return {
        id: purchase.id,
        email: purchase.email || "",
        serverId: purchase.serverId || null,
        serverName: purchase.serverName || "",
        hostname: purchase.hostname || "",
        status: purchase.status || "",
        planType: purchase.planType || purchase.serverType || "",
        productCode: purchase.productCode || "",
        setupStatus: purchase.setupStatus || "",
        fulfillmentStatus: purchase.fulfillmentStatus || "",
        serviceStatus: purchase.serviceStatus || "",
        customerRiskStatus: purchase.customerRiskStatus || "",
        stripeCustomerPresent: Boolean(purchase.stripeCustomerId),
        stripeSubscriptionPresent: Boolean(purchase.stripeSubscriptionId),
        stripeSubscriptionStatus: purchase.stripeSubscriptionStatus || "",
        stripeCancelAtPeriodEnd: Number(purchase.stripeCancelAtPeriodEnd || 0) || null,
        stripeCurrentPeriodStart: Number(purchase.stripeCurrentPeriodStart || 0) || null,
        stripeCurrentPeriodEnd: Number(purchase.stripeCurrentPeriodEnd || 0) || null,
        pelicanUserLinked: Boolean(purchase.pelicanUserId),
        pelicanServerLinked: Boolean(purchase.pelicanServerId),
        pelicanUsername: purchase.pelicanUsername || "",
        pelicanServerIdentifier: purchase.pelicanServerIdentifier || "",
        routingGeneratedAt: Number(purchase.desiredRoutingArtifactGeneratedAt || 0) || null,
        routingVerifiedAt: Number(purchase.routingVerifiedAt || 0) || null,
        readyEmailQueuedAt: Number(purchase.readyEmailQueuedAt || 0) || null,
        completedAt: Number(purchase.completedAt || 0) || null,
        paidAt: Number(purchase.paidAt || 0) || null,
        createdAt: Number(purchase.createdAt || 0) || null,
        updatedAt: Number(purchase.updatedAt || 0) || null,
        policy: {
            inGracePeriod: Boolean(policy.inGracePeriod),
            suspensionRequired: Boolean(policy.suspensionRequired),
            purgeRequired: Boolean(policy.purgeRequired),
            gracePeriodEndsAt: policy.gracePeriodEndsAt || null,
            purgeEligibleAt: policy.purgeEligibleAt || null
        },
        publicState: {
            setup: publicSetupStatusText(purchase),
            fulfillment: publicFulfillmentStatusText(purchase),
            service: publicServiceStatusText(purchase)
        }
    };
}

async function getRecentEmailOutboxEntries(purchaseId) {
    if (!purchaseId) {
        return [];
    }

    const rows = await allQuery(
        `SELECT id, kind, state, recipientEmail, subject, attempts, createdAt, updatedAt, sentAt, lastError
         FROM emailOutbox
         WHERE purchaseId = ?
         ORDER BY createdAt DESC, id DESC
         LIMIT 5`,
        [purchaseId]
    );

    return rows.map(row => ({
        ...row,
        lastError: row.lastError ? "redacted" : null
    }));
}

async function loadSetupTokenSupportContext(setupToken) {
    if (!isOpaqueToken(setupToken)) {
        return {
            verified: false,
            reason: "missing_verified_context"
        };
    }

    const purchase = await getQuery(
        `SELECT
            p.*,
            s.status AS serverStatus,
            s.type AS serverType,
            s.price AS serverPrice,
            COALESCE(p.planType, s.type) AS planType
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.setupToken = ?
         ORDER BY p.id DESC
         LIMIT 1`,
        [setupToken]
    );

    if (!purchase) {
        return {
            verified: false,
            reason: "unknown_verified_context"
        };
    }

    if (
        purchase.setupTokenExpiresAt &&
        Number(purchase.setupTokenExpiresAt) < Date.now()
    ) {
        return {
            verified: false,
            reason: "expired_verified_context"
        };
    }

    const snapshot = sanitizePurchaseForSnapshot(purchase);
    const recentEmailOutbox = await getRecentEmailOutboxEntries(purchase.id);
    const readyAccess = isReadyForCustomerAccess(purchase)
        ? {
            available: true,
            panelUrl: config.pelican.panelUrl,
            hostname: purchase.hostname || "",
            username: purchase.pelicanUsername || ""
        }
        : {
            available: false,
            panelUrl: "",
            hostname: "",
            username: ""
        };

    return {
        verified: true,
        purchase,
        purchaseId: purchase.id,
        email: purchase.email || "",
        snapshot: {
            purchase: snapshot,
            recentEmailOutbox,
            diagnostics: {
                available: false,
                message: "Diagnostics are not available yet."
            }
        },
        publicContext: {
            verified: true,
            purchaseId: purchase.id,
            email: purchase.email || "",
            serverName: purchase.serverName || "",
            hostname: purchase.hostname || "",
            planType: snapshot.planType,
            billingPortalAvailable: Boolean(
                config.stripeBillingPortalConfigurationId &&
                purchase.stripeCustomerId &&
                (
                    purchase.status === PURCHASE_STATUS.PAID ||
                    purchase.status === PURCHASE_STATUS.COMPLETED
                )
            ),
            readyAccess,
            state: snapshot.publicState
        }
    };
}

async function buildVerifiedSupportContextForPurchase(purchase) {
    const snapshot = sanitizePurchaseForSnapshot(purchase);
    const recentEmailOutbox = await getRecentEmailOutboxEntries(purchase.id);
    const readyAccess = isReadyForCustomerAccess(purchase)
        ? {
            available: true,
            panelUrl: config.pelican.panelUrl,
            hostname: purchase.hostname || "",
            username: purchase.pelicanUsername || ""
        }
        : {
            available: false,
            panelUrl: "",
            hostname: "",
            username: ""
        };

    return {
        verified: true,
        purchase,
        purchaseId: purchase.id,
        email: purchase.email || "",
        snapshot: {
            purchase: snapshot,
            recentEmailOutbox,
            diagnostics: {
                available: false,
                message: "Diagnostics are not available yet."
            }
        },
        publicContext: {
            verified: true,
            purchaseId: purchase.id,
            email: purchase.email || "",
            serverName: purchase.serverName || "",
            hostname: purchase.hostname || "",
            planType: snapshot.planType,
            billingPortalAvailable: Boolean(
                config.stripeBillingPortalConfigurationId &&
                purchase.stripeCustomerId &&
                (
                    purchase.status === PURCHASE_STATUS.PAID ||
                    purchase.status === PURCHASE_STATUS.COMPLETED
                )
            ),
            readyAccess,
            state: snapshot.publicState
        }
    };
}

async function loadVerifiedSupportContext(req) {
    const setupToken = getSetupTokenFromRequest(req);
    const accessToken = getServiceAccessTokenFromRequest(req);
    let setupFailure = null;

    if (isOpaqueToken(setupToken)) {
        const setupContext = await loadSetupTokenSupportContext(setupToken);

        if (setupContext.verified) {
            return setupContext;
        }

        setupFailure = setupContext;
    }

    if (isOpaqueToken(accessToken)) {
        const accessContext = await verifyServiceAccessToken(accessToken);

        if (accessContext.verified) {
            return buildVerifiedSupportContextForPurchase(accessContext.purchase);
        }

        return accessContext;
    }

    return setupFailure || {
        verified: false,
        reason: "missing_verified_context"
    };
}

function buildSupportSnapshot(context) {
    return {
        capturedAt: Date.now(),
        verified: Boolean(context?.verified),
        purchase: context?.snapshot?.purchase || null,
        recentEmailOutbox: context?.snapshot?.recentEmailOutbox || [],
        diagnostics: context?.snapshot?.diagnostics || {
            available: false,
            message: "Diagnostics are not available yet."
        }
    };
}

module.exports = {
    buildSupportSnapshot,
    getServiceAccessTokenFromRequest,
    getSetupTokenFromRequest,
    isReadyForCustomerAccess,
    loadVerifiedSupportContext,
    publicFulfillmentStatusText,
    publicServiceStatusText,
    publicSetupStatusText,
    sanitizePurchaseForSnapshot,
    parseJson
};
