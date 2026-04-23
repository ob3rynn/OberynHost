const config = require("../config");
const { getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");

const EMAIL_OUTBOX_STATE = {
    QUEUED: "queued",
    SENDING: "sending",
    SENT: "sent",
    FAILED: "failed"
};

const EMAIL_KIND = {
    READY_ACCESS: "ready_access"
};

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

async function leaseNextEmailOutboxMessage(options = {}) {
    const now = Number(options.now || Date.now());

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const message = await getQuery(
            `SELECT *
             FROM emailOutbox
             WHERE state = ?
               AND availableAt <= ?
             ORDER BY availableAt ASC, id ASC
             LIMIT 1`,
            [
                EMAIL_OUTBOX_STATE.QUEUED,
                now
            ]
        );

        if (!message) {
            await rollbackTransaction();
            return null;
        }

        const updateResult = await runQuery(
            `UPDATE emailOutbox
             SET state = ?,
                 updatedAt = ?,
                 lastError = NULL
             WHERE id = ?
               AND state = ?`,
            [
                EMAIL_OUTBOX_STATE.SENDING,
                now,
                message.id,
                EMAIL_OUTBOX_STATE.QUEUED
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
             lastError = NULL
         WHERE id = ?
           AND state = ?`,
        [
            EMAIL_OUTBOX_STATE.SENT,
            now,
            now,
            message.id,
            EMAIL_OUTBOX_STATE.SENDING
        ]
    );

    return result.changes > 0;
}

async function markEmailOutboxFailed(message, error, details = {}) {
    const now = Number(details.now || Date.now());
    const lastError = String(error?.message || error || "Email delivery failed.")
        .trim()
        .slice(0, 2000);

    const result = await runQuery(
        `UPDATE emailOutbox
         SET state = ?,
             updatedAt = ?,
             lastError = ?
         WHERE id = ?
           AND state = ?`,
        [
            EMAIL_OUTBOX_STATE.FAILED,
            now,
            lastError || "Email delivery failed.",
            message.id,
            EMAIL_OUTBOX_STATE.SENDING
        ]
    );

    return result.changes > 0;
}

module.exports = {
    EMAIL_KIND,
    EMAIL_OUTBOX_STATE,
    buildReadyEmailIdempotencyKey,
    buildReadyEmailMessage,
    enqueueReadyEmailForPurchase,
    leaseNextEmailOutboxMessage,
    markEmailOutboxFailed,
    markEmailOutboxSent
};
