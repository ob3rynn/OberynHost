function exitConfigError(message) {
    console.error(`Configuration error: ${message}`);
    process.exit(1);
}

function parseAbsoluteHttpUrl(name, value) {
    let parsed;

    try {
        parsed = new URL(value);
    } catch {
        exitConfigError(`${name} must be a valid absolute URL.`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        exitConfigError(`${name} must use http or https.`);
    }

    return parsed;
}

function parseAllowedOrigins(rawValue) {
    return rawValue
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean)
        .map(origin => parseAbsoluteHttpUrl("ALLOWED_ORIGINS", origin).origin);
}

const rawPort = (process.env.PORT || "3000").trim();
const port = Number(rawPort);
const host = (process.env.HOST || "0.0.0.0").trim();
const rawBaseUrl = (process.env.BASE_URL || "").trim();
const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || "").trim();
const adminKey = (process.env.ADMIN_KEY || "").trim();
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
const stripeApiVersion = (process.env.STRIPE_API_VERSION || "").trim();
const stripeWebhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const stripePriceIds = {
    "2GB": (process.env.STRIPE_PRICE_2GB || "").trim(),
    "4GB": (process.env.STRIPE_PRICE_4GB || "").trim()
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    exitConfigError("PORT must be an integer between 1 and 65535.");
}

if (!host) {
    exitConfigError("HOST must not be empty.");
}

const missingConfig = [
    ["BASE_URL", rawBaseUrl],
    ["ADMIN_KEY", adminKey],
    ["STRIPE_SECRET_KEY", stripeSecretKey],
    ["STRIPE_API_VERSION", stripeApiVersion],
    ["STRIPE_WEBHOOK_SECRET", stripeWebhookSecret],
    ["STRIPE_PRICE_2GB", stripePriceIds["2GB"]],
    ["STRIPE_PRICE_4GB", stripePriceIds["4GB"]]
].filter(([, value]) => !value);

if (missingConfig.length > 0) {
    const names = missingConfig.map(([name]) => name).join(", ");
    exitConfigError(`Missing required configuration: ${names}`);
}

const parsedBaseUrl = parseAbsoluteHttpUrl("BASE_URL", rawBaseUrl);
const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
const allowedOrigins = Array.from(new Set([
    parsedBaseUrl.origin,
    ...parseAllowedOrigins(rawAllowedOrigins)
]));

const config = {
    port,
    host,
    baseUrl,
    baseOrigin: parsedBaseUrl.origin,
    allowedOrigins,
    secureCookies: parsedBaseUrl.protocol === "https:",
    adminKey,
    adminSessionTtlMs: 1000 * 60 * 60 * 12,
    adminSessionCookieName: parsedBaseUrl.protocol === "https:"
        ? "__Host-admin_session"
        : "admin_session",
    browserSessionCookieName: parsedBaseUrl.protocol === "https:"
        ? "__Host-browser_session"
        : "browser_session",
    setupSessionCookieName: parsedBaseUrl.protocol === "https:"
        ? "__Host-setup_session"
        : "setup_session",
    stripeSecretKey,
    stripeApiVersion,
    stripeWebhookSecret,
    stripePriceIds,
    setupTokenTtlMs: 1000 * 60 * 60 * 24 * 7
};

module.exports = config;
