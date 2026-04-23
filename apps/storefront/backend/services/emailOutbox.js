const config = require("../config");
const { getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");
const { generateOpaqueToken } = require("../utils/tokens");

const EMAIL_OUTBOX_STATE = {
    QUEUED: "queued",
    SENDING: "sending",
    SENT: "sent",
    FAILED: "failed"
};

const EMAIL_KIND = {
    READY_ACCESS: "ready_access"
};

const DEFAULT_EMAIL_OUTBOX_LEASE_MS = 1000 * 60;
const DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS = 1000 * 60 * 5;
const DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS = 2;

function buildReadyEmailIdempotencyKey(purchaseId) {
    return `purchase:${purchaseId}:email:${EMAIL_KIND.READY_ACCESS}`;
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

function buildReadyEmailMessage(purchase) {
    const panelUrl = getPanelUrl();
    const recipientEmail = String(purchase?.email || "").trim();
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
        `Username: ${pelicanUsername}`
    ].filter(line => line !== "").join("\n");

    return {
        kind: EMAIL_KIND.READY_ACCESS,
        recipientEmail,
        senderEmail: config.outboundEmailFrom,
        subject,
        bodyText,
        payload: {
            kind: EMAIL_KIND.READY_ACCESS,
            panelUrl,
            pelicanUsername,
            hostname: String(purchase?.hostname || "").trim(),
            serverName,
            purchaseId: purchase.id
        }
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

function getExpiredLeaseFailureMessage() {
    return "Email send confirmation was lost after the delivery lease expired; automatic resend skipped to avoid duplicate customer mail.";
}

async function recoverExpiredEmailOutboxLeases(options = {}) {
    const now = Number(options.now || Date.now());
    const maxAttempts = Number(options.maxAttempts || DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS);

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
         WHERE state = ?
           AND leaseExpiresAt IS NOT NULL
           AND leaseExpiresAt < ?`,
        [
            EMAIL_OUTBOX_STATE.FAILED,
            maxAttempts,
            maxAttempts,
            now,
            now,
            getExpiredLeaseFailureMessage(),
            EMAIL_OUTBOX_STATE.SENDING,
            now
        ]
    );

    return Number(result.changes || 0);
}

async function leaseNextEmailOutboxMessage(options = {}) {
    const now = Number(options.now || Date.now());
    const leaseMs = Number(options.leaseMs || DEFAULT_EMAIL_OUTBOX_LEASE_MS);
    const maxAttempts = Number(options.maxAttempts || DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS);
    const leaseKey = generateOpaqueToken();
    const leaseExpiresAt = now + leaseMs;

    await recoverExpiredEmailOutboxLeases({
        now,
        maxAttempts
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

    const result = await runQuery(
        `UPDATE emailOutbox
         SET state = ?,
             updatedAt = ?,
             sentAt = ?,
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

    const result = await runQuery(
        `UPDATE emailOutbox
         SET state = ?,
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
            shouldRetry ? (now + retryDelayMs) : now,
            now,
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
    DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS,
    EMAIL_KIND,
    EMAIL_OUTBOX_STATE,
    buildReadyEmailIdempotencyKey,
    buildReadyEmailMessage,
    enqueueReadyEmailForPurchase,
    leaseNextEmailOutboxMessage,
    recoverExpiredEmailOutboxLeases,
    markEmailOutboxFailed,
    markEmailOutboxSent
};
