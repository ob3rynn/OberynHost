const {
    FULFILLMENT_FAILURE_CLASS,
    FULFILLMENT_TASK_TYPE,
    completeLeasedProvisioningJob,
    enqueueProvisioningJobForPurchase,
    leaseNextFulfillmentJob,
    moveLeasedJobToAdminReview,
    moveLeasedJobToDeadLetter,
    retryLeasedProvisioningJob
} = require("../services/fulfillmentQueue");
const { PURCHASE_STATUS } = require("../constants/status");
const { buildDesiredRoutingArtifact: defaultBuildDesiredRoutingArtifact } = require("../services/routingArtifacts");
const {
    DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS,
    DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS,
    leaseNextEmailOutboxMessage,
    markEmailOutboxFailed,
    markEmailOutboxSent
} = require("../services/emailOutbox");
const {
    isRetryableEmailDeliveryError,
    sendEmailMessage: defaultSendEmailMessage
} = require("../services/emailProvider");
const {
    escalateNextPaidStalledPurchase,
    openNextSuspendedPurgeReviewTask,
    remindNextPaidStalledPurchase,
    suspendNextPurchasePastGrace,
    warnNextSuspendedPurchaseBeforeDelete
} = require("../services/lifecycleEnforcement");
const defaultProvisioner = require("../services/pelicanProvisioner");
const { ProvisioningBlockedError } = require("../services/pelicanProvisioner");
const { decryptSetupSecret } = require("../services/setupSecrets");

const DEFAULT_WORKER_INTERVAL_MS = 1000 * 5;
const DEFAULT_WORKER_LEASE_MS = 1000 * 60;
const DEFAULT_PROVISIONING_RETRY_DELAY_MS = 1000 * 30;
const DEFAULT_PROVISIONING_MAX_AUTO_RETRIES = 1;

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

async function moveToRetryableFailure(job, details, options = {}) {
    const retryResult = await retryLeasedProvisioningJob(job, {
        ...details,
        retryDelayMs: options.provisioningRetryDelayMs ?? DEFAULT_PROVISIONING_RETRY_DELAY_MS
    });

    if (!retryResult) {
        return {
            outcome: "stale_lease",
            purchaseId: job.purchaseId,
            queueId: job.queueId
        };
    }

    return {
        outcome: "retry_scheduled",
        purchaseId: job.purchaseId,
        queueId: job.queueId,
        nextAvailableAt: retryResult.nextAvailableAt
    };
}

async function moveToDeadLetter(job, details) {
    const deadLettered = await moveLeasedJobToDeadLetter(job, details);

    if (!deadLettered) {
        return {
            outcome: "stale_lease",
            purchaseId: job.purchaseId,
            queueId: job.queueId
        };
    }

    return {
        outcome: "dead_letter",
        purchaseId: job.purchaseId,
        queueId: job.queueId
    };
}

function isRetryableProvisioningFailureClass(failureClass) {
    return [
        FULFILLMENT_FAILURE_CLASS.TRANSIENT_EXTERNAL_FAILURE,
        FULFILLMENT_FAILURE_CLASS.DEPENDENCY_NOT_READY
    ].includes(failureClass);
}

function getProvisioningAttemptNumber(job) {
    return Number(job.attempts || 0) + 1;
}

function shouldAutoRetryProvisioningFailure(job, failureClass, options = {}) {
    const maxAutoRetries = Math.max(
        0,
        Number(options.provisioningMaxAutoRetries ?? DEFAULT_PROVISIONING_MAX_AUTO_RETRIES)
    );

    return (
        isRetryableProvisioningFailureClass(failureClass) &&
        getProvisioningAttemptNumber(job) <= maxAutoRetries
    );
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
    const completeProvisioningJob = options.completeProvisioningJob ||
        completeLeasedProvisioningJob;
    const buildDesiredRoutingArtifact = options.buildDesiredRoutingArtifact ||
        defaultBuildDesiredRoutingArtifact;

    let rawResult;

    try {
        rawResult = await provisionInitialServer(buildProvisioningInput(job));
    } catch (err) {
        if (err instanceof ProvisioningBlockedError) {
            if (shouldAutoRetryProvisioningFailure(job, err.failureClass, options)) {
                return moveToRetryableFailure(job, {
                    now: options.now,
                    failureClass: err.failureClass,
                    reason: err.message
                }, options);
            }

            return moveToAdminReview(job, {
                now: options.now,
                failureClass: err.failureClass,
                reason: err.message
            });
        }

        const failureReason = `Pelican provisioning failed before completion: ${err.message || "unknown error"}`;

        if (shouldAutoRetryProvisioningFailure(
            job,
            FULFILLMENT_FAILURE_CLASS.TRANSIENT_EXTERNAL_FAILURE,
            options
        )) {
            return moveToRetryableFailure(job, {
                now: options.now,
                failureClass: FULFILLMENT_FAILURE_CLASS.TRANSIENT_EXTERNAL_FAILURE,
                reason: failureReason
            }, options);
        }

        return moveToAdminReview(job, {
            now: options.now,
            failureClass: FULFILLMENT_FAILURE_CLASS.TRANSIENT_EXTERNAL_FAILURE,
            reason: failureReason
        });
    }

    const provisioningResult = normalizeProvisioningResult(job, rawResult);
    const resultErrors = getProvisioningResultErrors(provisioningResult);

    if (resultErrors.length > 0) {
        return moveToDeadLetter(job, {
            now: options.now,
            failureClass: FULFILLMENT_FAILURE_CLASS.DEAD_LETTER_ESCALATION,
            reason: `Pelican provisioning returned an incomplete linkage after external side effects may have occurred: ${resultErrors.join("; ")}.`
        });
    }

    try {
        const routingArtifact = buildDesiredRoutingArtifact(job, provisioningResult);
        const completed = await completeProvisioningJob(
            job,
            provisioningResult,
            routingArtifact,
            { now: options.now }
        );

        if (!completed) {
            return moveToDeadLetter(job, {
                now: options.now,
                failureClass: FULFILLMENT_FAILURE_CLASS.DEAD_LETTER_ESCALATION,
                reason: "Pelican provisioning succeeded, but local finalization could not complete safely and now requires explicit operator recovery."
            });
        }
    } catch (err) {
        return moveToDeadLetter(job, {
            now: options.now,
            failureClass: FULFILLMENT_FAILURE_CLASS.DEAD_LETTER_ESCALATION,
            reason: `Pelican provisioning succeeded, but local finalization failed: ${err.message || "unknown error"}`
        });
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

async function processEmailOutboxMessage(message, options = {}) {
    const sendEmailMessage = options.sendEmailMessage || defaultSendEmailMessage;
    const maxAttempts = Number(options.emailMaxAttempts || DEFAULT_EMAIL_OUTBOX_MAX_ATTEMPTS);
    const retryDelayMs = Number(options.emailRetryDelayMs || DEFAULT_EMAIL_OUTBOX_RETRY_DELAY_MS);

    try {
        const deliveryResult = await sendEmailMessage({
            id: message.id,
            purchaseId: message.purchaseId,
            kind: message.kind,
            idempotencyKey: message.idempotencyKey,
            recipientEmail: message.recipientEmail,
            senderEmail: message.senderEmail,
            subject: message.subject,
            bodyText: message.bodyText,
            payload: message.payload || null
        });

        const markedSent = await markEmailOutboxSent(message, {
            now: options.now
        });

        if (!markedSent) {
            return {
                outcome: "stale_email_outbox",
                emailOutboxId: message.id,
                purchaseId: message.purchaseId || null
            };
        }

        return {
            outcome: "sent",
            emailOutboxId: message.id,
            purchaseId: message.purchaseId || null,
            attempts: Number(message.attempts || 0),
            provider: String(deliveryResult?.provider || "").trim(),
            providerMessageId: String(deliveryResult?.providerMessageId || "").trim()
        };
    } catch (err) {
        const failureResult = await markEmailOutboxFailed(message, err, {
            now: options.now,
            retryable: isRetryableEmailDeliveryError(err),
            retryDelayMs,
            maxAttempts
        });

        if (!failureResult.updated) {
            return {
                outcome: "stale_email_outbox",
                emailOutboxId: message.id,
                purchaseId: message.purchaseId || null
            };
        }

        return {
            outcome: failureResult.shouldRetry ? "retry_scheduled" : "failed",
            emailOutboxId: message.id,
            purchaseId: message.purchaseId || null,
            attempts: Number(message.attempts || 0),
            nextAvailableAt: failureResult.nextAvailableAt,
            error: String(err?.message || "Email delivery failed.")
        };
    }
}

async function runEmailOutboxWorkerIteration(options = {}) {
    const message = await leaseNextEmailOutboxMessage({
        now: options.now,
        leaseMs: options.emailLeaseMs,
        maxAttempts: options.emailMaxAttempts
    });

    if (!message) {
        return null;
    }

    return processEmailOutboxMessage(message, options);
}

async function runLifecycleWorkerIteration(options = {}) {
    const reminder = await remindNextPaidStalledPurchase(options);

    if (reminder) {
        return reminder;
    }

    const escalation = await escalateNextPaidStalledPurchase(options);

    if (escalation) {
        return escalation;
    }

    const deleteWarning = await warnNextSuspendedPurchaseBeforeDelete(options);

    if (deleteWarning) {
        return deleteWarning;
    }

    const purgeReview = await openNextSuspendedPurgeReviewTask(options);

    if (purgeReview) {
        return purgeReview;
    }

    return suspendNextPurchasePastGrace(options);
}

async function runWorkerIteration(options = {}) {
    const fulfillment = await runFulfillmentWorkerIteration(options);
    const email = await runEmailOutboxWorkerIteration(options);
    const lifecycle = await runLifecycleWorkerIteration(options);

    if (!fulfillment && !email && !lifecycle) {
        return null;
    }

    return {
        fulfillment,
        email,
        lifecycle
    };
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
            await runWorkerIteration(options);
        } catch (err) {
            console.error("Worker iteration failed:", err);
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
    DEFAULT_PROVISIONING_MAX_AUTO_RETRIES,
    DEFAULT_PROVISIONING_RETRY_DELAY_MS,
    DEFAULT_WORKER_INTERVAL_MS,
    DEFAULT_WORKER_LEASE_MS,
    enqueueProvisioningJobForPurchase,
    getProvisioningContractErrors,
    processEmailOutboxMessage,
    processFulfillmentJob,
    runEmailOutboxWorkerIteration,
    runFulfillmentWorkerIteration,
    runLifecycleWorkerIteration,
    runWorkerIteration,
    startFulfillmentWorker
};
