const PURCHASE_STATUS = {
    CHECKOUT_PENDING: "checkout_pending",
    PAID: "paid",
    COMPLETED: "completed",
    EXPIRED: "expired",
    CANCELLED: "cancelled"
};

const SERVER_STATUS = {
    AVAILABLE: "available",
    HELD: "held",
    ALLOCATED: "allocated"
};

module.exports = {
    PURCHASE_STATUS,
    SERVER_STATUS
};