const { getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");
const { PURCHASE_STATUS, SERVER_STATUS } = require("../constants/status");
const {
    SUBSCRIPTION_GRACE_PERIOD_MS,
    TERMINAL_SUBSCRIPTION_STATUSES,
    getPurchasePolicyState
} = require("./policyRules");
const { mergeLifecycleState } = require("./lifecycle");

async function recordLifecycleAuditAction(
    purchaseId,
    actionType,
    note = "",
    details = null,
    options = {}
) {
    await runQuery(
        `INSERT INTO adminAuditLog
            (purchaseId, actionType, note, detailsJson, userAgent, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            purchaseId,
            actionType,
            note || "",
            details ? JSON.stringify(details) : null,
            options.userAgent || "worker/lifecycle",
            Number(options.now || Date.now())
        ]
    );
}

async function suspendNextPurchasePastGrace(options = {}) {
    const now = Number(options.now || Date.now());
    const suspensionThreshold = now - SUBSCRIPTION_GRACE_PERIOD_MS;
    const recordAuditAction = options.recordAuditAction || recordLifecycleAuditAction;

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getQuery(
            `SELECT
                p.*,
                s.status AS serverStatus
             FROM purchases p
             JOIN servers s ON s.id = p.serverId
             WHERE p.status = ?
               AND s.status = ?
               AND p.subscriptionDelinquentAt IS NOT NULL
               AND p.subscriptionDelinquentAt <= ?
               AND p.serviceSuspendedAt IS NULL
               AND (
                    p.stripeSubscriptionStatus IS NULL OR
                    p.stripeSubscriptionStatus NOT IN (?, ?, ?)
               )
             ORDER BY p.subscriptionDelinquentAt ASC, p.id ASC
             LIMIT 1`,
            [
                PURCHASE_STATUS.COMPLETED,
                SERVER_STATUS.ALLOCATED,
                suspensionThreshold,
                ...Array.from(TERMINAL_SUBSCRIPTION_STATUSES)
            ]
        );

        if (!purchase) {
            await rollbackTransaction();
            return null;
        }

        const policy = getPurchasePolicyState(purchase, now);

        if (!policy.suspensionRequired) {
            await rollbackTransaction();
            return null;
        }

        const nextPurchase = mergeLifecycleState(purchase, {
            serviceSuspendedAt: now,
            lastStateOwner: "worker"
        });

        const purchaseUpdate = await runQuery(
            `UPDATE purchases
             SET serviceSuspendedAt = ?,
                 setupStatus = ?,
                 fulfillmentStatus = ?,
                 serviceStatus = ?,
                 customerRiskStatus = ?,
                 updatedAt = ?,
                 lastStateOwner = ?
             WHERE id = ?
               AND status = ?
               AND serviceSuspendedAt IS NULL`,
            [
                nextPurchase.serviceSuspendedAt,
                nextPurchase.setupStatus,
                nextPurchase.fulfillmentStatus,
                nextPurchase.serviceStatus,
                nextPurchase.customerRiskStatus,
                now,
                nextPurchase.lastStateOwner,
                purchase.id,
                PURCHASE_STATUS.COMPLETED
            ]
        );

        if (purchaseUpdate.changes === 0) {
            await rollbackTransaction();
            return null;
        }

        const serverUpdate = await runQuery(
            `UPDATE servers
             SET status = ?
             WHERE id = ?
               AND status = ?`,
            [
                SERVER_STATUS.HELD,
                purchase.serverId,
                SERVER_STATUS.ALLOCATED
            ]
        );

        if (serverUpdate.changes === 0) {
            await rollbackTransaction();
            return null;
        }

        await recordAuditAction(
            purchase.id,
            "worker_suspend_for_nonpayment",
            "Grace period expired; service was suspended automatically.",
            {
                fromServerStatus: purchase.serverStatus,
                toServerStatus: SERVER_STATUS.HELD,
                delinquentAt: Number(purchase.subscriptionDelinquentAt || 0) || null,
                gracePeriodEndsAt: policy.gracePeriodEndsAt || null,
                serviceSuspendedAt: nextPurchase.serviceSuspendedAt
            },
            { now }
        );

        await runQuery("COMMIT");

        return {
            outcome: "suspended_for_nonpayment",
            purchaseId: purchase.id,
            serverId: purchase.serverId,
            serviceSuspendedAt: nextPurchase.serviceSuspendedAt
        };
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
}

module.exports = {
    recordLifecycleAuditAction,
    suspendNextPurchasePastGrace
};
