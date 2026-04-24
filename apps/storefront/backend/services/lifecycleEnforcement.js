const { getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");
const { PURCHASE_STATUS, SERVER_STATUS } = require("../constants/status");
const { enqueueSetupReminderEmailForPurchase, EMAIL_KIND } = require("./emailOutbox");
const {
    SUBSCRIPTION_GRACE_PERIOD_MS,
    TERMINAL_SUBSCRIPTION_STATUSES,
    getPurchasePolicyState
} = require("./policyRules");
const { mergeLifecycleState } = require("./lifecycle");

const PAID_SETUP_REMINDER_DELAY_MS = 1000 * 60 * 60 * 24;
const PAID_SETUP_ADMIN_ESCALATION_DELAY_MS = 1000 * 60 * 60 * 24 * 3;

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

async function remindNextPaidStalledPurchase(options = {}) {
    const now = Number(options.now || Date.now());
    const reminderThreshold = now - PAID_SETUP_REMINDER_DELAY_MS;
    const escalationThreshold = now - PAID_SETUP_ADMIN_ESCALATION_DELAY_MS;

    const purchase = await getQuery(
        `SELECT p.*
         FROM purchases p
         WHERE p.status = ?
           AND (p.serverName IS NULL OR TRIM(p.serverName) = '')
           AND COALESCE(p.paidAt, p.createdAt, 0) <= ?
           AND COALESCE(p.paidAt, p.createdAt, 0) > ?
           AND TRIM(COALESCE(p.email, '')) != ''
           AND NOT EXISTS (
                SELECT 1
                FROM emailOutbox eo
                WHERE eo.purchaseId = p.id
                  AND eo.kind = ?
           )
         ORDER BY COALESCE(p.paidAt, p.createdAt, 0) ASC, p.id ASC
         LIMIT 1`,
        [
            PURCHASE_STATUS.PAID,
            reminderThreshold,
            escalationThreshold,
            EMAIL_KIND.SETUP_REMINDER
        ]
    );

    if (!purchase) {
        return null;
    }

    const reminder = await enqueueSetupReminderEmailForPurchase(purchase, { now });

    return {
        outcome: "setup_reminder_queued",
        purchaseId: purchase.id,
        emailKind: reminder.kind,
        idempotencyKey: reminder.idempotencyKey
    };
}

async function escalateNextPaidStalledPurchase(options = {}) {
    const now = Number(options.now || Date.now());
    const escalationThreshold = now - PAID_SETUP_ADMIN_ESCALATION_DELAY_MS;
    const recordAuditAction = options.recordAuditAction || recordLifecycleAuditAction;

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const purchase = await getQuery(
            `SELECT p.*
             FROM purchases p
             WHERE p.status = ?
               AND (p.serverName IS NULL OR TRIM(p.serverName) = '')
               AND COALESCE(p.paidAt, p.createdAt, 0) <= ?
               AND NOT EXISTS (
                    SELECT 1
                    FROM adminAuditLog a
                    WHERE a.purchaseId = p.id
                      AND a.actionType = ?
               )
             ORDER BY COALESCE(p.paidAt, p.createdAt, 0) ASC, p.id ASC
             LIMIT 1`,
            [
                PURCHASE_STATUS.PAID,
                escalationThreshold,
                "worker_escalate_paid_stall"
            ]
        );

        if (!purchase) {
            await rollbackTransaction();
            return null;
        }

        await recordAuditAction(
            purchase.id,
            "worker_escalate_paid_stall",
            "Paid purchase has been waiting on customer setup for over 72 hours.",
            {
                paidAt: Number(purchase.paidAt || purchase.createdAt || 0) || null,
                escalatedAt: now,
                setupTokenExpiresAt: Number(purchase.setupTokenExpiresAt || 0) || null
            },
            { now }
        );

        await runQuery("COMMIT");

        return {
            outcome: "paid_setup_admin_escalation",
            purchaseId: purchase.id
        };
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
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
    PAID_SETUP_ADMIN_ESCALATION_DELAY_MS,
    PAID_SETUP_REMINDER_DELAY_MS,
    escalateNextPaidStalledPurchase,
    remindNextPaidStalledPurchase,
    recordLifecycleAuditAction,
    suspendNextPurchasePastGrace
};
