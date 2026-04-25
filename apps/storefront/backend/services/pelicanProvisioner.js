const config = require("../config");
const { PURCHASE_STATUS } = require("../constants/status");
const { allQuery } = require("../db/queries");
const { FULFILLMENT_FAILURE_CLASS } = require("./fulfillmentQueue");

class ProvisioningBlockedError extends Error {
    constructor(message, failureClass = FULFILLMENT_FAILURE_CLASS.MANUAL_APPROVAL_REQUIRED) {
        super(message);
        this.name = "ProvisioningBlockedError";
        this.failureClass = failureClass;
    }
}

class PelicanApiError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "PelicanApiError";
        this.status = details.status;
        this.path = details.path;
        this.body = details.body;
    }
}

function getPelicanConfig(options = {}) {
    return options.config?.pelican || config.pelican || {};
}

function getMissingConfigNames(pelicanConfig) {
    const missing = [];

    if (!pelicanConfig.panelUrl) missing.push("PELICAN_PANEL_URL");
    if (!pelicanConfig.applicationApiKey) missing.push("PELICAN_APPLICATION_API_KEY");
    if (!Object.keys(pelicanConfig.provisioningTargets || {}).length) {
        missing.push("PELICAN_PROVISIONING_TARGETS_JSON");
    }

    return missing;
}

function assertLiveConfig(pelicanConfig) {
    const missing = getMissingConfigNames(pelicanConfig);

    if (missing.length > 0) {
        throw new ProvisioningBlockedError(
            `Pelican provisioning adapter is not configured for live API execution yet. Missing: ${missing.join(", ")}.`,
            FULFILLMENT_FAILURE_CLASS.MANUAL_APPROVAL_REQUIRED
        );
    }
}

function assertApiConfig(pelicanConfig) {
    const missing = [];

    if (!pelicanConfig.panelUrl) missing.push("PELICAN_PANEL_URL");
    if (!pelicanConfig.applicationApiKey) missing.push("PELICAN_APPLICATION_API_KEY");

    if (missing.length > 0) {
        throw new ProvisioningBlockedError(
            `Pelican Application API is not configured for reconcile yet. Missing: ${missing.join(", ")}.`,
            FULFILLMENT_FAILURE_CLASS.MANUAL_APPROVAL_REQUIRED
        );
    }
}

function unwrapAttributes(payload) {
    return payload?.attributes || payload?.data?.attributes || payload?.data || payload || {};
}

function encodeExternalId(externalId) {
    return encodeURIComponent(String(externalId || "").trim());
}

async function readResponseText(response) {
    try {
        return await response.text();
    } catch {
        return "";
    }
}

async function pelicanRequest(path, options = {}) {
    const pelicanConfig = options.pelicanConfig;
    const fetchImpl = options.fetchImpl || global.fetch;

    if (typeof fetchImpl !== "function") {
        throw new ProvisioningBlockedError(
            "Pelican provisioning requires a fetch implementation.",
            FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
        );
    }

    const response = await fetchImpl(`${pelicanConfig.panelUrl}${path}`, {
        method: options.method || "GET",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${pelicanConfig.applicationApiKey}`
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (response.status === 404 && options.notFoundOk) {
        return null;
    }

    if (!response.ok) {
        const responseText = await readResponseText(response);
        const suffix = responseText ? ` ${responseText.slice(0, 500)}` : "";

        throw new PelicanApiError(
            `Pelican API ${options.method || "GET"} ${path} failed with HTTP ${response.status}.${suffix}`,
            {
                status: response.status,
                path,
                body: responseText
            }
        );
    }

    if (response.status === 204) {
        return {};
    }

    try {
        return await response.json();
    } catch {
        return {};
    }
}

async function getUserByExternalId(externalId, requestOptions) {
    const payload = await pelicanRequest(
        `/api/application/users/external/${encodeExternalId(externalId)}`,
        { ...requestOptions, notFoundOk: true }
    );

    return payload ? unwrapAttributes(payload) : null;
}

async function getUserById(userId, requestOptions) {
    const normalizedUserId = String(userId || "").trim();

    if (!normalizedUserId) {
        return null;
    }

    const payload = await pelicanRequest(
        `/api/application/users/${encodeExternalId(normalizedUserId)}`,
        { ...requestOptions, notFoundOk: true }
    );

    return payload ? unwrapAttributes(payload) : null;
}

async function getServerByExternalId(externalId, requestOptions) {
    const payload = await pelicanRequest(
        `/api/application/servers/external/${encodeExternalId(externalId)}`,
        { ...requestOptions, notFoundOk: true }
    );

    return payload ? unwrapAttributes(payload) : null;
}

async function getServerById(serverId, requestOptions) {
    const normalizedServerId = String(serverId || "").trim();

    if (!normalizedServerId) {
        return null;
    }

    const payload = await pelicanRequest(
        `/api/application/servers/${encodeExternalId(normalizedServerId)}`,
        { ...requestOptions, notFoundOk: true }
    );

    return payload ? unwrapAttributes(payload) : null;
}

function buildCustomerExternalId(input) {
    const stripeCustomerId = String(input.stripeCustomerId || "").trim();

    return stripeCustomerId ? `stripe:${stripeCustomerId}` : "";
}

function buildPurchaseExternalId(input) {
    return `purchase:${input.purchaseId || input.id}`;
}

function normalizeNumericId(name, value) {
    const number = Number(value);

    if (!Number.isInteger(number) || number < 1) {
        throw new ProvisioningBlockedError(
            `${name} must be a numeric Pelican ID for live provisioning.`,
            FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
        );
    }

    return number;
}

function normalizePelicanUser(user, fallback = {}) {
    const attributes = unwrapAttributes(user);

    return {
        id: normalizeNumericId("Pelican user ID", attributes.id || fallback.pelicanUserId),
        username: String(attributes.username || fallback.pelicanUsername || "").trim()
    };
}

async function ensurePelicanUser(input, requestOptions) {
    if (input.pelicanUserId) {
        return normalizePelicanUser(null, input);
    }

    const customerExternalId = buildCustomerExternalId(input);

    if (!customerExternalId) {
        throw new ProvisioningBlockedError(
            "Stripe customer ID is required to create or reuse a Pelican user.",
            FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
        );
    }

    const existingUser = await getUserByExternalId(customerExternalId, requestOptions);

    if (existingUser) {
        return normalizePelicanUser(existingUser, input);
    }

    const email = String(input.email || "").trim();
    const username = String(input.pelicanUsername || "").trim();
    const password = String(input.pelicanPassword || "");

    if (!email || !username || !password) {
        throw new ProvisioningBlockedError(
            "Email, Pelican username, and staged one-time password are required to create a Pelican user.",
            FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
        );
    }

    const payload = await pelicanRequest("/api/application/users", {
        ...requestOptions,
        method: "POST",
        body: {
            external_id: customerExternalId,
            email,
            username,
            password,
            language: "en",
            timezone: "UTC"
        }
    });

    return normalizePelicanUser(payload, input);
}

function resolveTargetValue(name, targetValue, input) {
    if (
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue) &&
        targetValue.byRuntimeProfile
    ) {
        const value = targetValue.byRuntimeProfile[input.runtimeProfileCode] ||
            targetValue.byRuntimeProfile[String(input.runtimeJavaVersion)] ||
            targetValue.byRuntimeProfile.default;

        if (value === undefined || value === null || value === "") {
            throw new ProvisioningBlockedError(
                `Provisioning target is missing ${name} for runtime profile ${input.runtimeProfileCode}.`,
                FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
            );
        }

        return value;
    }

    return targetValue;
}

function renderTemplate(value, input) {
    const replacements = {
        hostname: input.hostname,
        minecraftVersion: input.minecraftVersion,
        purchaseId: input.purchaseId,
        runtimeJavaVersion: input.runtimeJavaVersion,
        runtimeProfileCode: input.runtimeProfileCode,
        serverName: input.serverName
    };

    return String(value).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(replacements, key)
            ? String(replacements[key] ?? "")
            : match
    );
}

function buildServerEnvironment(target, input) {
    const profileEnvironment = target.environmentByRuntimeProfile?.[input.runtimeProfileCode] || {};
    const environment = {
        ...(target.environment || {}),
        ...profileEnvironment
    };

    return Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [
            key,
            renderTemplate(value, input)
        ])
    );
}

async function selectAllocationId(target, input) {
    const rows = await allQuery(
        `SELECT pelicanAllocationId
         FROM purchases
         WHERE id != ?
           AND pelicanAllocationId IS NOT NULL
           AND TRIM(pelicanAllocationId) != ''
           AND status NOT IN (?, ?)`,
        [
            input.purchaseId,
            PURCHASE_STATUS.CANCELLED,
            PURCHASE_STATUS.EXPIRED
        ]
    );
    const usedIds = new Set(rows.map(row => String(row.pelicanAllocationId)));
    const allocationId = target.allocationIds.find(candidate => !usedIds.has(String(candidate)));

    if (!allocationId) {
        throw new ProvisioningBlockedError(
            `No configured Pelican allocation is available for target ${target.code}.`,
            FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
        );
    }

    return allocationId;
}

function normalizeServerResult(server, input) {
    const attributes = unwrapAttributes(server);
    const pelicanServerId = attributes.id;
    const pelicanServerIdentifier = attributes.identifier || attributes.uuid_short || attributes.uuid;
    const pelicanAllocationId = attributes.allocation || attributes.allocation_id;
    const pelicanUserId = attributes.user || input.pelicanUserId;

    return {
        pelicanUserId: String(pelicanUserId || "").trim(),
        pelicanUsername: String(input.pelicanUsername || "").trim(),
        pelicanServerId: String(pelicanServerId || "").trim(),
        pelicanServerIdentifier: String(pelicanServerIdentifier || "").trim(),
        pelicanAllocationId: String(pelicanAllocationId || "").trim()
    };
}

function buildServerCreatePayload(input, target, pelicanUser, allocationId) {
    const egg = normalizeNumericId(
        "Pelican egg ID",
        resolveTargetValue("egg", target.egg, input)
    );

    return {
        external_id: buildPurchaseExternalId(input),
        name: input.serverName,
        description: `OberynHost purchase ${input.purchaseId} for ${input.hostname}`,
        user: pelicanUser.id,
        egg,
        docker_image: renderTemplate(
            resolveTargetValue("dockerImage", target.dockerImage, input),
            input
        ),
        startup: renderTemplate(
            resolveTargetValue("startup", target.startup, input),
            input
        ),
        environment: buildServerEnvironment(target, input),
        limits: {
            memory: target.limits.memory,
            swap: target.limits.swap,
            disk: target.limits.disk,
            io: target.limits.io,
            cpu: target.limits.cpu,
            threads: target.limits.threads
        },
        feature_limits: {
            databases: target.featureLimits.databases,
            allocations: target.featureLimits.allocations,
            backups: target.featureLimits.backups
        },
        allocation: {
            default: allocationId
        },
        skip_scripts: target.skipScripts,
        start_on_completion: target.startOnCompletion,
        oom_killer: target.oomKiller
    };
}

function mapPelicanApiFailure(err) {
    if (!(err instanceof PelicanApiError)) {
        throw err;
    }

    if (err.status === 429 || err.status >= 500) {
        throw err;
    }

    throw new ProvisioningBlockedError(
        err.message,
        FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
    );
}

async function provisionInitialServer(input, options = {}) {
    const pelicanConfig = getPelicanConfig(options);
    assertLiveConfig(pelicanConfig);

    const target = pelicanConfig.provisioningTargets?.[input.provisioningTargetCode];

    if (!target) {
        throw new ProvisioningBlockedError(
            `No Pelican provisioning target is configured for ${input.provisioningTargetCode}.`,
            FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR
        );
    }

    const requestOptions = {
        pelicanConfig,
        fetchImpl: options.fetchImpl
    };
    const purchaseExternalId = buildPurchaseExternalId(input);

    try {
        const existingServer = await getServerByExternalId(purchaseExternalId, requestOptions);

        if (existingServer) {
            return normalizeServerResult(existingServer, input);
        }

        const pelicanUser = await ensurePelicanUser(input, requestOptions);
        const allocationId = await selectAllocationId(target, input);
        const serverPayload = buildServerCreatePayload(input, target, pelicanUser, allocationId);
        const createdServer = await pelicanRequest("/api/application/servers", {
            ...requestOptions,
            method: "POST",
            body: serverPayload
        });

        return normalizeServerResult(createdServer, {
            ...input,
            pelicanUserId: String(pelicanUser.id),
            pelicanUsername: pelicanUser.username || input.pelicanUsername
        });
    } catch (err) {
        mapPelicanApiFailure(err);
    }
}

async function fetchPelicanPurchaseFacts(input, options = {}) {
    const pelicanConfig = getPelicanConfig(options);
    assertApiConfig(pelicanConfig);

    const requestOptions = {
        pelicanConfig,
        fetchImpl: options.fetchImpl
    };
    const purchaseExternalId = buildPurchaseExternalId(input);
    const customerExternalId = buildCustomerExternalId(input);
    const server = await getServerByExternalId(purchaseExternalId, requestOptions) ||
        await getServerById(input.pelicanServerId, requestOptions);
    const user = customerExternalId
        ? await getUserByExternalId(customerExternalId, requestOptions) ||
            await getUserById(input.pelicanUserId, requestOptions)
        : await getUserById(input.pelicanUserId, requestOptions);

    return {
        server,
        user,
        lookup: {
            purchaseExternalId,
            customerExternalId: customerExternalId || null,
            fallbackServerId: input.pelicanServerId || null,
            fallbackUserId: input.pelicanUserId || null
        }
    };
}

module.exports = {
    PelicanApiError,
    ProvisioningBlockedError,
    buildPurchaseExternalId,
    fetchPelicanPurchaseFacts,
    provisionInitialServer
};
