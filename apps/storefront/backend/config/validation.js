const REQUIRED_RUNTIME_ENV_NAMES = [
    "BASE_URL",
    "ADMIN_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_API_VERSION",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PAPER_2GB"
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
    STRIPE_PRICE_PAPER_2GB: new Set([
        "price_replace_me"
    ])
};

const OPTIONAL_PELICAN_ENV_NAMES = [
    "PELICAN_PANEL_URL",
    "PELICAN_APPLICATION_API_KEY",
    "PELICAN_PROVISIONING_TARGETS_JSON"
];

const OPTIONAL_EMAIL_ENV_NAMES = [
    "EMAIL_PROVIDER",
    "POSTMARK_SERVER_TOKEN",
    "POSTMARK_MESSAGE_STREAM"
];

const EMAIL_PROVIDER = {
    LOG: "log",
    POSTMARK: "postmark"
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

function parseInteger(name, value, options = {}) {
    const number = Number(value);
    const minimum = Number.isFinite(options.minimum) ? options.minimum : 1;

    if (!Number.isInteger(number) || number < minimum) {
        failConfigValidation(`${name} must be an integer greater than or equal to ${minimum}.`);
    }

    return number;
}

function parseBoolean(name, value, defaultValue = false) {
    if (value === undefined || value === null || value === "") {
        return defaultValue;
    }

    if (typeof value === "boolean") {
        return value;
    }

    failConfigValidation(`${name} must be a boolean.`);
}

function parseEmailProvider(value) {
    const normalized = String(value || "").trim().toLowerCase() || EMAIL_PROVIDER.LOG;

    if (normalized === EMAIL_PROVIDER.LOG || normalized === EMAIL_PROVIDER.POSTMARK) {
        return normalized;
    }

    failConfigValidation("EMAIL_PROVIDER must be one of: log, postmark.");
}

function parseStringMap(name, value = {}, options = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        failConfigValidation(`${name} must be an object.`);
    }

    const result = {};

    for (const [key, rawEntry] of Object.entries(value)) {
        const entry = String(rawEntry || "").trim();

        if (!entry && options.allowEmpty !== true) {
            failConfigValidation(`${name}.${key} must not be empty.`);
        }

        result[key] = entry;
    }

    return result;
}

function parseTargetValue(name, value, options = {}) {
    const parseEntry = rawEntry => options.integer
        ? parseInteger(name, rawEntry, { minimum: options.minimum || 1 })
        : String(rawEntry || "").trim();

    if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, "byRuntimeProfile")
    ) {
        return {
            byRuntimeProfile: Object.fromEntries(
                Object.entries(parseStringMap(`${name}.byRuntimeProfile`, value.byRuntimeProfile))
                    .map(([profileCode, entry]) => [
                        profileCode,
                        options.integer
                            ? parseInteger(`${name}.byRuntimeProfile.${profileCode}`, entry, {
                                minimum: options.minimum || 1
                            })
                            : entry
                    ])
            )
        };
    }

    const parsed = parseEntry(value);

    if (!parsed && options.required !== false) {
        failConfigValidation(`${name} must not be empty.`);
    }

    return parsed;
}

function parseTargetEnvironment(name, value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        failConfigValidation(`${name} must be an object.`);
    }

    const result = {};

    for (const [key, rawEntry] of Object.entries(value)) {
        if (rawEntry === null || rawEntry === undefined) {
            failConfigValidation(`${name}.${key} must not be null.`);
        }

        result[key] = String(rawEntry);
    }

    return result;
}

function parseProvisioningTarget(code, rawTarget) {
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
        failConfigValidation(`PELICAN_PROVISIONING_TARGETS_JSON.${code} must be an object.`);
    }

    const allocationIds = rawTarget.allocationIds;

    if (!Array.isArray(allocationIds) || allocationIds.length === 0) {
        failConfigValidation(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.allocationIds must be a non-empty array.`);
    }

    return {
        code,
        egg: parseTargetValue(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.egg`, rawTarget.egg, {
            integer: true
        }),
        allocationIds: allocationIds.map((allocationId, index) =>
            parseInteger(
                `PELICAN_PROVISIONING_TARGETS_JSON.${code}.allocationIds[${index}]`,
                allocationId
            )
        ),
        dockerImage: parseTargetValue(
            `PELICAN_PROVISIONING_TARGETS_JSON.${code}.dockerImage`,
            rawTarget.dockerImage
        ),
        startup: parseTargetValue(
            `PELICAN_PROVISIONING_TARGETS_JSON.${code}.startup`,
            rawTarget.startup
        ),
        environment: parseTargetEnvironment(
            `PELICAN_PROVISIONING_TARGETS_JSON.${code}.environment`,
            rawTarget.environment || {}
        ),
        environmentByRuntimeProfile: rawTarget.environmentByRuntimeProfile
            ? Object.fromEntries(
                Object.entries(rawTarget.environmentByRuntimeProfile).map(([profileCode, profileEnvironment]) => [
                    profileCode,
                    parseTargetEnvironment(
                        `PELICAN_PROVISIONING_TARGETS_JSON.${code}.environmentByRuntimeProfile.${profileCode}`,
                        profileEnvironment
                    )
                ])
            )
            : {},
        limits: {
            memory: parseInteger(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.limits.memory`, rawTarget.limits?.memory),
            swap: parseInteger(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.limits.swap`, rawTarget.limits?.swap, {
                minimum: 0
            }),
            disk: parseInteger(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.limits.disk`, rawTarget.limits?.disk),
            io: parseInteger(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.limits.io`, rawTarget.limits?.io, {
                minimum: 0
            }),
            cpu: parseInteger(`PELICAN_PROVISIONING_TARGETS_JSON.${code}.limits.cpu`, rawTarget.limits?.cpu, {
                minimum: 0
            }),
            threads: rawTarget.limits?.threads === undefined || rawTarget.limits?.threads === null
                ? null
                : String(rawTarget.limits.threads)
        },
        featureLimits: {
            databases: parseInteger(
                `PELICAN_PROVISIONING_TARGETS_JSON.${code}.featureLimits.databases`,
                rawTarget.featureLimits?.databases,
                { minimum: 0 }
            ),
            allocations: parseInteger(
                `PELICAN_PROVISIONING_TARGETS_JSON.${code}.featureLimits.allocations`,
                rawTarget.featureLimits?.allocations,
                { minimum: 0 }
            ),
            backups: parseInteger(
                `PELICAN_PROVISIONING_TARGETS_JSON.${code}.featureLimits.backups`,
                rawTarget.featureLimits?.backups,
                { minimum: 0 }
            )
        },
        skipScripts: parseBoolean(
            `PELICAN_PROVISIONING_TARGETS_JSON.${code}.skipScripts`,
            rawTarget.skipScripts,
            false
        ),
        startOnCompletion: parseBoolean(
            `PELICAN_PROVISIONING_TARGETS_JSON.${code}.startOnCompletion`,
            rawTarget.startOnCompletion,
            false
        ),
        oomKiller: parseBoolean(
            `PELICAN_PROVISIONING_TARGETS_JSON.${code}.oomKiller`,
            rawTarget.oomKiller,
            true
        )
    };
}

function parsePelicanProvisioningTargets(rawValue) {
    const trimmedValue = String(rawValue || "").trim();

    if (!trimmedValue) {
        return {};
    }

    let parsed;

    try {
        parsed = JSON.parse(trimmedValue);
    } catch {
        failConfigValidation("PELICAN_PROVISIONING_TARGETS_JSON must be valid JSON.");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        failConfigValidation("PELICAN_PROVISIONING_TARGETS_JSON must be an object keyed by provisioning target code.");
    }

    return Object.fromEntries(
        Object.entries(parsed).map(([code, target]) => [
            code,
            parseProvisioningTarget(code, target)
        ])
    );
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
    const customerHostnameRootDomain = getTrimmedEnvValue(env, "CUSTOMER_HOSTNAME_ROOT_DOMAIN") || "oberyn.net";
    const outboundEmailFrom = getTrimmedEnvValue(env, "OUTBOUND_EMAIL_FROM") || "support@oberynn.com";
    const emailProvider = parseEmailProvider(getTrimmedEnvValue(env, "EMAIL_PROVIDER"));
    const postmarkServerToken = getTrimmedEnvValue(env, "POSTMARK_SERVER_TOKEN");
    const postmarkMessageStream = getTrimmedEnvValue(env, "POSTMARK_MESSAGE_STREAM") || "outbound";
    const rawPelicanPanelUrl = getTrimmedEnvValue(env, "PELICAN_PANEL_URL");
    const pelicanApplicationApiKey = getTrimmedEnvValue(env, "PELICAN_APPLICATION_API_KEY");
    const rawPelicanProvisioningTargets = getTrimmedEnvValue(env, "PELICAN_PROVISIONING_TARGETS_JSON");
    const adminKey = getTrimmedEnvValue(env, "ADMIN_KEY");
    const stripeSecretKey = getTrimmedEnvValue(env, "STRIPE_SECRET_KEY");
    const stripeApiVersion = getTrimmedEnvValue(env, "STRIPE_API_VERSION");
    const stripeWebhookSecret = getTrimmedEnvValue(env, "STRIPE_WEBHOOK_SECRET");
    const setupSecretKey = getTrimmedEnvValue(env, "SETUP_SECRET_KEY") || adminKey;
    const stripePriceIds = {
        "paper-2gb": getTrimmedEnvValue(env, "STRIPE_PRICE_PAPER_2GB")
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

    if (emailProvider === EMAIL_PROVIDER.POSTMARK && !postmarkServerToken) {
        failConfigValidation("POSTMARK_SERVER_TOKEN is required when EMAIL_PROVIDER=postmark.");
    }

    const parsedBaseUrl = parseAbsoluteHttpUrl("BASE_URL", rawBaseUrl);
    const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
    const pelicanPanelUrl = rawPelicanPanelUrl
        ? parseAbsoluteHttpUrl("PELICAN_PANEL_URL", rawPelicanPanelUrl).toString().replace(/\/+$/, "")
        : "";
    const pelicanProvisioningTargets = parsePelicanProvisioningTargets(rawPelicanProvisioningTargets);
    const allowedOrigins = Array.from(new Set([
        parsedBaseUrl.origin,
        ...parseAllowedOrigins(rawAllowedOrigins)
    ]));

    return {
        port,
        host,
        baseUrl,
        baseOrigin: parsedBaseUrl.origin,
        customerHostnameRootDomain: customerHostnameRootDomain.toLowerCase(),
        outboundEmailFrom,
        allowedOrigins,
        secureCookies: parsedBaseUrl.protocol === "https:",
        email: {
            provider: emailProvider,
            postmarkServerToken,
            postmarkMessageStream,
            configured: emailProvider === EMAIL_PROVIDER.LOG || Boolean(postmarkServerToken),
            presentEnvNames: OPTIONAL_EMAIL_ENV_NAMES.filter(name => getTrimmedEnvValue(env, name))
        },
        adminKey,
        adminSessionTtlMs: 1000 * 60 * 60 * 12,
        adminSessionCookieName: parsedBaseUrl.protocol === "https:"
            ? "__Host-admin_session"
            : "admin_session",
        setupSecretKey,
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
        pelican: {
            panelUrl: pelicanPanelUrl,
            applicationApiKey: pelicanApplicationApiKey,
            provisioningTargets: pelicanProvisioningTargets,
            configured: Boolean(
                pelicanPanelUrl &&
                pelicanApplicationApiKey &&
                Object.keys(pelicanProvisioningTargets).length > 0
            ),
            presentEnvNames: OPTIONAL_PELICAN_ENV_NAMES.filter(name => getTrimmedEnvValue(env, name))
        },
        setupTokenTtlMs: 1000 * 60 * 60 * 24 * 7
    };
}

module.exports = {
    ConfigValidationError,
    EMAIL_PROVIDER,
    OPTIONAL_EMAIL_ENV_NAMES,
    OPTIONAL_PELICAN_ENV_NAMES,
    PLACEHOLDER_ENV_NAMES,
    REQUIRED_RUNTIME_ENV_NAMES,
    buildRuntimeConfig,
    findPlaceholderEnvNames,
    isPlaceholderValue,
    parseAbsoluteHttpUrl,
    parseAllowedOrigins
};
