const config = require("../config");
const { runQuery } = require("../db/queries");

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

module.exports = {
    EMAIL_KIND,
    EMAIL_OUTBOX_STATE,
    buildReadyEmailIdempotencyKey,
    buildReadyEmailMessage,
    enqueueReadyEmailForPurchase
};
