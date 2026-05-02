const { allQuery, getQuery, runQuery } = require("../db/queries");
const { SERVER_STATUS } = require("../constants/status");
const { listSupportedMinecraftVersions } = require("../config/minecraftVersions");
const {
    normalizePlanDefinition,
    stringifyNormalizedPlan,
    validatePlanDefinition
} = require("./planDefinitions");

function parseJson(value, fallback = null) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function listCuratedMinecraftVersionStrings() {
    return [...new Set(
        listSupportedMinecraftVersions()
            .map(entry => String(entry.minecraftVersion || "").trim())
            .filter(Boolean)
    )];
}

function slugifyPlanKey(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}

function hasOwnField(input, fieldName) {
    return Object.prototype.hasOwnProperty.call(input || {}, fieldName);
}

function asBooleanLike(value) {
    return value === true || value === "true" || value === 1 || value === "1";
}

function formatStripePriceLabel(metadata) {
    if (!metadata || !Number.isFinite(metadata.amount)) {
        return "Draft price pending";
    }

    const currency = String(metadata.currency || "usd").toLowerCase();
    const amount = currency === "usd"
        ? `$${metadata.amount.toFixed(2)}`
        : `${metadata.amount.toFixed(2)} ${currency.toUpperCase()}`;
    const interval = metadata.recurringInterval || "month";
    const intervalCount = Number(metadata.recurringIntervalCount || 1);

    if (intervalCount > 1) {
        return `${amount}/${intervalCount} ${interval}s`;
    }

    return `${amount}/${interval}`;
}

function applyStripePriceMetadata(definition, stripeValidation) {
    if (!stripeValidation?.metadata) {
        return definition;
    }

    definition.stripe.priceMetadata = stripeValidation.metadata;
    if (Number.isFinite(stripeValidation.metadata.amount)) {
        definition.public.priceAmount = stripeValidation.metadata.amount;
        definition.public.priceLabel = formatStripePriceLabel(stripeValidation.metadata);
    }

    return definition;
}

function getProvisioningProfileCpuLimit(profile) {
    const notes = parseJson(profile?.targetAdminNotes, null);

    if (Number.isInteger(notes?.cpuLimit) && notes.cpuLimit >= 0) {
        return notes.cpuLimit;
    }

    return 0;
}

async function nextSortOrder() {
    const row = await getQuery("SELECT COALESCE(MAX(sortOrder), 0) AS maxSortOrder FROM planDefinitions");
    return Number(row?.maxSortOrder || 0) + 10;
}

function shouldUseSimpleBuilderInput(input = {}) {
    const provisioningInput = input.provisioning || {};
    const inventoryInput = input.inventory || {};
    const hasInternalCodes = Boolean(
        input.productCode ||
        input.inventoryBucketCode ||
        input.nodeGroupCode ||
        input.provisioningTargetCode ||
        inventoryInput.bucketCode ||
        provisioningInput.nodeGroupCode ||
        provisioningInput.targetCode
    );

    return Boolean(input.provisioningProfileCode || (!hasInternalCodes && (input.planKey || input.publicName)));
}

async function loadProvisioningProfile(profileCode) {
    const normalizedCode = slugifyPlanKey(profileCode || "paper-launch-default");

    if (!normalizedCode) {
        return null;
    }

    return getQuery(
        `SELECT
            t.code AS targetCode,
            t.displayName AS targetName,
            t.runtimeFamily AS runtimeFamily,
            t.active AS targetActive,
            t.adminNotes AS targetAdminNotes,
            t.supportedVersionsJson AS targetSupportedVersionsJson,
            g.code AS nodeGroupCode,
            g.displayName AS nodeGroupName,
            g.active AS nodeGroupActive,
            g.adminNotes AS nodeGroupAdminNotes,
            g.supportedVersionsJson AS nodeGroupSupportedVersionsJson
         FROM provisioningTargets t
         LEFT JOIN nodeGroups g ON g.code = t.nodeGroupCode
         WHERE t.code = ?`,
        [normalizedCode]
    );
}

async function preparePlanDefinitionInput(input = {}) {
    if (!shouldUseSimpleBuilderInput(input)) {
        return { ...input, _builderValidationErrors: [] };
    }

    const statusInput = input.status || {};
    const publicInput = input.public || {};
    const runtimeInput = input.runtime || {};
    const inventoryInput = input.inventory || {};
    const planKey = slugifyPlanKey(input.planKey || input.key || input.planType);
    const publicName = String(input.publicName || input.displayName || publicInput.name || "").trim();
    const profileCode = input.provisioningProfileCode ||
        input.provisioningTargetCode ||
        input.provisioning?.targetCode ||
        "paper-launch-default";
    const profile = await loadProvisioningProfile(profileCode);
    const generatedProductCode = planKey ? `minecraft-${planKey}` : "";
    const generatedBucketCode = planKey ? `${planKey}-bucket` : "";
    const generatedBucketName = publicName ? `${publicName} Bucket` : "";
    const active = input.active ?? statusInput.active;
    const storefrontVisible = input.storefrontVisible ?? statusInput.storefrontVisible;
    const activating = asBooleanLike(active) || asBooleanLike(storefrontVisible);
    const existing = planKey ? await getPlanDefinition(planKey) : null;
    const generatedSortOrder = hasOwnField(input, "sortOrder")
        ? input.sortOrder
        : (existing?.definition?.sortOrder ?? await nextSortOrder());
    const builderValidationErrors = [];

    if (!profile) {
        builderValidationErrors.push("Select an active provisioning profile.");
    } else if (activating && (Number(profile.targetActive) !== 1 || Number(profile.nodeGroupActive) !== 1)) {
        builderValidationErrors.push("Selected provisioning profile must be active before activation or storefront visibility.");
    }

    return {
        ...input,
        planKey,
        productCode: generatedProductCode,
        publicName,
        runtimeFamily: input.runtimeFamily || runtimeInput.family || profile?.runtimeFamily || "paper",
        runtimeTemplate: input.runtimeTemplate || runtimeInput.template || profile?.targetCode || "paper-launch-default",
        cpuLimit: getProvisioningProfileCpuLimit(profile),
        priceLabel: "Draft price pending",
        priceAmount: 0,
        inventoryBucketCode: generatedBucketCode,
        inventoryBucketName: generatedBucketName,
        nodeGroupCode: profile?.nodeGroupCode || "",
        nodeGroupName: profile?.nodeGroupName || "",
        provisioningTargetCode: profile?.targetCode || slugifyPlanKey(profileCode),
        provisioningTargetName: profile?.targetName || "",
        supportedVersions: listCuratedMinecraftVersionStrings(),
        sortOrder: generatedSortOrder,
        _builderValidationErrors: builderValidationErrors
    };
}

async function previewPlanDefinition(input = {}, options = {}) {
    const prepared = await preparePlanDefinitionInput(input);
    const definition = normalizePlanDefinition(prepared);
    const schemaValidation = validatePlanDefinition(definition);
    const extraErrors = [
        ...(prepared._builderValidationErrors || []),
        ...(options.extraValidationErrors || [])
    ];
    const errors = [...schemaValidation.errors, ...extraErrors];

    return {
        definition,
        validation: {
            valid: errors.length === 0,
            errors
        },
        generated: {
            productCode: definition.productCode,
            inventoryBucketCode: definition.inventory.bucketCode,
            inventoryBucketName: definition.inventory.displayName,
            provisioningProfileCode: definition.provisioning.targetCode,
            nodeGroupCode: definition.provisioning.nodeGroupCode,
            sortOrder: definition.sortOrder,
            cpuLimit: definition.runtime.cpuLimit,
            priceLabel: definition.public.priceLabel,
            priceAmount: definition.public.priceAmount,
            priceCurrency: definition.stripe.priceMetadata?.currency || null,
            recurringInterval: definition.stripe.priceMetadata?.recurringInterval || null,
            supportedVersionCount: definition.runtime.supportedVersions.length
        }
    };
}

function createLaunchPlanDefinition(planType, plan, stripePriceId) {
    return normalizePlanDefinition({
        planKey: planType,
        productCode: plan.code,
        publicName: plan.displayName,
        publicDescription: "A fixed-resource Paper Minecraft server with guided setup after checkout.",
        priceLabel: `$${Number(plan.price).toFixed(2)}/month`,
        priceAmount: Number(plan.price),
        runtimeFamily: plan.runtimeFamily,
        runtimeTemplate: plan.runtimeTemplate,
        containerMemoryMb: plan.containerMemoryMb,
        jvmMemoryMb: plan.jvmMemoryMb,
        cpuLimit: 0,
        diskMb: 10240,
        supportedVersions: listCuratedMinecraftVersionStrings(),
        features: plan.features || [],
        stripePriceId,
        inventoryBucketCode: plan.inventoryBucketCode,
        inventoryBucketName: `${plan.displayName} Launch Bucket`,
        totalSlots: plan.launchSlotCount,
        purchaseEnabled: true,
        nodeGroupCode: plan.nodeGroupCode,
        nodeGroupName: "Paper Launch Group",
        provisioningTargetCode: plan.provisioningTargetCode,
        provisioningTargetName: "Paper Launch Default Target",
        active: true,
        storefrontVisible: true,
        sortOrder: 10
    });
}

function serializePlanRow(row) {
    const definition = parseJson(row.definitionJson, {});
    const stripePriceMetadata = parseJson(row.stripePriceMetadataJson, null);

    if (definition.stripe) {
        definition.stripe.priceMetadata = stripePriceMetadata || definition.stripe.priceMetadata || null;
    }

    return {
        ...row,
        active: Number(row.active) === 1,
        storefrontVisible: Number(row.storefrontVisible) === 1,
        definition,
        stripePriceMetadata,
        validationErrors: parseJson(row.validationErrorsJson, [])
    };
}

async function ensureServersForPlan(definition) {
    const current = await getQuery(
        "SELECT COUNT(*) AS count FROM servers WHERE productCode = ?",
        [definition.productCode]
    );
    const currentCount = Number(current?.count || 0);
    const targetCount = Number(definition.inventory.totalSlots || 0);

    for (let index = currentCount; index < targetCount; index += 1) {
        await runQuery(
            `INSERT INTO servers
                (
                    type,
                    price,
                    status,
                    productCode,
                    inventoryBucketCode,
                    nodeGroupCode,
                    provisioningTargetCode,
                    runtimeFamily,
                    runtimeTemplate
                )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                definition.planKey,
                definition.public.priceAmount,
                SERVER_STATUS.AVAILABLE,
                definition.productCode,
                definition.inventory.bucketCode,
                definition.provisioning.nodeGroupCode,
                definition.provisioning.targetCode,
                definition.runtime.family,
                definition.runtime.template
            ]
        );
    }
}

async function projectPlanDefinition(definition) {
    await runQuery(
        `INSERT INTO products
            (
                code,
                planType,
                displayName,
                price,
                productFamily,
                runtimeFamily,
                runtimeTemplate,
                inventoryBucketCode,
                nodeGroupCode,
                provisioningTargetCode,
                launchSlotCount,
                active,
                releaseGateMode,
                description,
                priceLabel,
                storefrontVisible,
                sortOrder,
                stripePriceId
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
            planType = excluded.planType,
            displayName = excluded.displayName,
            price = excluded.price,
            productFamily = excluded.productFamily,
            runtimeFamily = excluded.runtimeFamily,
            runtimeTemplate = excluded.runtimeTemplate,
            inventoryBucketCode = excluded.inventoryBucketCode,
            nodeGroupCode = excluded.nodeGroupCode,
            provisioningTargetCode = excluded.provisioningTargetCode,
            launchSlotCount = excluded.launchSlotCount,
            active = excluded.active,
            description = excluded.description,
            priceLabel = excluded.priceLabel,
            storefrontVisible = excluded.storefrontVisible,
            sortOrder = excluded.sortOrder,
            stripePriceId = excluded.stripePriceId`,
        [
            definition.productCode,
            definition.planKey,
            definition.public.name,
            definition.public.priceAmount,
            "minecraft",
            definition.runtime.family,
            definition.runtime.template,
            definition.inventory.bucketCode,
            definition.provisioning.nodeGroupCode,
            definition.provisioning.targetCode,
            definition.inventory.totalSlots,
            definition.status.active ? 1 : 0,
            "admin_release",
            definition.public.description,
            definition.public.priceLabel,
            definition.status.storefrontVisible ? 1 : 0,
            definition.sortOrder,
            definition.stripe.priceId
        ]
    );

    await runQuery(
        `INSERT INTO inventoryBuckets
            (
                code,
                productCode,
                displayName,
                capacityTarget,
                reservationPolicy,
                releasePolicy,
                active,
                purchaseEnabled
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
            productCode = excluded.productCode,
            displayName = excluded.displayName,
            capacityTarget = excluded.capacityTarget,
            active = excluded.active,
            purchaseEnabled = excluded.purchaseEnabled`,
        [
            definition.inventory.bucketCode,
            definition.productCode,
            definition.inventory.displayName,
            definition.inventory.totalSlots,
            "reserve_on_checkout",
            "release_on_expire_or_cancel",
            definition.status.active ? 1 : 0,
            definition.inventory.purchaseEnabled ? 1 : 0
        ]
    );

    await runQuery(
        `INSERT INTO nodeGroups
            (code, displayName, runtimeFamily, allocationMode, active, supportedVersionsJson)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
            displayName = excluded.displayName,
            runtimeFamily = excluded.runtimeFamily,
            active = excluded.active,
            supportedVersionsJson = excluded.supportedVersionsJson`,
        [
            definition.provisioning.nodeGroupCode,
            definition.provisioning.nodeGroupName,
            definition.runtime.family,
            "manual_edge_apply",
            definition.status.active ? 1 : 0,
            JSON.stringify(definition.runtime.supportedVersions || [])
        ]
    );

    await runQuery(
        `INSERT INTO provisioningTargets
            (
                code,
                nodeGroupCode,
                displayName,
                runtimeFamily,
                operatorMode,
                active,
                supportedVersionsJson
            )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
            nodeGroupCode = excluded.nodeGroupCode,
            displayName = excluded.displayName,
            runtimeFamily = excluded.runtimeFamily,
            active = excluded.active,
            supportedVersionsJson = excluded.supportedVersionsJson`,
        [
            definition.provisioning.targetCode,
            definition.provisioning.nodeGroupCode,
            definition.provisioning.targetName,
            definition.runtime.family,
            "operator_release_gate",
            definition.status.active ? 1 : 0,
            JSON.stringify(definition.runtime.supportedVersions || [])
        ]
    );

    await ensureServersForPlan(definition);
}

async function savePlanDefinition(input, options = {}) {
    const prepared = await preparePlanDefinitionInput(input);
    const definition = normalizePlanDefinition(prepared);
    const schemaValidation = validatePlanDefinition(definition);
    const stripeValidation = options.stripeValidation || null;
    const errors = [
        ...schemaValidation.errors,
        ...(prepared._builderValidationErrors || []),
        ...(options.extraValidationErrors || []),
        ...(stripeValidation && !stripeValidation.valid ? stripeValidation.errors : [])
    ];

    applyStripePriceMetadata(definition, stripeValidation);

    if (errors.length) {
        return {
            saved: false,
            definition,
            validation: {
                valid: false,
                errors
            }
        };
    }

    const now = Date.now();
    const existing = await getPlanDefinition(definition.planKey);

    await runQuery(
        `INSERT INTO planDefinitions
            (
                planKey,
                productCode,
                definitionJson,
                stripePriceId,
                stripePriceMetadataJson,
                active,
                storefrontVisible,
                sortOrder,
                validationStatus,
                validationErrorsJson,
                createdAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(planKey) DO UPDATE SET
            productCode = excluded.productCode,
            definitionJson = excluded.definitionJson,
            stripePriceId = excluded.stripePriceId,
            stripePriceMetadataJson = excluded.stripePriceMetadataJson,
            active = excluded.active,
            storefrontVisible = excluded.storefrontVisible,
            sortOrder = excluded.sortOrder,
            validationStatus = excluded.validationStatus,
            validationErrorsJson = excluded.validationErrorsJson,
            updatedAt = excluded.updatedAt`,
        [
            definition.planKey,
            definition.productCode,
            stringifyNormalizedPlan(definition),
            definition.stripe.priceId,
            definition.stripe.priceMetadata ? JSON.stringify(definition.stripe.priceMetadata) : null,
            definition.status.active ? 1 : 0,
            definition.status.storefrontVisible ? 1 : 0,
            definition.sortOrder,
            "valid",
            JSON.stringify([]),
            existing?.createdAt || now,
            now
        ]
    );

    await projectPlanDefinition(definition);

    return {
        saved: true,
        previous: existing,
        definition,
        validation: {
            valid: true,
            errors: []
        }
    };
}

async function getPlanDefinition(planKey) {
    const row = await getQuery("SELECT * FROM planDefinitions WHERE planKey = ?", [planKey]);
    return row ? serializePlanRow(row) : null;
}

async function listPlanDefinitions() {
    const rows = await allQuery(
        "SELECT * FROM planDefinitions ORDER BY sortOrder ASC, planKey ASC"
    );
    return rows.map(serializePlanRow);
}

async function listPublicPlans() {
    const rows = await allQuery(
        `SELECT
            pd.*,
            COALESCE(inv.available, 0) AS available,
            COALESCE(inv.held, 0) AS held,
            COALESCE(inv.allocated, 0) AS allocated,
            COALESCE(b.purchaseEnabled, 1) AS purchaseEnabled,
            COALESCE(b.active, 1) AS bucketActive,
            COALESCE(t.active, 1) AS targetActive,
            COALESCE(g.active, 1) AS nodeGroupActive
         FROM planDefinitions pd
         LEFT JOIN products p ON p.code = pd.productCode
         LEFT JOIN inventoryBuckets b ON b.code = p.inventoryBucketCode
         LEFT JOIN provisioningTargets t ON t.code = p.provisioningTargetCode
         LEFT JOIN nodeGroups g ON g.code = p.nodeGroupCode
         LEFT JOIN (
            SELECT
                productCode,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS available,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS held,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS allocated
            FROM servers
            GROUP BY productCode
         ) inv ON inv.productCode = pd.productCode
         WHERE pd.active = 1
           AND pd.storefrontVisible = 1
         ORDER BY pd.sortOrder ASC, pd.planKey ASC`,
        [SERVER_STATUS.AVAILABLE, SERVER_STATUS.HELD, SERVER_STATUS.ALLOCATED]
    );

    return rows.map(row => {
        const plan = serializePlanRow(row);
        const available = Number(row.available || 0);
        const canCheckout = available > 0 &&
            Number(row.purchaseEnabled) === 1 &&
            Number(row.bucketActive) === 1 &&
            Number(row.targetActive) === 1 &&
            Number(row.nodeGroupActive) === 1;

        return {
            ...plan,
            available,
            held: Number(row.held || 0),
            allocated: Number(row.allocated || 0),
            purchaseEnabled: Number(row.purchaseEnabled) === 1,
            bucketActive: Number(row.bucketActive) === 1,
            targetActive: Number(row.targetActive) === 1,
            nodeGroupActive: Number(row.nodeGroupActive) === 1,
            soldOut: available === 0,
            canCheckout,
            canJoinWaitlist: available === 0
        };
    });
}

async function resolveCheckoutPlan(planKey) {
    const row = await getQuery(
        `SELECT
            pd.*,
            b.active AS bucketActive,
            b.purchaseEnabled AS purchaseEnabled,
            t.active AS targetActive,
            g.active AS nodeGroupActive
         FROM planDefinitions pd
         LEFT JOIN products p ON p.code = pd.productCode
         LEFT JOIN inventoryBuckets b ON b.code = p.inventoryBucketCode
         LEFT JOIN provisioningTargets t ON t.code = p.provisioningTargetCode
         LEFT JOIN nodeGroups g ON g.code = p.nodeGroupCode
         WHERE pd.planKey = ?
           AND pd.active = 1
           AND pd.storefrontVisible = 1`,
        [planKey]
    );

    if (!row) {
        return null;
    }

    const plan = serializePlanRow(row);

    if (
        Number(row.bucketActive) !== 1 ||
        Number(row.purchaseEnabled) !== 1 ||
        Number(row.targetActive) !== 1 ||
        Number(row.nodeGroupActive) !== 1
    ) {
        return null;
    }

    return plan;
}

module.exports = {
    createLaunchPlanDefinition,
    applyStripePriceMetadata,
    formatStripePriceLabel,
    getPlanDefinition,
    listPlanDefinitions,
    listPublicPlans,
    previewPlanDefinition,
    projectPlanDefinition,
    resolveCheckoutPlan,
    savePlanDefinition
};
