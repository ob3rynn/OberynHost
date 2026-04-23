const {
    FULFILLMENT_FAILURE_CLASS,
    FULFILLMENT_TASK_TYPE,
    completeLeasedProvisioningJob,
    enqueueProvisioningJobForPurchase,
    leaseNextFulfillmentJob,
    moveLeasedJobToAdminReview
} = require("../services/fulfillmentQueue");
const { PURCHASE_STATUS } = require("../constants/status");
const { buildDesiredRoutingArtifact } = require("../services/routingArtifacts");
const defaultProvisioner = require("../services/pelicanProvisioner");
const { ProvisioningBlockedError } = require("../services/pelicanProvisioner");
const { decryptSetupSecret } = require("../services/setupSecrets");

const DEFAULT_WORKER_INTERVAL_MS = 1000 * 5;
const DEFAULT_WORKER_LEASE_MS = 1000 * 60;

function getProvisioningContractErrors(job) {
    const errors = [];

    if (job.status !== PURCHASE_STATUS.PAID) {
        errors.push("purchase is not in paid state");
    }

    if (!job.serverId || job.serverStatus !== "held") {
        errors.push("reserved capacity is not held");
    }

    if (!job.serverName) errors.push("server name is missing");
    if (!job.hostname || !job.hostnameReservationKey) errors.push("hostname reservation is missing");
    if (!job.productCode) errors.push("product code is missing");
    if (!job.inventoryBucketCode) errors.push("inventory bucket is missing");
    if (!job.nodeGroupCode) errors.push("node group is missing");
    if (!job.provisioningTargetCode) errors.push("provisioning target is missing");
    if (!job.minecraftVersion) errors.push("Minecraft version is missing");
    if (!job.runtimeProfileCode || !job.runtimeJavaVersion) errors.push("resolved runtime profile is missing");
    if (!job.pelicanUsername) errors.push("Pelican username is missing");

    if (!job.pelicanUserId && !job.email) {
        errors.push("customer email is missing for Pelican user creation");
    }

    if (!job.pelicanUserId && (
        !job.pelicanPasswordCiphertext ||
        !job.pelicanPasswordIv ||
        !job.pelicanPasswordAuthTag
    )) {
        errors.push("first-time Pelican password is not staged");
    }

    return errors;
}

function normalizeProvisioningResult(job, result = {}) {
    return {
        pelicanUserId: String(result.pelicanUserId || job.pelicanUserId || "").trim(),
        pelicanUsername: String(result.pelicanUsername || job.pelicanUsername || "").trim(),
        pelicanServerId: String(result.pelicanServerId || "").trim(),
        pelicanServerIdentifier: String(result.pelicanServerIdentifier || "").trim(),
        pelicanAllocationId: String(result.pelicanAllocationId || "").trim()
    };
}

function getProvisioningResultErrors(result) {
    const errors = [];

    if (!result.pelicanUserId) errors.push("Pelican user ID was not returned");
    if (!result.pelicanUsername) errors.push("Pelican username was not returned");
    if (!result.pelicanServerId) errors.push("Pelican server ID was not returned");
    if (!result.pelicanServerIdentifier) errors.push("Pelican server identifier was not returned");
    if (!result.pelicanAllocationId) errors.push("Pelican allocation ID was not returned");

    return errors;
}

function buildProvisioningInput(job) {
    const pelicanPassword = job.pelicanUserId
        ? ""
        : decryptSetupSecret({
            ciphertext: job.pelicanPasswordCiphertext,
            iv: job.pelicanPasswordIv,
            authTag: job.pelicanPasswordAuthTag
        });

    return {
        purchaseId: job.purchaseId,
        stripeCustomerId: job.stripeCustomerId || "",
        email: job.email || "",
        serverName: job.serverName,
        hostname: job.hostname,
        productCode: job.productCode,
        inventoryBucketCode: job.inventoryBucketCode,
        nodeGroupCode: job.nodeGroupCode,
        provisioningTargetCode: job.provisioningTargetCode,
        minecraftVersion: job.minecraftVersion,
        runtimeFamily: job.runtimeFamily,
        runtimeTemplate: job.runtimeTemplate,
        runtimeProfileCode: job.runtimeProfileCode,
        runtimeJavaVersion: Number(job.runtimeJavaVersion),
        pelicanUserId: job.pelicanUserId || "",
        pelicanUsername: job.pelicanUsername,
        pelicanPassword
    };
}

async function moveToAdminReview(job, details) {
    await moveLeasedJobToAdminReview(job, details);
    return {
        outcome: "needs_admin_review",
        purchaseId: job.purchaseId,
        queueId: job.queueId
    };
}

async function processInitialServerProvisioning(job, options = {}) {
    const contractErrors = getProvisioningContractErrors(job);

    if (contractErrors.length > 0) {
        return moveToAdminReview(job, {
            now: options.now,
            failureClass: FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR,
            reason: `Provisioning contract failed preflight: ${contractErrors.join("; ")}.`
        });
    }

    const provisionInitialServer = options.provisionInitialServer ||
        defaultProvisioner.provisionInitialServer;

    let rawResult;

    try {
        rawResult = await provisionInitialServer(buildProvisioningInput(job));
    } catch (err) {
        if (err instanceof ProvisioningBlockedError) {
            return moveToAdminReview(job, {
                now: options.now,
                failureClass: err.failureClass,
                reason: err.message
            });
        }

        return moveToAdminReview(job, {
            now: options.now,
            failureClass: FULFILLMENT_FAILURE_CLASS.TRANSIENT_EXTERNAL_FAILURE,
            reason: `Pelican provisioning failed before completion: ${err.message || "unknown error"}`
        });
    }

    const provisioningResult = normalizeProvisioningResult(job, rawResult);
    const resultErrors = getProvisioningResultErrors(provisioningResult);

    if (resultErrors.length > 0) {
        return moveToAdminReview(job, {
            now: options.now,
            failureClass: FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR,
            reason: `Pelican provisioning returned an incomplete linkage: ${resultErrors.join("; ")}.`
        });
    }

    const routingArtifact = buildDesiredRoutingArtifact(job, provisioningResult);
    const completed = await completeLeasedProvisioningJob(
        job,
        provisioningResult,
        routingArtifact,
        { now: options.now }
    );

    if (!completed) {
        return {
            outcome: "stale_lease",
            purchaseId: job.purchaseId,
            queueId: job.queueId
        };
    }

    return {
        outcome: "pending_activation",
        purchaseId: job.purchaseId,
        queueId: job.queueId
    };
}

async function processFulfillmentJob(job, options = {}) {
    switch (job.taskType) {
        case FULFILLMENT_TASK_TYPE.PROVISION_INITIAL_SERVER:
            return processInitialServerProvisioning(job, options);
        default:
            return moveToAdminReview(job, {
                now: options.now,
                failureClass: FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR,
                reason: `Unknown fulfillment task type: ${job.taskType}`
            });
    }
}

async function runFulfillmentWorkerIteration(options = {}) {
    const leasedJob = await leaseNextFulfillmentJob({
        now: options.now,
        leaseMs: options.leaseMs || DEFAULT_WORKER_LEASE_MS
    });

    if (!leasedJob) {
        return null;
    }

    return processFulfillmentJob(leasedJob, options);
}

function startFulfillmentWorker(options = {}) {
    const intervalMs = Number(options.intervalMs || DEFAULT_WORKER_INTERVAL_MS);
    let timer = null;
    let stopped = false;
    let running = false;

    async function tick() {
        if (stopped || running) {
            return;
        }

        running = true;

        try {
            await runFulfillmentWorkerIteration(options);
        } catch (err) {
            console.error("Fulfillment worker iteration failed:", err);
        } finally {
            running = false;

            if (!stopped) {
                timer = setTimeout(tick, intervalMs);
            }
        }
    }

    timer = setTimeout(tick, 0);

    return {
        enqueueProvisioningJobForPurchase,
        stop() {
            stopped = true;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
        tick
    };
}

module.exports = {
    DEFAULT_WORKER_INTERVAL_MS,
    DEFAULT_WORKER_LEASE_MS,
    enqueueProvisioningJobForPurchase,
    getProvisioningContractErrors,
    processFulfillmentJob,
    runFulfillmentWorkerIteration,
    startFulfillmentWorker
};
