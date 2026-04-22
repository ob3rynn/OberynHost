const {
    FULFILLMENT_FAILURE_CLASS,
    FULFILLMENT_TASK_TYPE,
    enqueueProvisioningJobForPurchase,
    leaseNextFulfillmentJob,
    moveLeasedJobToAdminReview
} = require("../services/fulfillmentQueue");

const DEFAULT_WORKER_INTERVAL_MS = 1000 * 5;
const DEFAULT_WORKER_LEASE_MS = 1000 * 60;

function buildPendingContractReason(job) {
    return [
        "Provisioning paused for operator review.",
        "The Pelican provisioning contract is not configured yet for automated execution.",
        `Purchase ${job.purchaseId} is queued with server name "${job.serverName || "unknown"}".`
    ].join(" ");
}

async function processFulfillmentJob(job, options = {}) {
    switch (job.taskType) {
        case FULFILLMENT_TASK_TYPE.PROVISION_INITIAL_SERVER:
            await moveLeasedJobToAdminReview(job, {
                now: options.now,
                failureClass: FULFILLMENT_FAILURE_CLASS.MANUAL_APPROVAL_REQUIRED,
                reason: buildPendingContractReason(job)
            });
            return {
                outcome: "needs_admin_review",
                purchaseId: job.purchaseId,
                queueId: job.queueId
            };
        default:
            await moveLeasedJobToAdminReview(job, {
                now: options.now,
                failureClass: FULFILLMENT_FAILURE_CLASS.VALIDATION_OR_CONFIG_ERROR,
                reason: `Unknown fulfillment task type: ${job.taskType}`
            });
            return {
                outcome: "needs_admin_review",
                purchaseId: job.purchaseId,
                queueId: job.queueId
            };
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
    processFulfillmentJob,
    runFulfillmentWorkerIteration,
    startFulfillmentWorker
};
