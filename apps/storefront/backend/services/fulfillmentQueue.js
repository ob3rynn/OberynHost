const { FULFILLMENT_STATUS, SERVER_STATUS } = require("../constants/status");
const { getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");
const { mergeLifecycleState } = require("./lifecycle");
const { generateOpaqueToken } = require("../utils/tokens");

const FULFILLMENT_TASK_TYPE = {
    PROVISION_INITIAL_SERVER: "provision_initial_server"
};

const FULFILLMENT_QUEUE_STATE = {
    QUEUED: "queued",
    LEASED: "leased",
    COMPLETED: "completed",
    NEEDS_ADMIN_REVIEW: "needs_admin_review",
    DEAD_LETTER: "dead_letter"
};

const FULFILLMENT_FAILURE_CLASS = {
    TRANSIENT_EXTERNAL_FAILURE: "transient_external_failure",
    DEPENDENCY_NOT_READY: "dependency_not_ready",
    VALIDATION_OR_CONFIG_ERROR: "validation_or_config_error",
    MANUAL_APPROVAL_REQUIRED: "manual_approval_required",
    TERMINAL_BUSINESS_RULE_FAILURE: "terminal_business_rule_failure",
    DEAD_LETTER_ESCALATION: "dead_letter_escalation"
};

function buildProvisioningIdempotencyKey(purchaseId) {
    return `purchase:${purchaseId}:task:${FULFILLMENT_TASK_TYPE.PROVISION_INITIAL_SERVER}`;
}

function buildProvisioningPayload(purchase) {
    return {
        purchaseId: purchase.id,
        serverId: purchase.serverId,
        email: purchase.email || null,
        stripeCustomerId: purchase.stripeCustomerId || null,
        productCode: purchase.productCode,
        inventoryBucketCode: purchase.inventoryBucketCode,
        nodeGroupCode: purchase.nodeGroupCode,
        provisioningTargetCode: purchase.provisioningTargetCode,
        hostname: purchase.hostname || null,
        hostnameReservationKey: purchase.hostnameReservationKey || null,
        minecraftVersion: purchase.minecraftVersion || null,
        runtimeFamily: purchase.runtimeFamily,
        runtimeTemplate: purchase.runtimeTemplate,
        runtimeProfileCode: purchase.runtimeProfileCode || null,
        runtimeJavaVersion: Number(purchase.runtimeJavaVersion || 0) || null,
        pelicanUserId: purchase.pelicanUserId || null,
        pelicanUsername: purchase.pelicanUsername || null,
        pelicanAccountMode: purchase.pelicanUserId ? "reuse" : "create",
        serverName: purchase.serverName || ""
    };
}

async function enqueueProvisioningJobForPurchase(purchase, options = {}) {
    const now = Number(options.now || Date.now());
    const taskType = FULFILLMENT_TASK_TYPE.PROVISION_INITIAL_SERVER;
    const idempotencyKey = buildProvisioningIdempotencyKey(purchase.id);

    await runQuery(
        `INSERT INTO fulfillmentQueue
            (
                purchaseId,
                taskType,
                state,
                idempotencyKey,
                payloadJson,
                availableAt,
                createdAt,
                updatedAt
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotencyKey) DO NOTHING`,
        [
            purchase.id,
            taskType,
            FULFILLMENT_QUEUE_STATE.QUEUED,
            idempotencyKey,
            JSON.stringify(buildProvisioningPayload(purchase)),
            now,
            now,
            now
        ]
    );

    return getQuery(
        `SELECT *
         FROM fulfillmentQueue
         WHERE idempotencyKey = ?`,
        [idempotencyKey]
    );
}

async function leaseNextFulfillmentJob(options = {}) {
    const now = Number(options.now || Date.now());
    const leaseMs = Number(options.leaseMs || (1000 * 60));
    const leaseKey = generateOpaqueToken();
    const leaseExpiresAt = now + leaseMs;

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const job = await getQuery(
            `SELECT
                q.id AS queueId,
                q.purchaseId,
                q.taskType,
                q.state AS queueState,
                q.payloadJson,
                q.attempts,
                p.*,
                s.status AS serverStatus
             FROM fulfillmentQueue q
             JOIN purchases p ON p.id = q.purchaseId
             LEFT JOIN servers s ON s.id = p.serverId
             WHERE q.state = ?
               AND q.availableAt <= ?
               AND (p.workerLeaseExpiresAt IS NULL OR p.workerLeaseExpiresAt < ?)
             ORDER BY q.availableAt ASC, q.id ASC
             LIMIT 1`,
            [
                FULFILLMENT_QUEUE_STATE.QUEUED,
                now,
                now
            ]
        );

        if (!job) {
            await rollbackTransaction();
            return null;
        }

        const nextPurchase = mergeLifecycleState(job, {
            workerLeaseKey: leaseKey,
            workerLeaseExpiresAt: leaseExpiresAt,
            lastStateOwner: "worker"
        });

        const queueUpdate = await runQuery(
            `UPDATE fulfillmentQueue
             SET state = ?,
                 lockedAt = ?,
                 leaseKey = ?,
                 leaseExpiresAt = ?,
                 attempts = attempts + 1,
                 updatedAt = ?
             WHERE id = ?
               AND state = ?`,
            [
                FULFILLMENT_QUEUE_STATE.LEASED,
                now,
                leaseKey,
                leaseExpiresAt,
                now,
                job.queueId,
                FULFILLMENT_QUEUE_STATE.QUEUED
            ]
        );

        if (queueUpdate.changes === 0) {
            await rollbackTransaction();
            return null;
        }

        const purchaseUpdate = await runQuery(
            `UPDATE purchases
             SET workerLeaseKey = ?,
                 workerLeaseExpiresAt = ?,
                 fulfillmentStatus = ?,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?
               AND (workerLeaseExpiresAt IS NULL OR workerLeaseExpiresAt < ?)`,
            [
                leaseKey,
                leaseExpiresAt,
                nextPurchase.fulfillmentStatus,
                now,
                nextPurchase.lastStateOwner,
                job.purchaseId,
                now
            ]
        );

        if (purchaseUpdate.changes === 0) {
            await rollbackTransaction();
            return null;
        }

        await runQuery("COMMIT");

        return {
            ...job,
            queueState: FULFILLMENT_QUEUE_STATE.LEASED,
            leaseKey,
            leaseExpiresAt,
            fulfillmentStatus: nextPurchase.fulfillmentStatus,
            lastStateOwner: nextPurchase.lastStateOwner
        };
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
}

async function moveLeasedJobToAdminReview(job, details = {}) {
    const now = Number(details.now || Date.now());
    const reviewReason = String(details.reason || "").trim() ||
        "Provisioning requires operator review before automation can continue.";
    const failureClass = details.failureClass ||
        FULFILLMENT_FAILURE_CLASS.MANUAL_APPROVAL_REQUIRED;

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getQuery(
            "SELECT * FROM purchases WHERE id = ?",
            [job.purchaseId]
        );

        if (!purchase || purchase.workerLeaseKey !== job.leaseKey) {
            await rollbackTransaction();
            return false;
        }

        const nextPurchase = mergeLifecycleState(purchase, {
            fulfillmentStatus: FULFILLMENT_STATUS.NEEDS_ADMIN_REVIEW,
            fulfillmentFailureClass: failureClass,
            needsAdminReviewReason: reviewReason,
            lastProvisioningError: reviewReason,
            lastProvisioningAttemptAt: now,
            provisioningAttemptCount: Number(purchase.provisioningAttemptCount || 0) + 1,
            workerLeaseKey: null,
            workerLeaseExpiresAt: null,
            lastStateOwner: "worker"
        });

        const queueUpdate = await runQuery(
            `UPDATE fulfillmentQueue
             SET state = ?,
                 lastError = ?,
                 updatedAt = ?,
                 completedAt = ?,
                 leaseKey = NULL,
                 leaseExpiresAt = NULL
             WHERE id = ?
               AND state = ?
               AND leaseKey = ?`,
            [
                FULFILLMENT_QUEUE_STATE.NEEDS_ADMIN_REVIEW,
                reviewReason,
                now,
                now,
                job.queueId,
                FULFILLMENT_QUEUE_STATE.LEASED,
                job.leaseKey
            ]
        );

        if (queueUpdate.changes === 0) {
            await rollbackTransaction();
            return false;
        }

        const purchaseUpdate = await runQuery(
            `UPDATE purchases
             SET fulfillmentStatus = ?,
                 fulfillmentFailureClass = ?,
                 needsAdminReviewReason = ?,
                 lastProvisioningError = ?,
                 lastProvisioningAttemptAt = ?,
                 provisioningAttemptCount = ?,
                 workerLeaseKey = NULL,
                 workerLeaseExpiresAt = NULL,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?
               AND workerLeaseKey = ?`,
            [
                nextPurchase.fulfillmentStatus,
                failureClass,
                reviewReason,
                reviewReason,
                now,
                nextPurchase.provisioningAttemptCount,
                now,
                nextPurchase.lastStateOwner,
                purchase.id,
                job.leaseKey
            ]
        );

        if (purchaseUpdate.changes === 0) {
            await rollbackTransaction();
            return false;
        }

        await runQuery("COMMIT");
        return true;
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
}

async function completeLeasedProvisioningJob(job, provisioningResult, routingArtifact, details = {}) {
    const now = Number(details.now || Date.now());
    const artifactJson = JSON.stringify(routingArtifact);

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getQuery(
            "SELECT * FROM purchases WHERE id = ?",
            [job.purchaseId]
        );

        if (!purchase || purchase.workerLeaseKey !== job.leaseKey) {
            await rollbackTransaction();
            return false;
        }

        const nextPurchase = mergeLifecycleState(purchase, {
            fulfillmentStatus: FULFILLMENT_STATUS.PENDING_ACTIVATION,
            pelicanUserId: provisioningResult.pelicanUserId,
            pelicanServerId: provisioningResult.pelicanServerId,
            pelicanServerIdentifier: provisioningResult.pelicanServerIdentifier,
            pelicanAllocationId: provisioningResult.pelicanAllocationId,
            pelicanUsername: provisioningResult.pelicanUsername,
            desiredRoutingArtifactJson: artifactJson,
            desiredRoutingArtifactGeneratedAt: now,
            fulfillmentFailureClass: null,
            needsAdminReviewReason: null,
            lastProvisioningError: null,
            lastProvisioningAttemptAt: now,
            provisioningAttemptCount: Number(purchase.provisioningAttemptCount || 0) + 1,
            workerLeaseKey: null,
            workerLeaseExpiresAt: null,
            lastStateOwner: "worker"
        });

        const queueUpdate = await runQuery(
            `UPDATE fulfillmentQueue
             SET state = ?,
                 lastError = NULL,
                 updatedAt = ?,
                 completedAt = ?,
                 leaseKey = NULL,
                 leaseExpiresAt = NULL
             WHERE id = ?
               AND state = ?
               AND leaseKey = ?`,
            [
                FULFILLMENT_QUEUE_STATE.COMPLETED,
                now,
                now,
                job.queueId,
                FULFILLMENT_QUEUE_STATE.LEASED,
                job.leaseKey
            ]
        );

        if (queueUpdate.changes === 0) {
            await rollbackTransaction();
            return false;
        }

        const purchaseUpdate = await runQuery(
            `UPDATE purchases
             SET fulfillmentStatus = ?,
                 fulfillmentFailureClass = NULL,
                 needsAdminReviewReason = NULL,
                 lastProvisioningError = NULL,
                 lastProvisioningAttemptAt = ?,
                 provisioningAttemptCount = ?,
                 pelicanUserId = ?,
                 pelicanServerId = ?,
                 pelicanServerIdentifier = ?,
                 pelicanAllocationId = ?,
                 pelicanUsername = ?,
                 desiredRoutingArtifactJson = ?,
                 desiredRoutingArtifactGeneratedAt = ?,
                 pelicanPasswordCiphertext = NULL,
                 pelicanPasswordIv = NULL,
                 pelicanPasswordAuthTag = NULL,
                 pelicanPasswordStoredAt = NULL,
                 workerLeaseKey = NULL,
                 workerLeaseExpiresAt = NULL,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?
               AND workerLeaseKey = ?`,
            [
                nextPurchase.fulfillmentStatus,
                now,
                nextPurchase.provisioningAttemptCount,
                nextPurchase.pelicanUserId,
                nextPurchase.pelicanServerId,
                nextPurchase.pelicanServerIdentifier,
                nextPurchase.pelicanAllocationId,
                nextPurchase.pelicanUsername,
                artifactJson,
                now,
                now,
                nextPurchase.lastStateOwner,
                purchase.id,
                job.leaseKey
            ]
        );

        if (purchaseUpdate.changes === 0) {
            await rollbackTransaction();
            return false;
        }

        const serverUpdate = await runQuery(
            `UPDATE servers
             SET status = ?,
                 allocatedAt = COALESCE(allocatedAt, ?)
             WHERE id = ?
               AND status = ?`,
            [
                SERVER_STATUS.ALLOCATED,
                now,
                purchase.serverId,
                SERVER_STATUS.HELD
            ]
        );

        if (serverUpdate.changes === 0) {
            await rollbackTransaction();
            return false;
        }

        if (purchase.stripeCustomerId && nextPurchase.pelicanUsername) {
            await runQuery(
                `INSERT INTO customerPelicanLinks
                    (stripeCustomerId, pelicanUserId, pelicanUsername, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(stripeCustomerId) DO UPDATE SET
                    pelicanUserId = excluded.pelicanUserId,
                    pelicanUsername = excluded.pelicanUsername,
                    updatedAt = excluded.updatedAt`,
                [
                    purchase.stripeCustomerId,
                    nextPurchase.pelicanUserId,
                    nextPurchase.pelicanUsername,
                    now,
                    now
                ]
            );
        }

        await runQuery("COMMIT");
        return true;
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
}

module.exports = {
    FULFILLMENT_FAILURE_CLASS,
    FULFILLMENT_QUEUE_STATE,
    FULFILLMENT_TASK_TYPE,
    buildProvisioningPayload,
    buildProvisioningIdempotencyKey,
    completeLeasedProvisioningJob,
    enqueueProvisioningJobForPurchase,
    leaseNextFulfillmentJob,
    moveLeasedJobToAdminReview
};
