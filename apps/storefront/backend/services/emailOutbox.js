const config = require("../config");
const { allQuery, getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");
const { assertEmailHeaderSafe } = require("../utils/emailSafety");
const { generateOpaqueToken } = require("../utils/tokens");
const {
    SERVICE_ACCESS_LINK_PLACEHOLDER,
    materializeServiceAccessLinkForEmail
} = require("./serviceAccessLinks");

const EMAIL_OUTBOX_STATE = {
    QUEUED: "queued",
    SENDING: "sending",
    SENT: "sent",
    FAILED: "failed"
};

const EMAIL_KIND = {
    READY_ACCESS: "ready_access",
    READY_ACCESS_RESEND: "ready_access_resend",
    SERVICE_ACCESS_LINK: "service_access_link",
    SETUP_REMINDER: "setup_reminder",
    SUPPORT_TICKET_RECEIVED: "support_ticket_received",
    SUPPORT_TICKET_ADMIN_REPLY: "support_ticket_admin_reply",
    SUPPORT_TICKET_RESOLVED: "support_ticket_resolved",
    SUPPORT_TICKET_WAITING_ON_CUSTOMER: "support_ticket_waiting_on_customer",
    SUSPENSION_DELETE_WARNING_72H: "suspension_delete_warning_72h",
    SUSPENSION_DELETE_WARNING_48H: "suspension_delete_warning_48h",
    SUSPENSION_DELETE_WARNING_24H: "suspension_delete_warning_24h"
};

const SUSPENSION_DELETE_WARNING_CONFIG = {
    [EMAIL_KIND.SUSPENSION_DELETE_WARNING_72H]: {
        label: "72 hours",
        hoursRemaining: 72
    },
    [EMAIL_KIND.SUSPENSION_DELETE_WARNING_48H]: {
        label: "48 hours",
        hoursRemaining: 48
    },
    [EMAIL_KIND.SUSPENSION_DELETE_WARNING_24H]: {
        label: "24 hours",
        hoursRemaining: 24
    }
};

const DEFAULT_EMAIL_OUTBOX_LEASE_MS = 1000 * 60;
const DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS = 1000 * 60 * 5;
const DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS = 2;
const DEFAULT_EMAIL_OUTBOX_RECOVERY_LIMIT = 25;

function buildReadyEmailIdempotencyKey(purchaseId) {
    return `purchase:${purchaseId}:email:${EMAIL_KIND.READY_ACCESS}`;
}

function buildSetupReminderIdempotencyKey(purchaseId) {
    return `purchase:${purchaseId}:email:${EMAIL_KIND.SETUP_REMINDER}`;
}

function buildReadyEmailResendIdempotencyKey(purchaseId, now = Date.now()) {
    const hourBucket = Math.floor(Number(now || Date.now()) / (1000 * 60 * 60));
    return `purchase:${purchaseId}:email:${EMAIL_KIND.READY_ACCESS_RESEND}:${hourBucket}`;
}

function buildServiceAccessEmailIdempotencyKey(purchaseId, now = Date.now()) {
    const dayBucket = Math.floor(Number(now || Date.now()) / (1000 * 60 * 60 * 24));
    return `purchase:${purchaseId}:email:${EMAIL_KIND.SERVICE_ACCESS_LINK}:${dayBucket}`;
}

function buildSuspensionDeleteWarningIdempotencyKey(purchaseId, kind) {
    return `purchase:${purchaseId}:email:${kind}`;
}

function buildSupportEmailIdempotencyKey(ticketRef, kind, suffix = "") {
    return `support:${ticketRef}:email:${kind}${suffix ? `:${suffix}` : ""}`;
}

function parsePayloadJson(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function normalizeEmailOutboxRow(row) {
    if (!row) {
        return null;
    }

    return {
        ...row,
        attempts: Number(row.attempts || 0),
        payload: parsePayloadJson(row.payloadJson)
    };
}

function getPanelUrl() {
    return String(config.pelican?.panelUrl || "").trim();
}

function getSafeSenderEmail() {
    return assertEmailHeaderSafe(config.outboundEmailFrom, "Sender email");
}

function buildSetupReminderUrl(purchase) {
    const baseUrl = String(config.baseUrl || "").trim();
    const stripeSessionId = String(purchase?.stripeSessionId || "").trim();

    if (!baseUrl) {
        throw new Error("Base URL is required before queueing a setup reminder email.");
    }

    if (stripeSessionId) {
        return `${baseUrl}/success?session_id=${encodeURIComponent(stripeSessionId)}`;
    }

    return `${baseUrl}/success`;
}

function serviceAccessLinkCopyLines() {
    return [
        "",
        "Private service access link:",
        SERVICE_ACCESS_LINK_PLACEHOLDER,
        "",
        "Save this email or bookmark your private service link. This link lets you access support, billing help, service status, and ready-access options for this server without creating an account.",
        "For security, this link refreshes each billing cycle. Use the newest OberynHost billing/service email if an older link stops working.",
        "Do not share this link publicly. Anyone with it may be able to access support options for this service."
    ];
}

function buildReadyEmailMessage(purchase) {
    const panelUrl = getPanelUrl();
    const recipientEmail = assertEmailHeaderSafe(purchase?.email, "Customer email");
    const pelicanUsername = String(purchase?.pelicanUsername || "").trim();
    const serverName = String(purchase?.serverName || "your server").trim();

    if (!panelUrl) {
        throw new Error("Pelican panel URL is required before queueing a ready email.");
    }

    if (!recipientEmail) {
        throw new Error("Customer email is required before queueing a ready email.");
    }

    if (!pelicanUsername) {
        throw new Error("Pelican username is required before queueing a ready email.");
    }

    const subject = `Your OberynHost server is ready: ${serverName}`;
    const bodyText = [
        "Your OberynHost Minecraft server is ready.",
        "",
        `Panel URL: ${panelUrl}`,
        `Username: ${pelicanUsername}`,
        ...serviceAccessLinkCopyLines()
    ].filter(line => line !== "").join("\n");

    return {
        kind: EMAIL_KIND.READY_ACCESS,
        recipientEmail,
        senderEmail: getSafeSenderEmail(),
        subject,
        bodyText,
        payload: {
            kind: EMAIL_KIND.READY_ACCESS,
            panelUrl,
            pelicanUsername,
            hostname: String(purchase?.hostname || "").trim(),
            serverName,
            purchaseId: purchase.id,
            serviceAccessLinkIncluded: true
        }
    };
}

function buildReadyEmailResendMessage(purchase) {
    const message = buildReadyEmailMessage(purchase);

    return {
        ...message,
        kind: EMAIL_KIND.READY_ACCESS_RESEND,
        subject: `OberynHost panel access resend: ${String(purchase?.serverName || "your server").trim() || "your server"}`,
        payload: {
            ...message.payload,
            kind: EMAIL_KIND.READY_ACCESS_RESEND,
            resend: true
        }
    };
}

function buildSetupReminderEmailMessage(purchase) {
    const recipientEmail = assertEmailHeaderSafe(purchase?.email, "Customer email");
    const setupUrl = buildSetupReminderUrl(purchase);
    const serverLabel = String(purchase?.planType || purchase?.serverType || "server").trim() || "server";

    if (!recipientEmail) {
        throw new Error("Customer email is required before queueing a setup reminder.");
    }

    const subject = `Finish your OberynHost ${serverLabel} setup`;
    const bodyText = [
        "Your payment has been verified, but server setup is still waiting on your details.",
        "",
        "Open this link to finish setup:",
        setupUrl,
        ...serviceAccessLinkCopyLines()
    ].join("\n");

    return {
        kind: EMAIL_KIND.SETUP_REMINDER,
        recipientEmail,
        senderEmail: getSafeSenderEmail(),
        subject,
        bodyText,
        payload: {
            kind: EMAIL_KIND.SETUP_REMINDER,
            setupUrl,
            purchaseId: purchase.id,
            stripeSessionId: String(purchase?.stripeSessionId || "").trim(),
            email: recipientEmail,
            serviceAccessLinkIncluded: true
        }
    };
}

function buildServiceAccessLinkEmailMessage(purchase) {
    const recipientEmail = assertEmailHeaderSafe(purchase?.email, "Customer email");
    const serverName = String(purchase?.serverName || "your server").trim();

    if (!recipientEmail) {
        throw new Error("Customer email is required before queueing a service access email.");
    }

    const subject = `Your OberynHost private service link: ${serverName}`;
    const bodyText = [
        `Here is the current private service access link for ${serverName}.`,
        ...serviceAccessLinkCopyLines()
    ].join("\n");

    return {
        kind: EMAIL_KIND.SERVICE_ACCESS_LINK,
        recipientEmail,
        senderEmail: getSafeSenderEmail(),
        subject,
        bodyText,
        payload: {
            kind: EMAIL_KIND.SERVICE_ACCESS_LINK,
            purchaseId: purchase.id,
            serverName,
            serviceAccessLinkIncluded: true
        }
    };
}

function buildSuspensionDeleteWarningEmailMessage(purchase, kind) {
    const warning = SUSPENSION_DELETE_WARNING_CONFIG[kind];
    const recipientEmail = assertEmailHeaderSafe(purchase?.email, "Customer email");
    const serverName = String(purchase?.serverName || "your server").trim();
    const purgeEligibleAt = Number(purchase?.purgeEligibleAt || 0) || null;

    if (!warning) {
        throw new Error(`Unsupported suspension warning email kind: ${kind}`);
    }

    if (!recipientEmail) {
        throw new Error("Customer email is required before queueing a suspension warning.");
    }

    const deadlineText = purgeEligibleAt
        ? new Date(purgeEligibleAt).toISOString()
        : "the scheduled deletion deadline";
    const subject = `Action required: ${serverName} deletion in ${warning.label}`;
    const bodyText = [
        `Your OberynHost server "${serverName}" is still suspended for nonpayment.`,
        "",
        `If payment is not restored, this server becomes eligible for deletion in ${warning.label}.`,
        `Deletion eligibility time: ${deadlineText}`,
        "",
        "Please update payment or contact support@oberynn.com if you need help recovering the service."
    ].join("\n");

    return {
        kind,
        recipientEmail,
        senderEmail: getSafeSenderEmail(),
        subject,
        bodyText,
        payload: {
            kind,
            purchaseId: purchase.id,
            serverName,
            hoursRemaining: warning.hoursRemaining,
            purgeEligibleAt,
            email: recipientEmail
        }
    };
}

function buildSupportTicketReceivedMessage(ticket, recommendation) {
    const recipientEmail = assertEmailHeaderSafe(ticket?.email, "Customer email");
    const publicRef = String(ticket?.publicRef || "").trim();
    const categoryLabel = recommendation?.categoryLabel || ticket?.category || "support";
    const guidance = String(recommendation?.customerGuidance || "").trim();

    if (!recipientEmail) {
        throw new Error("Customer email is required before queueing a support acknowledgment.");
    }

    if (!publicRef) {
        throw new Error("Ticket reference is required before queueing a support acknowledgment.");
    }

    const bodyText = [
        `We received your OberynHost support request ${publicRef}.`,
        "",
        `Category: ${categoryLabel}`,
        "",
        guidance || "A founder will review the request with the verified service context.",
        ...serviceAccessLinkCopyLines(),
        "",
        "OberynHost support covers hosting, billing, panel access, provisioning, routing, allocation, and platform issues. Minecraft plugins, gameplay, moderation, custom configs, and server administration are self-managed unless OberynHost explicitly provides that service."
    ].join("\n");

    return {
        kind: EMAIL_KIND.SUPPORT_TICKET_RECEIVED,
        recipientEmail,
        senderEmail: getSafeSenderEmail(),
        subject: `We received your OberynHost support request ${publicRef}`,
        bodyText,
        payload: {
            kind: EMAIL_KIND.SUPPORT_TICKET_RECEIVED,
            ticketId: ticket.id,
            publicRef,
            category: ticket.category,
            status: ticket.status,
            macroId: recommendation?.macroId || "",
            serviceAccessLinkIncluded: true
        }
    };
}

async function materializeServiceAccessLinkPlaceholders(message) {
    if (!message?.bodyText || !message.bodyText.includes(SERVICE_ACCESS_LINK_PLACEHOLDER)) {
        return message;
    }

    const purchaseId = Number(message.purchaseId || message.payload?.purchaseId || 0);
    const serviceAccessUrl = await materializeServiceAccessLinkForEmail(purchaseId);
    const replacement = serviceAccessUrl || "If you cannot access your private service link, email support@oberynn.com for purchase-access recovery.";

    return {
        ...message,
        bodyText: message.bodyText.split(SERVICE_ACCESS_LINK_PLACEHOLDER).join(replacement)
    };
}

function buildSupportAdminReplyMessage(ticket, body, kind = EMAIL_KIND.SUPPORT_TICKET_ADMIN_REPLY) {
    const recipientEmail = assertEmailHeaderSafe(ticket?.email, "Customer email");
    const publicRef = String(ticket?.publicRef || "").trim();
    const replyBody = String(body || "").trim();

    if (!recipientEmail) {
        throw new Error("Customer email is required before queueing a support reply.");
    }

    if (!publicRef) {
        throw new Error("Ticket reference is required before queueing a support reply.");
    }

    if (!replyBody) {
        throw new Error("Reply body is required before queueing a support reply.");
    }

    return {
        kind,
        recipientEmail,
        senderEmail: getSafeSenderEmail(),
        subject: `OberynHost support update ${publicRef}`,
        bodyText: [
            `Support request: ${publicRef}`,
            "",
            replyBody
        ].join("\n"),
        payload: {
            kind,
            ticketId: ticket.id,
            publicRef,
            status: ticket.status
        }
    };
}

async function enqueueEmailMessage(message, idempotencyKey, options = {}) {
    const now = Number(options.now || Date.now());

    await runQuery(
        `INSERT INTO emailOutbox
            (
                purchaseId,
                kind,
                state,
                idempotencyKey,
                recipientEmail,
                senderEmail,
                subject,
                bodyText,
                payloadJson,
                availableAt,
                createdAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotencyKey) DO NOTHING`,
        [
            options.purchaseId || null,
            message.kind,
            EMAIL_OUTBOX_STATE.QUEUED,
            idempotencyKey,
            message.recipientEmail,
            message.senderEmail,
            message.subject,
            message.bodyText,
            JSON.stringify(message.payload),
            now,
            now,
            now
        ]
    );

    return {
        ...message,
        idempotencyKey
    };
}

async function enqueueReadyEmailForPurchase(purchase, options = {}) {
    const now = Number(options.now || Date.now());
    const message = buildReadyEmailMessage(purchase);
    const idempotencyKey = buildReadyEmailIdempotencyKey(purchase.id);

    await runQuery(
        `INSERT INTO emailOutbox
            (
                purchaseId,
                kind,
                state,
                idempotencyKey,
                recipientEmail,
                senderEmail,
                subject,
                bodyText,
                payloadJson,
                availableAt,
                createdAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotencyKey) DO NOTHING`,
        [
            purchase.id,
            message.kind,
            EMAIL_OUTBOX_STATE.QUEUED,
            idempotencyKey,
            message.recipientEmail,
            message.senderEmail,
            message.subject,
            message.bodyText,
            JSON.stringify(message.payload),
            now,
            now,
            now
        ]
    );

    return {
        ...message,
        idempotencyKey
    };
}

async function enqueueReadyEmailResendForPurchase(purchase, options = {}) {
    const now = Number(options.now || Date.now());
    const message = buildReadyEmailResendMessage(purchase);
    const idempotencyKey = buildReadyEmailResendIdempotencyKey(purchase.id, now);

    return enqueueEmailMessage(message, idempotencyKey, {
        ...options,
        now,
        purchaseId: purchase.id
    });
}

async function enqueueSetupReminderEmailForPurchase(purchase, options = {}) {
    const now = Number(options.now || Date.now());
    const message = buildSetupReminderEmailMessage(purchase);
    const idempotencyKey = buildSetupReminderIdempotencyKey(purchase.id);

    await runQuery(
        `INSERT INTO emailOutbox
            (
                purchaseId,
                kind,
                state,
                idempotencyKey,
                recipientEmail,
                senderEmail,
                subject,
                bodyText,
                payloadJson,
                availableAt,
                createdAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotencyKey) DO NOTHING`,
        [
            purchase.id,
            message.kind,
            EMAIL_OUTBOX_STATE.QUEUED,
            idempotencyKey,
            message.recipientEmail,
            message.senderEmail,
            message.subject,
            message.bodyText,
            JSON.stringify(message.payload),
            now,
            now,
            now
        ]
    );

    return {
        ...message,
        idempotencyKey
    };
}

async function enqueueServiceAccessLinkEmailForPurchase(purchase, options = {}) {
    const now = Number(options.now || Date.now());
    const message = buildServiceAccessLinkEmailMessage(purchase);
    const idempotencyKey = buildServiceAccessEmailIdempotencyKey(purchase.id, now);

    return enqueueEmailMessage(message, idempotencyKey, {
        ...options,
        now,
        purchaseId: purchase.id
    });
}

async function enqueueSuspensionDeleteWarningEmailForPurchase(purchase, kind, options = {}) {
    const now = Number(options.now || Date.now());
    const message = buildSuspensionDeleteWarningEmailMessage(purchase, kind);
    const idempotencyKey = buildSuspensionDeleteWarningIdempotencyKey(purchase.id, kind);

    await runQuery(
        `INSERT INTO emailOutbox
            (
                purchaseId,
                kind,
                state,
                idempotencyKey,
                recipientEmail,
                senderEmail,
                subject,
                bodyText,
                payloadJson,
                availableAt,
                createdAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotencyKey) DO NOTHING`,
        [
            purchase.id,
            message.kind,
            EMAIL_OUTBOX_STATE.QUEUED,
            idempotencyKey,
            message.recipientEmail,
            message.senderEmail,
            message.subject,
            message.bodyText,
            JSON.stringify(message.payload),
            now,
            now,
            now
        ]
    );

    return {
        ...message,
        idempotencyKey
    };
}

async function enqueueSupportTicketReceivedEmail(ticket, recommendation, options = {}) {
    const message = buildSupportTicketReceivedMessage(ticket, recommendation);
    const idempotencyKey = buildSupportEmailIdempotencyKey(
        ticket.publicRef,
        EMAIL_KIND.SUPPORT_TICKET_RECEIVED
    );

    return enqueueEmailMessage(message, idempotencyKey, {
        ...options,
        purchaseId: ticket.purchaseId || null
    });
}

async function enqueueSupportTicketAdminReplyEmail(ticket, body, options = {}) {
    const now = Number(options.now || Date.now());
    const kind = options.kind || EMAIL_KIND.SUPPORT_TICKET_ADMIN_REPLY;
    const message = buildSupportAdminReplyMessage(ticket, body, kind);
    const idempotencyKey = buildSupportEmailIdempotencyKey(
        ticket.publicRef,
        kind,
        String(now)
    );

    return enqueueEmailMessage(message, idempotencyKey, {
        ...options,
        now,
        purchaseId: ticket.purchaseId || null
    });
}

function getExpiredLeaseFailureMessage() {
    return "Email send confirmation was lost after the delivery lease expired; automatic resend skipped to avoid duplicate customer mail.";
}

async function recoverExpiredEmailOutboxLeases(options = {}) {
    const now = Number(options.now || Date.now());
    const maxAttempts = Number(options.maxAttempts || DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS);
    const limit = Number(options.limit || DEFAULT_EMAIL_OUTBOX_RECOVERY_LIMIT);
    const reconcileDelivery = typeof options.reconcileDelivery === "function"
        ? options.reconcileDelivery
        : null;

    const expiredMessages = await allQuery(
        `SELECT *
         FROM emailOutbox
         WHERE state = ?
           AND leaseExpiresAt IS NOT NULL
           AND leaseExpiresAt < ?
         ORDER BY leaseExpiresAt ASC, id ASC
         LIMIT ?`,
        [
            EMAIL_OUTBOX_STATE.SENDING,
            now,
            limit
        ]
    );

    let recovered = 0;

    for (const row of expiredMessages) {
        const message = normalizeEmailOutboxRow(row);

        if (reconcileDelivery) {
            let deliveryResult = null;

            try {
                deliveryResult = await reconcileDelivery(message);
            } catch {
                deliveryResult = null;
            }

            if (deliveryResult?.providerMessageId) {
                const markedSent = await markEmailOutboxSent(message, {
                    now,
                    deliveryResult
                });

                if (markedSent) {
                    recovered += 1;
                    continue;
                }
            }
        }

        const result = await runQuery(
            `UPDATE emailOutbox
             SET state = ?,
                 attempts = CASE
                     WHEN COALESCE(attempts, 0) < ? THEN ?
                     ELSE COALESCE(attempts, 0)
                 END,
                 availableAt = ?,
                 updatedAt = ?,
                 lastError = ?,
                 lockedAt = NULL,
                 leaseKey = NULL,
                 leaseExpiresAt = NULL
             WHERE id = ?
               AND state = ?
               AND leaseKey = ?`,
            [
                EMAIL_OUTBOX_STATE.FAILED,
                maxAttempts,
                maxAttempts,
                now,
                now,
                getExpiredLeaseFailureMessage(),
                message.id,
                EMAIL_OUTBOX_STATE.SENDING,
                message.leaseKey
            ]
        );

        recovered += Number(result.changes || 0);
    }

    return recovered;
}

async function leaseNextEmailOutboxMessage(options = {}) {
    const now = Number(options.now || Date.now());
    const leaseMs = Number(options.leaseMs || DEFAULT_EMAIL_OUTBOX_LEASE_MS);
    const maxAttempts = Number(options.maxAttempts || DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS);
    const leaseKey = generateOpaqueToken();
    const leaseExpiresAt = now + leaseMs;

    await recoverExpiredEmailOutboxLeases({
        now,
        maxAttempts,
        reconcileDelivery: options.reconcileDelivery
    });

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const message = await getQuery(
            `SELECT *
             FROM emailOutbox
             WHERE availableAt <= ?
               AND (
                    state = ?
                    OR (
                        state = ?
                        AND COALESCE(attempts, 0) < ?
                    )
               )
             ORDER BY availableAt ASC, id ASC
             LIMIT 1`,
            [
                now,
                EMAIL_OUTBOX_STATE.QUEUED,
                EMAIL_OUTBOX_STATE.FAILED,
                maxAttempts
            ]
        );

        if (!message) {
            await rollbackTransaction();
            return null;
        }

        const updateResult = await runQuery(
            `UPDATE emailOutbox
             SET state = ?,
                 lockedAt = ?,
                 attempts = COALESCE(attempts, 0) + 1,
                 leaseKey = ?,
                 leaseExpiresAt = ?,
                 updatedAt = ?,
                 lastError = NULL
             WHERE id = ?
               AND state = ?`,
            [
                EMAIL_OUTBOX_STATE.SENDING,
                now,
                leaseKey,
                leaseExpiresAt,
                now,
                message.id,
                message.state
            ]
        );

        if (updateResult.changes === 0) {
            await rollbackTransaction();
            return null;
        }

        await runQuery("COMMIT");

        return normalizeEmailOutboxRow({
            ...message,
            state: EMAIL_OUTBOX_STATE.SENDING,
            lockedAt: now,
            attempts: Number(message.attempts || 0) + 1,
            leaseKey,
            leaseExpiresAt,
            updatedAt: now,
            lastError: null
        });
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
}

async function markEmailOutboxSent(message, details = {}) {
    const now = Number(details.now || Date.now());
    const deliveryResult = details.deliveryResult || {};
    const provider = String(deliveryResult.provider || "").trim();
    const providerMessageId = String(deliveryResult.providerMessageId || "").trim();
    const providerStatusCode = Number(deliveryResult.statusCode || 0) || null;

    const result = await runQuery(
        `UPDATE emailOutbox
         SET state = ?,
             updatedAt = ?,
             sentAt = ?,
             provider = ?,
             providerMessageId = ?,
             providerStatusCode = ?,
             providerErrorCode = NULL,
             lastError = NULL,
             lockedAt = NULL,
             leaseKey = NULL,
             leaseExpiresAt = NULL
         WHERE id = ?
           AND state = ?
           AND leaseKey = ?`,
        [
            EMAIL_OUTBOX_STATE.SENT,
            now,
            now,
            provider || null,
            providerMessageId || null,
            providerStatusCode,
            message.id,
            EMAIL_OUTBOX_STATE.SENDING,
            message.leaseKey
        ]
    );

    return result.changes > 0;
}

async function markEmailOutboxFailed(message, error, details = {}) {
    const now = Number(details.now || Date.now());
    const retryDelayMs = Number(details.retryDelayMs || DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS);
    const maxAttempts = Number(details.maxAttempts || DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS);
    const retryable = details.retryable === true;
    const shouldRetry = retryable && Number(message.attempts || 0) < maxAttempts;
    const lastError = String(error?.message || error || "Email delivery failed.")
        .trim()
        .slice(0, 2000);
    const provider = String(error?.provider || "").trim();
    const providerMessageId = String(error?.providerMessageId || "").trim();
    const providerStatusCode = Number(error?.statusCode || 0) || null;
    const providerErrorCode = Number(error?.errorCode || 0) || null;

    const result = await runQuery(
        `UPDATE emailOutbox
         SET state = ?,
             availableAt = ?,
             updatedAt = ?,
             provider = COALESCE(?, provider),
             providerMessageId = COALESCE(?, providerMessageId),
             providerStatusCode = COALESCE(?, providerStatusCode),
             providerErrorCode = COALESCE(?, providerErrorCode),
             lastError = ?,
             lockedAt = NULL,
             leaseKey = NULL,
             leaseExpiresAt = NULL
         WHERE id = ?
           AND state = ?
           AND leaseKey = ?`,
        [
            EMAIL_OUTBOX_STATE.FAILED,
            shouldRetry ? (now + retryDelayMs) : now,
            now,
            provider || null,
            providerMessageId || null,
            providerStatusCode,
            providerErrorCode,
            lastError || "Email delivery failed.",
            message.id,
            EMAIL_OUTBOX_STATE.SENDING,
            message.leaseKey
        ]
    );

    return {
        updated: result.changes > 0,
        shouldRetry,
        nextAvailableAt: shouldRetry ? (now + retryDelayMs) : now
    };
}

module.exports = {
    DEFAULT_EMAIL_OUTBOX_LEASE_MS,
    DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS,
    DEFAULT_EMAIL_OUTBOX_RECOVERY_LIMIT,
    DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS,
    EMAIL_KIND,
    EMAIL_OUTBOX_STATE,
    SUSPENSION_DELETE_WARNING_CONFIG,
    buildReadyEmailIdempotencyKey,
    buildReadyEmailMessage,
    buildReadyEmailResendIdempotencyKey,
    buildReadyEmailResendMessage,
    buildServiceAccessEmailIdempotencyKey,
    buildServiceAccessLinkEmailMessage,
    buildSetupReminderEmailMessage,
    buildSetupReminderIdempotencyKey,
    buildSupportAdminReplyMessage,
    buildSupportEmailIdempotencyKey,
    buildSupportTicketReceivedMessage,
    buildSuspensionDeleteWarningEmailMessage,
    buildSuspensionDeleteWarningIdempotencyKey,
    enqueueReadyEmailForPurchase,
    enqueueReadyEmailResendForPurchase,
    enqueueServiceAccessLinkEmailForPurchase,
    enqueueSetupReminderEmailForPurchase,
    enqueueSupportTicketAdminReplyEmail,
    enqueueSupportTicketReceivedEmail,
    enqueueSuspensionDeleteWarningEmailForPurchase,
    leaseNextEmailOutboxMessage,
    materializeServiceAccessLinkPlaceholders,
    recoverExpiredEmailOutboxLeases,
    markEmailOutboxFailed,
    markEmailOutboxSent
};
