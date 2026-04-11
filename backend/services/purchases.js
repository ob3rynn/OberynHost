const config = require("../config");
const { runQuery, getQuery } = require("../db/queries");
const { PURCHASE_STATUS, SERVER_STATUS } = require("../constants/status");
const { generateOpaqueToken } = require("../utils/tokens");

async function cancelPurchaseAndRelease(purchaseId, serverId) {
    if (purchaseId) {
        await runQuery(
            "UPDATE purchases SET status = ? WHERE id = ? AND status = ?",
            [PURCHASE_STATUS.CANCELLED, purchaseId, PURCHASE_STATUS.CHECKOUT_PENDING]
        );
    }

    if (serverId) {
        await runQuery(
            "UPDATE servers SET status = ? WHERE id = ? AND status = ?",
            [SERVER_STATUS.AVAILABLE, serverId, SERVER_STATUS.HELD]
        );
    }
}

async function markPurchasePaid(session) {
    const email = session.customer_details?.email || session.customer_email || "";
    const fallbackSetupToken = generateOpaqueToken();
    const setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;

    let update = await runQuery(
        `UPDATE purchases
         SET status = ?,
             email = COALESCE(NULLIF(?, ''), email),
             setupToken = COALESCE(setupToken, ?),
             setupTokenExpiresAt = ?
         WHERE stripeSessionId = ? AND status = ?`,
        [
            PURCHASE_STATUS.PAID,
            email,
            fallbackSetupToken,
            setupTokenExpiresAt,
            session.id,
            PURCHASE_STATUS.CHECKOUT_PENDING
        ]
    );

    const purchaseId = Number(session.metadata?.purchaseId);

    if (update.changes === 0 && purchaseId) {
        update = await runQuery(
            `UPDATE purchases
             SET status = ?,
                 stripeSessionId = COALESCE(stripeSessionId, ?),
                 email = COALESCE(NULLIF(?, ''), email),
                 setupToken = COALESCE(setupToken, ?),
                 setupTokenExpiresAt = ?
             WHERE id = ? AND status = ?`,
            [
                PURCHASE_STATUS.PAID,
                session.id,
                email,
                fallbackSetupToken,
                setupTokenExpiresAt,
                purchaseId,
                PURCHASE_STATUS.CHECKOUT_PENDING
            ]
        );
    }

    if (update.changes === 0) {
        await runQuery(
            `UPDATE purchases
             SET stripeSessionId = COALESCE(stripeSessionId, ?),
                 email = COALESCE(NULLIF(?, ''), email),
                 setupToken = COALESCE(setupToken, ?),
                 setupTokenExpiresAt = COALESCE(setupTokenExpiresAt, ?)
             WHERE (stripeSessionId = ? OR id = ?) AND status IN (?, ?)`,
            [
                session.id,
                email,
                fallbackSetupToken,
                setupTokenExpiresAt,
                session.id,
                purchaseId || 0,
                PURCHASE_STATUS.PAID,
                PURCHASE_STATUS.COMPLETED
            ]
        );
    }
}

async function expirePurchase(session) {
    const purchaseId = Number(session.metadata?.purchaseId);
    const purchase = await getQuery(
        "SELECT id, serverId, status FROM purchases WHERE stripeSessionId = ? OR id = ?",
        [session.id, purchaseId || 0]
    );

    if (!purchase) return;
    if (purchase.status !== PURCHASE_STATUS.CHECKOUT_PENDING) return;

    const update = await runQuery(
        "UPDATE purchases SET status = ? WHERE id = ? AND status = ?",
        [PURCHASE_STATUS.EXPIRED, purchase.id, PURCHASE_STATUS.CHECKOUT_PENDING]
    );

    if (update.changes === 0) return;

    await runQuery(
        "UPDATE servers SET status = ? WHERE id = ? AND status = ?",
        [SERVER_STATUS.AVAILABLE, purchase.serverId, SERVER_STATUS.HELD]
    );
}

module.exports = {
    cancelPurchaseAndRelease,
    markPurchasePaid,
    expirePurchase
};
