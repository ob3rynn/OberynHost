const express = require("express");

const config = require("../../config");
const { PURCHASE_STATUS } = require("../../constants/status");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { createStripeClient } = require("../../lib/stripeClient");
const { getQuery } = require("../../db/queries");
const { assertEmailHeaderSafe } = require("../../utils/emailSafety");
const {
    enqueueReadyEmailResendForPurchase,
    enqueueSupportTicketReceivedEmail
} = require("../../services/emailOutbox");
const {
    getSetupTokenFromRequest,
    isReadyForCustomerAccess,
    loadVerifiedSupportContext
} = require("../../services/supportContext");
const { createSupportTicket } = require("../../services/supportTickets");

const router = express.Router();
const stripe = createStripeClient(config.stripeSecretKey, config.stripeApiVersion);
const READY_RESEND_COOLDOWN_MS = 1000 * 60 * 60;

function supportLimiter(windowMs, max, message) {
    return createRateLimiter({
        windowMs,
        max,
        message,
        keyGenerator: req => {
            const setupToken = getSetupTokenFromRequest(req);
            return setupToken || req.ip || req.socket.remoteAddress || "unknown";
        }
    });
}

const contextLimiter = supportLimiter(
    1000 * 60,
    30,
    "Too many support context checks. Please wait a moment."
);
const ticketLimiter = supportLimiter(
    1000 * 60,
    config.support.ticketRateLimitPerMinute,
    "Too many support ticket attempts. Please wait a moment."
);
const readyResendLimiter = supportLimiter(
    1000 * 60 * 60,
    config.support.readyEmailResendRateLimitPerHour,
    "Too many ready email resend attempts. Please wait before trying again."
);
const billingPortalLimiter = supportLimiter(
    1000 * 60,
    config.support.billingPortalRateLimitPerMinute,
    "Too many billing portal attempts. Please wait a moment."
);

function disabledTicketsResponse(res) {
    return res.status(503).json({
        error: "Support tickets are not enabled yet."
    });
}

async function requireVerifiedContext(req, res) {
    const context = await loadVerifiedSupportContext(req);

    if (!context.verified) {
        res.status(401).json({
            verified: false,
            reason: context.reason,
            message: "Use the verified setup or billing link for support. If you cannot access it, email support@oberynn.com for purchase-access recovery."
        });
        return null;
    }

    return context;
}

router.post("/support/context", contextLimiter, async (req, res) => {
    try {
        const context = await loadVerifiedSupportContext(req);

        if (!context.verified) {
            return res.json({
                verified: false,
                reason: context.reason,
                mailto: "support@oberynn.com",
                message: "Verified customer support opens from your setup or billing link. For purchase-access recovery, email support@oberynn.com."
            });
        }

        return res.json(context.publicContext);
    } catch (err) {
        console.error("Support context lookup failed:", err);
        return res.status(500).json({ error: "Could not load support context" });
    }
});

router.post("/support/tickets", ticketLimiter, async (req, res) => {
    if (!config.support.ticketsEnabled) {
        return disabledTicketsResponse(res);
    }

    try {
        const context = await requireVerifiedContext(req, res);

        if (!context) {
            return;
        }

        const submittedEmail = typeof req.body?.email === "string"
            ? req.body.email.trim().toLowerCase()
            : "";
        const contextEmail = String(context.email || "").trim().toLowerCase();

        if (contextEmail && submittedEmail && submittedEmail !== contextEmail) {
            return res.status(403).json({
                error: "Support ticket email must match the verified purchase email."
            });
        }

        const ticketResult = await createSupportTicket(req.body || {}, context);

        if (config.support.emailAckEnabled) {
            await enqueueSupportTicketReceivedEmail(
                ticketResult.ticket,
                ticketResult.recommendation
            );
        }

        return res.status(201).json({
            success: true,
            ticket: {
                publicRef: ticketResult.ticket.publicRef,
                status: ticketResult.ticket.status,
                category: ticketResult.ticket.category,
                scopeClassification: ticketResult.ticket.scopeClassification,
                priority: ticketResult.ticket.priority,
                humanRequired: ticketResult.ticket.humanRequired
            },
            guidance: ticketResult.recommendation.customerGuidance
        });
    } catch (err) {
        if (/required|Unknown support|characters or fewer/.test(err.message || "")) {
            return res.status(400).json({ error: err.message });
        }

        console.error("Support ticket creation failed:", err);
        return res.status(500).json({ error: "Could not create support ticket" });
    }
});

router.post("/support/resend-ready-email", readyResendLimiter, async (req, res) => {
    try {
        const context = await requireVerifiedContext(req, res);

        if (!context) {
            return;
        }

        const purchase = context.purchase;

        if (!isReadyForCustomerAccess(purchase)) {
            return res.status(409).json({
                error: "Ready-access email can only be resent for verified ready services with customer-facing access details."
            });
        }

        const recipientEmail = assertEmailHeaderSafe(purchase.email, "Customer email");

        if (!recipientEmail) {
            return res.status(409).json({ error: "This service does not have a customer email on file." });
        }

        const now = Date.now();
        const recentResend = await getQuery(
            `SELECT createdAt
             FROM emailOutbox
             WHERE purchaseId = ?
               AND kind = 'ready_access_resend'
             ORDER BY createdAt DESC, id DESC
             LIMIT 1`,
            [purchase.id]
        );

        if (
            recentResend?.createdAt &&
            now - Number(recentResend.createdAt) < READY_RESEND_COOLDOWN_MS
        ) {
            return res.status(429).json({
                error: "The ready-access email was resent recently. Please wait before requesting another copy."
            });
        }

        const message = await enqueueReadyEmailResendForPurchase(purchase, { now });

        return res.json({
            success: true,
            idempotencyKey: message.idempotencyKey,
            message: "Ready-access email queued."
        });
    } catch (err) {
        console.error("Ready email resend failed:", err);
        return res.status(500).json({ error: "Could not resend the ready-access email" });
    }
});

router.post("/support/billing-portal-session", billingPortalLimiter, async (req, res) => {
    if (!config.stripeBillingPortalConfigurationId) {
        return res.status(503).json({
            error: "Billing management is not configured yet."
        });
    }

    try {
        const context = await requireVerifiedContext(req, res);

        if (!context) {
            return;
        }

        const purchase = context.purchase;

        if (
            purchase.status !== PURCHASE_STATUS.PAID &&
            purchase.status !== PURCHASE_STATUS.COMPLETED
        ) {
            return res.status(409).json({
                error: "Billing management is available after payment is confirmed."
            });
        }

        if (!purchase.stripeCustomerId) {
            return res.status(409).json({
                error: "This order is not linked to a Stripe customer yet."
            });
        }

        const portalSession = await stripe.billingPortal.sessions.create({
            customer: purchase.stripeCustomerId,
            configuration: config.stripeBillingPortalConfigurationId,
            return_url: `${config.baseUrl}/support`
        });

        if (!portalSession?.url) {
            throw new Error("Stripe did not return a billing portal URL");
        }

        return res.json({ url: portalSession.url });
    } catch (err) {
        console.error("Support billing portal session creation failed:", err);
        return res.status(500).json({ error: "Could not open billing management" });
    }
});

module.exports = router;
