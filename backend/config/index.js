const rawBaseUrl = (process.env.BASE_URL || "").trim();
const rawAllowedOrigins = (process.env.ALLOWED_ORIGINS || "").trim();

let parsedBaseUrl = null;

try {
    parsedBaseUrl = rawBaseUrl ? new URL(rawBaseUrl) : null;
} catch {
    parsedBaseUrl = null;
}

const baseUrl = parsedBaseUrl
    ? parsedBaseUrl.toString().replace(/\/+$/, "")
    : "";

const allowedOrigins = Array.from(new Set([
    parsedBaseUrl ? parsedBaseUrl.origin : "",
    ...rawAllowedOrigins
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean)
])).filter(Boolean);

const config = {
    port: Number(process.env.PORT || 3000),
    host: (process.env.HOST || "0.0.0.0").trim(),
    baseUrl,
    baseOrigin: parsedBaseUrl ? parsedBaseUrl.origin : "",
    allowedOrigins,
    secureCookies: parsedBaseUrl ? parsedBaseUrl.protocol === "https:" : false,
    adminKey: process.env.ADMIN_KEY,
    adminSessionTtlMs: 1000 * 60 * 60 * 12,
    adminSessionCookieName: parsedBaseUrl && parsedBaseUrl.protocol === "https:"
        ? "__Host-admin_session"
        : "admin_session",
    setupSessionCookieName: parsedBaseUrl && parsedBaseUrl.protocol === "https:"
        ? "__Host-setup_session"
        : "setup_session",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripePriceIds: {
        "2GB": (process.env.STRIPE_PRICE_2GB || "price_1TLNS1AHxmSgftnMGKoN5LnI").trim(),
        "4GB": (process.env.STRIPE_PRICE_4GB || "price_1TLNSQAHxmSgftnMHqcihgg1").trim()
    },
    setupTokenTtlMs: 1000 * 60 * 60 * 24 * 7
};

const missingConfig = [
    ["BASE_URL", config.baseUrl],
    ["ADMIN_KEY", config.adminKey],
    ["STRIPE_SECRET_KEY", config.stripeSecretKey],
    ["STRIPE_WEBHOOK_SECRET", config.stripeWebhookSecret],
    ["STRIPE_PRICE_2GB", config.stripePriceIds["2GB"]],
    ["STRIPE_PRICE_4GB", config.stripePriceIds["4GB"]]
].filter(([, value]) => !value);

if (missingConfig.length > 0) {
    const names = missingConfig.map(([name]) => name).join(", ");
    console.error(`Missing required configuration: ${names}`);
    process.exit(1);
}

if (!parsedBaseUrl) {
    console.error("BASE_URL must be a valid absolute URL.");
    process.exit(1);
}

module.exports = config;
