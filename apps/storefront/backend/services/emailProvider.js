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
    }
}

function buildPostmarkMetadata(message = {}) {
    const metadata = {
        kind: String(message.kind || "").trim(),
        purchaseId: message.purchaseId === undefined || message.purchaseId === null
            ? String(message?.payload?.purchaseId || "").trim()
            : String(message.purchaseId).trim(),
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
        throw new Error("Fetch is not available for Postmark email delivery.");
    }

    const serverToken = String(config.email?.postmarkServerToken || "").trim();

    if (!serverToken) {
        throw new Error("POSTMARK_SERVER_TOKEN is required when EMAIL_PROVIDER=postmark.");
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

    const response = await fetchImpl("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": serverToken
        },
        body: JSON.stringify(payload)
    });

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
                providerMessageId
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
                providerMessageId
            }
        );
    }

    return {
        provider: EMAIL_PROVIDER.POSTMARK,
        providerMessageId,
        statusCode: response.status
    };
}

async function sendEmailMessage(message, options = {}) {
    const provider = String(options.provider || config.email?.provider || EMAIL_PROVIDER.LOG).trim().toLowerCase();

    switch (provider) {
        case EMAIL_PROVIDER.LOG:
            return sendWithLogProvider(message, options);
        case EMAIL_PROVIDER.POSTMARK:
            return sendWithPostmark(message, options);
        default:
            throw new Error(`Unsupported email provider: ${provider}`);
    }
}

module.exports = {
    EMAIL_PROVIDER,
    EmailDeliveryError,
    sendEmailMessage
};
