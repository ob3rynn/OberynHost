function centsToAmount(unitAmount) {
    const number = Number(unitAmount);
    return Number.isInteger(number) ? number / 100 : null;
}

function serializeStripePrice(price) {
    if (!price || typeof price !== "object") {
        return null;
    }

    return {
        id: price.id,
        active: Boolean(price.active),
        currency: String(price.currency || "").toLowerCase(),
        unitAmount: Number.isInteger(price.unit_amount) ? price.unit_amount : null,
        amount: centsToAmount(price.unit_amount),
        recurringInterval: price.recurring?.interval || null,
        recurringIntervalCount: price.recurring?.interval_count || null,
        type: price.type || null,
        productId: typeof price.product === "string" ? price.product : price.product?.id || null,
        productName: typeof price.product === "object" ? price.product?.name || null : null
    };
}

async function validateStripePriceId(stripe, priceId, options = {}) {
    const expectedCurrency = String(options.currency || "usd").toLowerCase();
    const requireRecurring = options.requireRecurring !== false;
    const errors = [];

    if (!priceId || typeof priceId !== "string" || !priceId.trim()) {
        return {
            valid: false,
            errors: ["Stripe price ID is required."],
            metadata: null
        };
    }

    let price;

    try {
        price = await stripe.prices.retrieve(priceId.trim(), {
            expand: ["product"]
        });
    } catch {
        return {
            valid: false,
            errors: ["Stripe price ID could not be found."],
            metadata: null
        };
    }

    const metadata = serializeStripePrice(price);

    if (!metadata?.active) {
        errors.push("Stripe price must be active.");
    }

    if (metadata?.currency !== expectedCurrency) {
        errors.push(`Stripe price currency must be ${expectedCurrency}.`);
    }

    if (requireRecurring && (!metadata?.recurringInterval || metadata.type !== "recurring")) {
        errors.push("Stripe price must be recurring.");
    }

    return {
        valid: errors.length === 0,
        errors,
        metadata
    };
}

module.exports = {
    serializeStripePrice,
    validateStripePriceId
};
