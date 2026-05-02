const config = require("../config");
const { createStripeClient } = require("../lib/stripeClient");
const { markPurchasePaid, expirePurchase, syncPurchaseSubscription, getStripeObjectId } = require("../services/purchases");

const stripe = createStripeClient(config.stripeSecretKey, config.stripeApiVersion);

function getStripeEventObject(event) {
    const object = event?.data?.object;

    if (!object || typeof object !== "object" || Array.isArray(object)) {
        console.warn("Stripe webhook event ignored because data.object was not usable.", {
            eventId: event?.id || null,
            eventType: event?.type || null
        });
        return null;
    }

    return object;
}

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
                const session = getStripeEventObject(event);

                if (!session) {
                    break;
                }

                const subscriptionId = getStripeObjectId(session.subscription);
                const subscription = subscriptionId
                    ? await stripe.subscriptions.retrieve(subscriptionId)
                    : null;
                await markPurchasePaid(session, subscription);
                break;
            }

            case "checkout.session.expired": {
                const session = getStripeEventObject(event);

                if (session) {
                    await expirePurchase(session);
                }
                break;
            }

            case "invoice.paid":
            case "invoice.payment_failed": {
                const invoice = getStripeEventObject(event);

                if (!invoice) {
                    break;
                }

                const subscriptionId = getStripeObjectId(invoice.subscription);

                if (subscriptionId) {
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    await syncPurchaseSubscription(subscription, {
                        stripeCustomerId: getStripeObjectId(invoice.customer),
                        stripePriceId: invoice.lines?.data?.[0]?.price?.id || null,
                        subscriptionDelinquentAt: event.type === "invoice.payment_failed"
                            ? Date.now()
                            : null,
                        serviceSuspendedAt: event.type === "invoice.paid"
                            ? null
                            : undefined
                    });
                }
                break;
            }

            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted": {
                const subscription = getStripeEventObject(event);

                if (subscription) {
                    await syncPurchaseSubscription(subscription);
                }
                break;
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Webhook processing failed:", err);
        res.status(500).json({ error: "Webhook processing failed" });
    }
};
