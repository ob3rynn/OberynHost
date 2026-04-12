const Stripe = require("stripe");
const config = require("../config");
const { markPurchasePaid, expirePurchase, syncPurchaseSubscription, getStripeObjectId } = require("../services/purchases");

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
            case "checkout.session.async_payment_succeeded": {
                const session = event.data.object;
                const subscriptionId = getStripeObjectId(session.subscription);
                const subscription = subscriptionId
                    ? await stripe.subscriptions.retrieve(subscriptionId)
                    : null;
                await markPurchasePaid(session, subscription);
                break;
            }

            case "checkout.session.expired":
                await expirePurchase(event.data.object);
                break;

            case "invoice.paid":
            case "invoice.payment_failed": {
                const invoice = event.data.object;
                const subscriptionId = getStripeObjectId(invoice.subscription);

                if (subscriptionId) {
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    await syncPurchaseSubscription(subscription, {
                        stripeCustomerId: getStripeObjectId(invoice.customer),
                        stripePriceId: invoice.lines?.data?.[0]?.price?.id || null
                    });
                }
                break;
            }

            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted":
                await syncPurchaseSubscription(event.data.object);
                break;
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Webhook processing failed:", err);
        res.status(500).json({ error: "Webhook processing failed" });
    }
};
