const Stripe = require("stripe");
const config = require("../config");
const { markPurchasePaid, expirePurchase } = require("../services/purchases");

const stripe = new Stripe(config.stripeSecretKey);

module.exports = async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded":
                await markPurchasePaid(event.data.object);
                break;

            case "checkout.session.expired":
                await expirePurchase(event.data.object);
                break;
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Webhook processing failed:", err);
        res.status(500).json({ error: "Webhook processing failed" });
    }
};