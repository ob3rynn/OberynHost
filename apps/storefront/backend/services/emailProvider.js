const config = require("../config");

const EMAIL_PROVIDER = {
    LOG: "log",
    POSTMARK: "postmark"
};

class EmailDeliveryError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "EmailDeliveryError";
        this.provider = options.provider || "";
        this.statusCode = Number(options.statusCode || 0) || null;
        this.errorCode = Number(options.errorCode || 0) || null;
        this.providerMessageId = String(options.providerMessageId || "").trim();
        this.retryable = options.retryable === true;
    }
}

function isRetryableEmailDeliveryError(err) {
    return Boolean(err && err.retryable === true);
}

function buildPostmarkMetadata(message = {}) {
    const metadata = {
        kind: String(message.kind || "").trim(),
        purchaseId: message.purchaseId === undefined || message.purchaseId === null
            ? String(message?.payload?.purchaseId || "").trim()
            : String(message.purchaseId).trim(),
        idempotencyKey: String(message.idempotencyKey || "").trim(),
        emailOutboxId: message.id === undefined || message.id === null
            ? ""
            : String(message.id).trim(),
        pelicanUsername: String(message?.payload?.pelicanUsername || "").trim(),
        hostname: String(message?.payload?.hostname || "").trim()
    };

    return Object.fromEntries(
        Object.entries(metadata).filter(([, value]) => value !== "")
    );
}

async function sendWithLogProvider(message) {
    console.info(
        "[email-outbox:log]",
        JSON.stringify({
            purchaseId: message.purchaseId || null,
            kind: message.kind,
            recipientEmail: message.recipientEmail,
            senderEmail: message.senderEmail,
            subject: message.subject,
            bodyText: message.bodyText,
            payload: message.payload || null
        })
    );

    return {
        provider: EMAIL_PROVIDER.LOG,
        providerMessageId: "",
        statusCode: 200
    };
}

async function sendWithPostmark(message, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;

    if (typeof fetchImpl !== "function") {
        throw new EmailDeliveryError("Fetch is not available for Postmark email delivery.", {
            provider: EMAIL_PROVIDER.POSTMARK,
            retryable: false
        });
    }

    const serverToken = String(config.email?.postmarkServerToken || "").trim();

    if (!serverToken) {
        throw new EmailDeliveryError("POSTMARK_SERVER_TOKEN is required when EMAIL_PROVIDER=postmark.", {
            provider: EMAIL_PROVIDER.POSTMARK,
            retryable: false
        });
    }

    const payload = {
        From: message.senderEmail,
        To: message.recipientEmail,
        Subject: message.subject,
        TextBody: message.bodyText,
        Tag: String(message.kind || "").trim() || undefined,
        Metadata: buildPostmarkMetadata(message),
        MessageStream: config.email?.postmarkMessageStream || "outbound"
    };

    let response;

    try {
        response = await fetchImpl("https://api.postmarkapp.com/email", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Postmark-Server-Token": serverToken
            },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        throw new EmailDeliveryError(
            `Postmark email delivery request failed before receiving a response: ${err.message || "unknown error"}`,
            {
                provider: EMAIL_PROVIDER.POSTMARK,
                retryable: true
            }
        );
    }

    const responseText = await response.text();
    let responseJson = null;

    if (responseText) {
        try {
            responseJson = JSON.parse(responseText);
        } catch {}
    }

    const providerMessageId = String(responseJson?.MessageID || "").trim();
    const errorCode = Number(responseJson?.ErrorCode || 0) || null;

    if (!response.ok) {
        throw new EmailDeliveryError(
            `Postmark email delivery failed with status ${response.status}.`,
            {
                provider: EMAIL_PROVIDER.POSTMARK,
                statusCode: response.status,
                errorCode,
                providerMessageId,
                retryable: response.status >= 500 || response.status === 429
            }
        );
    }

    if (errorCode && errorCode !== 0) {
        throw new EmailDeliveryError(
            `Postmark email delivery was rejected: ${responseJson?.Message || "unknown error"}`,
            {
                provider: EMAIL_PROVIDER.POSTMARK,
                statusCode: response.status,
                errorCode,
                providerMessageId,
                retryable: false
            }
        );
    }

    return {
        provider: EMAIL_PROVIDER.POSTMARK,
        providerMessageId,
        statusCode: response.status
    };
}

async function reconcilePostmarkAcceptedMessage(message, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;

    if (typeof fetchImpl !== "function") {
        return null;
    }

    const serverToken = String(config.email?.postmarkServerToken || "").trim();
    const idempotencyKey = String(message.idempotencyKey || "").trim();

    if (!serverToken || !idempotencyKey) {
        return null;
    }

    const searchParams = new URLSearchParams({
        count: "10",
        offset: "0",
        metadata_idempotencyKey: idempotencyKey,
        messagestream: config.email?.postmarkMessageStream || "outbound"
    });

    const response = await fetchImpl(`https://api.postmarkapp.com/messages/outbound?${searchParams.toString()}`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "X-Postmark-Server-Token": serverToken
        }
    });

    if (!response.ok) {
        return null;
    }

    let payload = null;

    try {
        payload = await response.json();
    } catch {
        return null;
    }

    const messages = Array.isArray(payload?.Messages)
        ? payload.Messages.filter(candidate =>
            String(candidate?.Metadata?.idempotencyKey || "").trim() === idempotencyKey
        )
        : [];

    if (messages.length !== 1) {
        return null;
    }

    return {
        provider: EMAIL_PROVIDER.POSTMARK,
        providerMessageId: String(messages[0].MessageID || "").trim(),
        statusCode: 200
    };
}

async function reconcileProviderAcceptedEmail(message, options = {}) {
    const provider = String(options.provider || config.email?.provider || EMAIL_PROVIDER.LOG).trim().toLowerCase();

    if (provider === EMAIL_PROVIDER.POSTMARK) {
        return reconcilePostmarkAcceptedMessage(message, options);
    }

    return null;
}

async function sendEmailMessage(message, options = {}) {
    const provider = String(options.provider || config.email?.provider || EMAIL_PROVIDER.LOG).trim().toLowerCase();

    switch (provider) {
        case EMAIL_PROVIDER.LOG:
            return sendWithLogProvider(message, options);
        case EMAIL_PROVIDER.POSTMARK:
            return sendWithPostmark(message, options);
        default:
            throw new EmailDeliveryError(`Unsupported email provider: ${provider}`, {
                provider,
                retryable: false
            });
    }
}

module.exports = {
    EMAIL_PROVIDER,
    EmailDeliveryError,
    isRetryableEmailDeliveryError,
    reconcileProviderAcceptedEmail,
    sendEmailMessage
};
