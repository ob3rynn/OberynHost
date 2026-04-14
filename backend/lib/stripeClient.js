const Stripe = require("stripe");

function createStripeClient(secretKey, apiVersion) {
    return new Stripe(secretKey, {
        apiVersion
    });
}

module.exports = {
    createStripeClient
};
