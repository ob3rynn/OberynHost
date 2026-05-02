const PLAN_SCHEMA_VERSION = 1;

const PLAN_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STRIPE_PRICE_PATTERN = /^price_[A-Za-z0-9_]+$/;

function asString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === "") {
        return defaultValue;
    }

    return value === true || value === "true" || value === 1 || value === "1";
}

function asInteger(value, defaultValue = null) {
    if (value === undefined || value === null || value === "") {
        return defaultValue;
    }

    const number = Number(value);
    return Number.isInteger(number) ? number : NaN;
}

function asNumber(value, defaultValue = null) {
    if (value === undefined || value === null || value === "") {
        return defaultValue;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
}

function asStringList(value) {
    if (Array.isArray(value)) {
        return value.map(asString).filter(Boolean);
    }

    if (typeof value === "string") {
        return value
            .split(/\r?\n|,/)
            .map(asString)
            .filter(Boolean);
    }

    return [];
}

function parsePriceAmount(value, label) {
    const direct = asNumber(value);

    if (Number.isFinite(direct)) {
        return direct;
    }

    const match = asString(label).match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    return match ? Number(match[1]) : NaN;
}

function normalizePlanDefinition(input = {}) {
    const publicInput = input.public || {};
    const runtimeInput = input.runtime || {};
    const stripeInput = input.stripe || {};
    const inventoryInput = input.inventory || {};
    const provisioningInput = input.provisioning || {};
    const statusInput = input.status || {};

    const planKey = asString(input.planKey || input.key || input.planType).toLowerCase();
    const productCode = asString(input.productCode || input.code).toLowerCase();
    const priceLabel = asString(input.priceLabel || publicInput.priceLabel);

    return {
        schemaVersion: PLAN_SCHEMA_VERSION,
        planKey,
        productCode,
        public: {
            name: asString(input.publicName || input.displayName || publicInput.name),
            description: asString(input.publicDescription || publicInput.description),
            priceLabel,
            priceAmount: parsePriceAmount(input.priceAmount ?? publicInput.priceAmount, priceLabel),
            features: asStringList(input.features ?? publicInput.features)
        },
        runtime: {
            family: asString(input.runtimeFamily || runtimeInput.family).toLowerCase(),
            template: asString(input.runtimeTemplate || runtimeInput.template),
            containerMemoryMb: asInteger(input.containerMemoryMb ?? runtimeInput.containerMemoryMb),
            jvmMemoryMb: asInteger(input.jvmMemoryMb ?? runtimeInput.jvmMemoryMb, null),
            cpuLimit: asInteger(input.cpuLimit ?? runtimeInput.cpuLimit, 0),
            diskMb: asInteger(input.diskMb ?? runtimeInput.diskMb, null),
            supportedVersions: asStringList(input.supportedVersions ?? runtimeInput.supportedVersions)
        },
        stripe: {
            priceId: asString(input.stripePriceId || stripeInput.priceId),
            priceMetadata: stripeInput.priceMetadata && typeof stripeInput.priceMetadata === "object"
                ? stripeInput.priceMetadata
                : null
        },
        inventory: {
            bucketCode: asString(input.inventoryBucketCode || inventoryInput.bucketCode).toLowerCase(),
            displayName: asString(input.inventoryBucketName || inventoryInput.displayName),
            totalSlots: asInteger(input.totalSlots ?? inventoryInput.totalSlots, 0),
            purchaseEnabled: asBoolean(input.purchaseEnabled ?? inventoryInput.purchaseEnabled, true)
        },
        provisioning: {
            nodeGroupCode: asString(input.nodeGroupCode || provisioningInput.nodeGroupCode).toLowerCase(),
            nodeGroupName: asString(input.nodeGroupName || provisioningInput.nodeGroupName),
            targetCode: asString(input.provisioningTargetCode || provisioningInput.targetCode).toLowerCase(),
            targetName: asString(input.provisioningTargetName || provisioningInput.targetName)
        },
        status: {
            active: asBoolean(input.active ?? statusInput.active, false),
            storefrontVisible: asBoolean(input.storefrontVisible ?? statusInput.storefrontVisible, false)
        },
        sortOrder: asInteger(input.sortOrder, 100)
    };
}

function validatePlanDefinition(definition) {
    const errors = [];

    if (definition.schemaVersion !== PLAN_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be ${PLAN_SCHEMA_VERSION}.`);
    }

    if (!PLAN_KEY_PATTERN.test(definition.planKey)) {
        errors.push("Plan short name must use lowercase letters, numbers, and hyphens.");
    }

    if (!CODE_PATTERN.test(definition.productCode)) {
        errors.push("Product code must use lowercase letters, numbers, and hyphens.");
    }

    if (!definition.public.name) errors.push("Public plan name is required.");
    if (!definition.public.description) errors.push("Public description is required.");
    if (!definition.public.priceLabel) errors.push("Price display label is required.");
    if (!Number.isFinite(definition.public.priceAmount) || definition.public.priceAmount < 0) {
        errors.push("A valid non-negative price amount is required.");
    }

    if (!definition.runtime.family) errors.push("Runtime family is required.");
    if (!definition.runtime.template) errors.push("Runtime template is required.");
    if (!Number.isInteger(definition.runtime.containerMemoryMb) || definition.runtime.containerMemoryMb <= 0) {
        errors.push("Container memory must be a positive integer.");
    }
    if (
        definition.runtime.jvmMemoryMb !== null &&
        (!Number.isInteger(definition.runtime.jvmMemoryMb) || definition.runtime.jvmMemoryMb <= 0)
    ) {
        errors.push("JVM memory must be a positive integer when provided.");
    }
    if (!Number.isInteger(definition.runtime.cpuLimit) || definition.runtime.cpuLimit < 0) {
        errors.push("CPU limit must be a non-negative integer.");
    }
    if (
        definition.runtime.diskMb !== null &&
        (!Number.isInteger(definition.runtime.diskMb) || definition.runtime.diskMb <= 0)
    ) {
        errors.push("Disk must be a positive integer when provided.");
    }

    if (!CODE_PATTERN.test(definition.inventory.bucketCode)) {
        errors.push("Inventory bucket code is required and must use lowercase letters, numbers, and hyphens.");
    }
    if (!definition.inventory.displayName) errors.push("Inventory bucket display name is required.");
    if (!Number.isInteger(definition.inventory.totalSlots) || definition.inventory.totalSlots < 0) {
        errors.push("Total slots must be a non-negative integer.");
    }

    if (!CODE_PATTERN.test(definition.provisioning.nodeGroupCode)) {
        errors.push("Node group code is required and must use lowercase letters, numbers, and hyphens.");
    }
    if (!definition.provisioning.nodeGroupName) errors.push("Node group display name is required.");
    if (!CODE_PATTERN.test(definition.provisioning.targetCode)) {
        errors.push("Provisioning target code is required and must use lowercase letters, numbers, and hyphens.");
    }
    if (!definition.provisioning.targetName) errors.push("Provisioning target display name is required.");

    if (!Number.isInteger(definition.sortOrder)) {
        errors.push("Sort order must be an integer.");
    }

    if (definition.status.active || definition.status.storefrontVisible) {
        if (!STRIPE_PRICE_PATTERN.test(definition.stripe.priceId)) {
            errors.push("Active or storefront-visible plans require a valid Stripe price ID.");
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

function parseRawPlanDefinition(rawValue) {
    let parsed;

    if (typeof rawValue === "string") {
        parsed = JSON.parse(rawValue);
    } else {
        parsed = rawValue;
    }

    return normalizePlanDefinition(parsed);
}

function stringifyNormalizedPlan(definition) {
    return JSON.stringify(definition, null, 2);
}

module.exports = {
    PLAN_SCHEMA_VERSION,
    normalizePlanDefinition,
    parseRawPlanDefinition,
    stringifyNormalizedPlan,
    validatePlanDefinition
};
