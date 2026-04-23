const { getQuery } = require("../db/queries");

async function findCustomerPelicanLinkByStripeCustomerId(stripeCustomerId) {
    const normalizedCustomerId = String(stripeCustomerId || "").trim();

    if (!normalizedCustomerId) {
        return null;
    }

    return getQuery(
        `SELECT *
         FROM customerPelicanLinks
         WHERE stripeCustomerId = ?`,
        [normalizedCustomerId]
    );
}

async function findPendingPelicanIdentityByStripeCustomerId(stripeCustomerId, options = {}) {
    const normalizedCustomerId = String(stripeCustomerId || "").trim();
    const excludedPurchaseId = Number(options.excludePurchaseId || 0);

    if (!normalizedCustomerId) {
        return null;
    }

    return getQuery(
        `SELECT id, stripeCustomerId, pelicanUsername
         FROM purchases
         WHERE id != ?
           AND stripeCustomerId = ?
           AND pelicanUsername IS NOT NULL
           AND TRIM(pelicanUsername) != ''
           AND setupStatus = 'setup_submitted'
           AND status IN ('paid', 'completed')
         ORDER BY id ASC
         LIMIT 1`,
        [excludedPurchaseId, normalizedCustomerId]
    );
}

async function findPelicanUsernameConflict(username, options = {}) {
    const normalizedUsername = String(username || "").trim();
    const normalizedCustomerId = String(options.stripeCustomerId || "").trim();
    const excludedPurchaseId = Number(options.excludePurchaseId || 0);

    if (!normalizedUsername) {
        return null;
    }

    const linkedCustomer = await getQuery(
        `SELECT stripeCustomerId, pelicanUsername
         FROM customerPelicanLinks
         WHERE pelicanUsername = ? COLLATE NOCASE
         LIMIT 1`,
        [normalizedUsername]
    );

    if (linkedCustomer && linkedCustomer.stripeCustomerId !== normalizedCustomerId) {
        return {
            source: "customer_link",
            stripeCustomerId: linkedCustomer.stripeCustomerId,
            pelicanUsername: linkedCustomer.pelicanUsername
        };
    }

    const pendingPurchase = await getQuery(
        `SELECT id, stripeCustomerId, pelicanUsername
         FROM purchases
         WHERE id != ?
           AND pelicanUsername = ? COLLATE NOCASE
           AND setupStatus = 'setup_submitted'
           AND status IN ('paid', 'completed')
         ORDER BY id ASC
         LIMIT 1`,
        [excludedPurchaseId, normalizedUsername]
    );

    if (pendingPurchase && pendingPurchase.stripeCustomerId !== normalizedCustomerId) {
        return {
            source: "pending_purchase",
            purchaseId: pendingPurchase.id,
            stripeCustomerId: pendingPurchase.stripeCustomerId,
            pelicanUsername: pendingPurchase.pelicanUsername
        };
    }

    return null;
}

module.exports = {
    findCustomerPelicanLinkByStripeCustomerId,
    findPendingPelicanIdentityByStripeCustomerId,
    findPelicanUsernameConflict
};
