const express = require("express");
const Stripe = require("stripe");

const config = require("../../config");
const { runQuery, getQuery } = require("../../db/queries");
const { rollbackTransaction } = require("../../db/transactions");
const { cancelPurchaseAndRelease, expirePurchase, markPurchasePaid, getStripeObjectId } = require("../../services/purchases");
const { VALID_PLAN_TYPES } = require("../../config/plans");
const { SERVER_STATUS, PURCHASE_STATUS } = require("../../constants/status");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { parseCookies, serializeCookie } = require("../../utils/cookies");
const { generateOpaqueToken, isOpaqueToken } = require("../../utils/tokens");

const stripe = new Stripe(config.stripeSecretKey);

const router = express.Router();
const checkoutLimiter = createRateLimiter({
    windowMs: 1000 * 60 * 10,
    max: 10,
    message: "Too many checkout attempts. Please wait a moment and try again."
});

function getSetupTokenFromCookie(req) {
    const cookies = parseCookies(req.headers.cookie);
    const setupToken = typeof cookies[config.setupSessionCookieName] === "string"
        ? cookies[config.setupSessionCookieName].trim()
        : "";

    return isOpaqueToken(setupToken) ? setupToken : "";
}

function isSuccessfulCheckoutSession(session) {
    return session?.status === "complete" &&
        (session?.payment_status === "paid" || session?.payment_status === "no_payment_required");
}

async function findPendingBrowserCheckout(req) {
    const setupToken = getSetupTokenFromCookie(req);

    if (!setupToken) {
        return null;
    }

    const purchase = await getQuery(
        `SELECT purchases.*, servers.type AS serverType, servers.status AS serverStatus
         FROM purchases
         JOIN servers ON servers.id = purchases.serverId
         WHERE purchases.setupToken = ?
         ORDER BY purchases.id DESC
         LIMIT 1`,
        [setupToken]
    );

    if (!purchase || purchase.status !== PURCHASE_STATUS.CHECKOUT_PENDING) {
        return null;
    }

    return purchase;
}

async function resolveExistingCheckout(req) {
    const purchase = await findPendingBrowserCheckout(req);

    if (!purchase) {
        return { kind: "none" };
    }

    if (!purchase.stripeSessionId) {
        await cancelPurchaseAndRelease(purchase.id, purchase.serverId);
        return { kind: "none" };
    }

    const session = await stripe.checkout.sessions.retrieve(purchase.stripeSessionId);

    if (!session) {
        return { kind: "none" };
    }

    if (isSuccessfulCheckoutSession(session)) {
        const subscriptionId = getStripeObjectId(session.subscription);
        const subscription = subscriptionId
            ? await stripe.subscriptions.retrieve(subscriptionId)
            : null;

        await markPurchasePaid(session, subscription);
        return {
            kind: "completed",
            purchase,
            session,
            url: `${config.baseUrl}/success`
        };
    }

    if (session.status === "expired") {
        await expirePurchase(session);
        return { kind: "none" };
    }

    if (session.status === "open" && typeof session.url === "string" && session.url) {
        return {
            kind: "open",
            purchase,
            session,
            url: session.url
        };
    }

    return { kind: "blocked", purchase, session };
}

router.get("/resume-checkout", async (req, res) => {
    try {
        const existingCheckout = await resolveExistingCheckout(req);

        if (existingCheckout.kind === "open") {
            return res.json({
                resumable: true,
                planType: existingCheckout.purchase.serverType,
                url: existingCheckout.url,
                message: `You already have a ${existingCheckout.purchase.serverType} server checkout in progress.`
            });
        }

        if (existingCheckout.kind === "completed") {
            return res.json({
                resumable: false,
                redirectUrl: existingCheckout.url
            });
        }

        return res.json({ resumable: false });
    } catch (err) {
        console.error("Resume checkout lookup failed:", err);
        return res.status(500).json({ error: "Could not check for an existing checkout" });
    }
});

router.post("/create-checkout", checkoutLimiter, async (req, res) => {
    const planType = typeof req.body?.planType === "string"
        ? req.body.planType.trim()
        : "";

    if (!VALID_PLAN_TYPES.has(planType)) {
        return res.status(400).json({ error: "Invalid plan type" });
    }

    const stripePriceId = config.stripePriceIds[planType];

    if (!stripePriceId) {
        return res.status(500).json({ error: "Stripe price is not configured for this server" });
    }

    try {
        const existingCheckout = await resolveExistingCheckout(req);

        if (existingCheckout.kind === "open") {
            if (existingCheckout.purchase.serverType !== planType) {
                return res.status(409).json({
                    error: `You already have a ${existingCheckout.purchase.serverType} server checkout in progress. Resume that checkout or wait for it to expire before choosing another server.`,
                    resumeUrl: existingCheckout.url,
                    existingPlanType: existingCheckout.purchase.serverType
                });
            }

            return res.json({
                url: existingCheckout.url,
                resumed: true,
                planType: existingCheckout.purchase.serverType
            });
        }

        if (existingCheckout.kind === "completed") {
            return res.status(409).json({
                error: "Your previous payment is already processing. Continue to setup instead.",
                redirectUrl: existingCheckout.url
            });
        }

        if (existingCheckout.kind === "blocked") {
            return res.status(409).json({
                error: "Your previous checkout is still being processed. Please finish that order or wait for it to expire."
            });
        }
    } catch (err) {
        console.error("Existing checkout lookup failed:", err);
        return res.status(500).json({ error: "Could not resume the existing checkout" });
    }

    let purchaseId = null;
    let server = null;
    const setupToken = generateOpaqueToken();
    const setupTokenExpiresAt = Date.now() + config.setupTokenTtlMs;

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        server = await getQuery(
            "SELECT id, price FROM servers WHERE type = ? AND status = ? LIMIT 1",
            [planType, SERVER_STATUS.AVAILABLE]
        );

        if (!server) {
            await rollbackTransaction();
            return res.status(400).json({ error: "No servers available" });
        }

        const reserve = await runQuery(
            "UPDATE servers SET status = ? WHERE id = ? AND status = ?",
            [SERVER_STATUS.HELD, server.id, SERVER_STATUS.AVAILABLE]
        );

        if (reserve.changes === 0) {
            await rollbackTransaction();
            return res.status(400).json({ error: "Server taken, try again" });
        }

        const purchase = await runQuery(
            `INSERT INTO purchases
                (serverId, email, serverName, status, stripeSessionId, createdAt, setupToken, setupTokenExpiresAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                server.id,
                "",
                "",
                PURCHASE_STATUS.CHECKOUT_PENDING,
                null,
                Date.now(),
                setupToken,
                setupTokenExpiresAt
            ]
        );

        purchaseId = purchase.lastID;
        await runQuery("COMMIT");
    } catch (err) {
        await rollbackTransaction();
        console.error("Failed to reserve inventory:", err);
        return res.status(500).json({ error: "Could not reserve a server" });
    }

    try {
        const successUrl = `${config.baseUrl}/success`;
        const cancelUrl = `${config.baseUrl}/pricing`;

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            payment_method_types: ["card"],
            line_items: [
                {
                    price: stripePriceId,
                    quantity: 1
                }
            ],
            metadata: {
                purchaseId: String(purchaseId),
                serverId: String(server.id),
                planType
            },
            subscription_data: {
                metadata: {
                    purchaseId: String(purchaseId),
                    serverId: String(server.id),
                    planType
                }
            },
            success_url: successUrl,
            cancel_url: cancelUrl
        });

        const link = await runQuery(
            "UPDATE purchases SET stripeSessionId = ? WHERE id = ? AND status = ? AND stripeSessionId IS NULL",
            [session.id, purchaseId, PURCHASE_STATUS.CHECKOUT_PENDING]
        );

        if (link.changes === 0) {
            throw new Error("Failed to link checkout session to purchase");
        }

        res.setHeader("Set-Cookie", serializeCookie(config.setupSessionCookieName, setupToken, {
            httpOnly: true,
            maxAgeMs: config.setupTokenTtlMs,
            path: "/",
            priority: "High",
            sameSite: "Lax",
            secure: config.secureCookies
        }));
        res.json({ url: session.url });
    } catch (err) {
        console.error("Checkout creation failed:", err);

        try {
            await cancelPurchaseAndRelease(purchaseId, server?.id);
        } catch (cleanupErr) {
            console.error("Cleanup after checkout failure failed:", cleanupErr);
        }

        return res.status(500).json({ error: "Stripe error" });
    }
});

module.exports = router;
