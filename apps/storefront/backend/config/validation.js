const REQUIRED_RUNTIME_ENV_NAMES = [
    "BASE_URL",
    "ADMIN_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_API_VERSION",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_3GB"
];

const PLACEHOLDER_ENV_NAMES = [
    ...REQUIRED_RUNTIME_ENV_NAMES,
    "ALLOWED_ORIGINS"
];

const EXACT_PLACEHOLDER_VALUES = {
    ADMIN_KEY: new Set([
        "replace-with-a-long-random-secret"
    ]),
    STRIPE_SECRET_KEY: new Set([
        "sk_test_replace_me"
    ]),
    STRIPE_WEBHOOK_SECRET: new Set([
        "whsec_replace_me"
    ]),
};

class ConfigValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigValidationError";
    }
}

function getTrimmedEnvValue(env, name) {
    return String(env[name] || "").trim();
}

function failConfigValidation(message) {
    throw new ConfigValidationError(message);
}

function parseAbsoluteHttpUrl(name, value) {
    let parsed;

    try {
        parsed = new URL(value);
    } catch {
        failConfigValidation(`${name} must be a valid absolute URL.`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        failConfigValidation(`${name} must use http or https.`);
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

function isPlaceholderHostname(hostname) {
    const normalized = String(hostname || "").trim().toLowerCase();

    return normalized === "example.com" ||
        normalized.endsWith(".example.com") ||
        normalized === "your-domain.example" ||
        normalized.endsWith(".example");
}

function isPlaceholderUrlValue(name, value) {
    const values = name === "ALLOWED_ORIGINS"
        ? value.split(",").map(origin => origin.trim()).filter(Boolean)
        : [value];

    for (const entry of values) {
        let parsed;

        try {
            parsed = parseAbsoluteHttpUrl(name, entry);
        } catch {
            return false;
        }

        if (isPlaceholderHostname(parsed.hostname)) {
            return true;
        }
    }

    return false;
}

function isPlaceholderValue(name, value) {
    const trimmedValue = String(value || "").trim();

    if (!trimmedValue) {
        return false;
    }

    if (name === "BASE_URL" || name === "ALLOWED_ORIGINS") {
        return isPlaceholderUrlValue(name, trimmedValue);
    }

    const exactValues = EXACT_PLACEHOLDER_VALUES[name];
    return exactValues ? exactValues.has(trimmedValue) : false;
}

function findPlaceholderEnvNames(env = process.env, envNames = PLACEHOLDER_ENV_NAMES) {
    return envNames.filter(name => isPlaceholderValue(name, getTrimmedEnvValue(env, name)));
}

function buildRuntimeConfig(env = process.env) {
    const rawPort = getTrimmedEnvValue(env, "PORT") || "3000";
    const port = Number(rawPort);
    const host = getTrimmedEnvValue(env, "HOST") || "0.0.0.0";
    const rawBaseUrl = getTrimmedEnvValue(env, "BASE_URL");
    const rawAllowedOrigins = getTrimmedEnvValue(env, "ALLOWED_ORIGINS");
    const adminKey = getTrimmedEnvValue(env, "ADMIN_KEY");
    const stripeSecretKey = getTrimmedEnvValue(env, "STRIPE_SECRET_KEY");
    const stripeApiVersion = getTrimmedEnvValue(env, "STRIPE_API_VERSION");
    const stripeWebhookSecret = getTrimmedEnvValue(env, "STRIPE_WEBHOOK_SECRET");
    const stripePriceIds = {
        "3GB": getTrimmedEnvValue(env, "STRIPE_PRICE_3GB")
    };

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        failConfigValidation("PORT must be an integer between 1 and 65535.");
    }

    if (!host) {
        failConfigValidation("HOST must not be empty.");
    }

    const missingConfig = REQUIRED_RUNTIME_ENV_NAMES.filter(name => !getTrimmedEnvValue(env, name));

    if (missingConfig.length > 0) {
        failConfigValidation(`Missing required configuration: ${missingConfig.join(", ")}`);
    }

    const placeholderConfig = findPlaceholderEnvNames(env);

    if (placeholderConfig.length > 0) {
        failConfigValidation(
            `Replace placeholder configuration values before startup: ${placeholderConfig.join(", ")}`
        );
    }

    const parsedBaseUrl = parseAbsoluteHttpUrl("BASE_URL", rawBaseUrl);
    const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
    const allowedOrigins = Array.from(new Set([
        parsedBaseUrl.origin,
        ...parseAllowedOrigins(rawAllowedOrigins)
    ]));

    return {
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
}

module.exports = {
    ConfigValidationError,
    PLACEHOLDER_ENV_NAMES,
    REQUIRED_RUNTIME_ENV_NAMES,
    buildRuntimeConfig,
    findPlaceholderEnvNames,
    isPlaceholderValue,
    parseAbsoluteHttpUrl,
    parseAllowedOrigins
};
