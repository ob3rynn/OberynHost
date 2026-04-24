const express = require("express");

const requireAdmin = require("../../middleware/auth");
const config = require("../../config");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { PURCHASE_STATUS, SERVER_STATUS, SETUP_STATUS, FULFILLMENT_STATUS } = require("../../constants/status");
const { createStripeClient } = require("../../lib/stripeClient");
const { createAdminSession, destroyAdminSession } = require("../../services/adminSessions");
const { markPurchasePaid, expirePurchase } = require("../../services/purchases");
const { enqueueReadyEmailForPurchase } = require("../../services/emailOutbox");
const {
    buildProvisioningIdempotencyKey,
    buildProvisioningPayload,
    FULFILLMENT_QUEUE_STATE,
    FULFILLMENT_TASK_TYPE
} = require("../../services/fulfillmentQueue");
const { PAID_SETUP_ADMIN_ESCALATION_DELAY_MS } = require("../../services/lifecycleEnforcement");
const { clearCookie, parseCookies, serializeCookie } = require("../../utils/cookies");
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

function serializePurchase(purchase, stripeState = null, auditLog = []) {
    const purchaseWithLifecycle = mergeLifecycleState(purchase);

    return {
        ...purchaseWithLifecycle,
        auditLog: auditLog.map(entry => ({
            ...entry,
            details: parseAuditDetails(entry.detailsJson)
        })),
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

async function loadSerializedPurchase(purchaseId, stripeState = null) {
    const purchase = await getPurchaseRecord(purchaseId);

    if (!purchase) {
        return null;
    }

    const auditMap = await getAuditLogMap([purchaseId]);
    return serializePurchase(purchase, stripeState, auditMap.get(purchaseId) || []);
}

async function recordAdminAction(req, purchaseId, actionType, note = "", details = null) {
    await runQuery(
        `INSERT INTO adminAuditLog
            (purchaseId, actionType, note, detailsJson, userAgent, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            purchaseId,
            actionType,
            note || "",
            details ? JSON.stringify(details) : null,
            req.headers["user-agent"] || "",
            Date.now()
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

        res.json(
            purchases.map(purchase => serializePurchase(
                purchase,
                null,
                auditMap.get(purchase.id) || []
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
