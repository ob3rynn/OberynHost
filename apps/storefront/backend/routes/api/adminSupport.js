const express = require("express");

const requireAdmin = require("../../middleware/auth");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { getQuery } = require("../../db/queries");
const { sanitizePurchaseForSnapshot } = require("../../services/supportContext");
const {
    enqueueSupportTicketAdminReplyEmail,
    EMAIL_KIND
} = require("../../services/emailOutbox");
const {
    getCreationSnapshot,
    getSupportTicketById,
    listSupportTicketEvents,
    listSupportTickets,
    recordTicketEvent,
    updateSupportTicketClassification,
    updateSupportTicketStatus
} = require("../../services/supportTickets");
const {
    SUPPORT_TICKET_STATUS,
    normalizeSupportStatus
} = require("../../support/taxonomy");

const router = express.Router();
const adminSupportLimiter = createRateLimiter({
    windowMs: 1000 * 60,
    max: 80,
    message: "Too many admin support requests. Please slow down."
});

function normalizeText(value, maxLength = 5000) {
    const text = typeof value === "string" ? value.trim() : "";

    if (text.length > maxLength) {
        throw new Error(`Value must be ${maxLength} characters or fewer.`);
    }

    return text;
}

async function loadCurrentPurchaseSnapshot(purchaseId) {
    if (!purchaseId) {
        return null;
    }

    const purchase = await getQuery(
        `SELECT
            p.*,
            s.status AS serverStatus,
            s.type AS serverType,
            s.price AS serverPrice,
            COALESCE(p.planType, s.type) AS planType
         FROM purchases p
         LEFT JOIN servers s ON s.id = p.serverId
         WHERE p.id = ?`,
        [purchaseId]
    );

    return sanitizePurchaseForSnapshot(purchase);
}

async function serializeTicketDetail(ticket) {
    const events = await listSupportTicketEvents(ticket.id);
    const creationSnapshot = await getCreationSnapshot(ticket.id);
    const currentPurchase = await loadCurrentPurchaseSnapshot(ticket.purchaseId);

    return {
        ticket,
        events,
        creationSnapshot,
        currentPurchase
    };
}

router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});
router.use(adminSupportLimiter);
router.use(requireAdmin);

router.get("/admin/support/tickets", async (req, res) => {
    try {
        const status = typeof req.query?.status === "string" && req.query.status
            ? req.query.status
            : "";
        const tickets = await listSupportTickets({ status });

        return res.json({ tickets });
    } catch (err) {
        console.error("Admin support list failed:", err);
        return res.status(500).json({ error: "Could not load support tickets" });
    }
});

router.get("/admin/support/tickets/:ticketId", async (req, res) => {
    const ticketId = Number(req.params.ticketId);

    if (!Number.isInteger(ticketId) || ticketId <= 0) {
        return res.status(400).json({ error: "Invalid ticket id" });
    }

    try {
        const ticket = await getSupportTicketById(ticketId);

        if (!ticket) {
            return res.status(404).json({ error: "Ticket not found" });
        }

        return res.json(await serializeTicketDetail(ticket));
    } catch (err) {
        console.error("Admin support detail failed:", err);
        return res.status(500).json({ error: "Could not load support ticket" });
    }
});

router.post("/admin/support/tickets/:ticketId/events", async (req, res) => {
    const ticketId = Number(req.params.ticketId);

    if (!Number.isInteger(ticketId) || ticketId <= 0) {
        return res.status(400).json({ error: "Invalid ticket id" });
    }

    try {
        const ticket = await getSupportTicketById(ticketId);

        if (!ticket) {
            return res.status(404).json({ error: "Ticket not found" });
        }

        const eventType = normalizeText(req.body?.eventType, 80) || "internal_note";
        const body = normalizeText(req.body?.body, 5000);

        if (eventType === "reply" && !body) {
            return res.status(400).json({ error: "Reply body is required." });
        }

        if (eventType === "reply") {
            await recordTicketEvent(ticket.id, "admin_reply", "admin", body, {
                emailed: true
            });
            const updatedTicket = await updateSupportTicketStatus(
                ticket.id,
                SUPPORT_TICKET_STATUS.REPLIED,
                "admin",
                "Admin reply sent."
            );
            await enqueueSupportTicketAdminReplyEmail(updatedTicket, body);
            return res.status(201).json(await serializeTicketDetail(updatedTicket));
        }

        await recordTicketEvent(ticket.id, eventType, "admin", body, {
            emailed: false
        });
        return res.status(201).json(await serializeTicketDetail(ticket));
    } catch (err) {
        if (/characters or fewer/.test(err.message || "")) {
            return res.status(400).json({ error: err.message });
        }

        console.error("Admin support event failed:", err);
        return res.status(500).json({ error: "Could not record support event" });
    }
});

router.patch("/admin/support/tickets/:ticketId/status", async (req, res) => {
    const ticketId = Number(req.params.ticketId);

    if (!Number.isInteger(ticketId) || ticketId <= 0) {
        return res.status(400).json({ error: "Invalid ticket id" });
    }

    try {
        const ticket = await getSupportTicketById(ticketId);

        if (!ticket) {
            return res.status(404).json({ error: "Ticket not found" });
        }

        const status = normalizeSupportStatus(req.body?.status);
        const note = normalizeText(req.body?.note, 500);
        const updatedTicket = await updateSupportTicketStatus(ticket.id, status, "admin", note);

        if (
            status === SUPPORT_TICKET_STATUS.WAITING_ON_CUSTOMER &&
            req.body?.emailCustomer === true &&
            note
        ) {
            await enqueueSupportTicketAdminReplyEmail(
                updatedTicket,
                note,
                { kind: EMAIL_KIND.SUPPORT_TICKET_WAITING_ON_CUSTOMER }
            );
        }

        if (
            status === SUPPORT_TICKET_STATUS.RESOLVED &&
            req.body?.emailCustomer === true &&
            note
        ) {
            await enqueueSupportTicketAdminReplyEmail(
                updatedTicket,
                note,
                { kind: EMAIL_KIND.SUPPORT_TICKET_RESOLVED }
            );
        }

        return res.json(await serializeTicketDetail(updatedTicket));
    } catch (err) {
        if (/Unknown support|characters or fewer/.test(err.message || "")) {
            return res.status(400).json({ error: err.message });
        }

        console.error("Admin support status failed:", err);
        return res.status(500).json({ error: "Could not update support ticket status" });
    }
});

router.patch("/admin/support/tickets/:ticketId/classification", async (req, res) => {
    const ticketId = Number(req.params.ticketId);

    if (!Number.isInteger(ticketId) || ticketId <= 0) {
        return res.status(400).json({ error: "Invalid ticket id" });
    }

    try {
        const ticket = await getSupportTicketById(ticketId);

        if (!ticket) {
            return res.status(404).json({ error: "Ticket not found" });
        }

        const updatedTicket = await updateSupportTicketClassification(
            ticket.id,
            {
                scopeClassification: req.body?.scopeClassification,
                priority: req.body?.priority,
                humanRequired: req.body?.humanRequired === true,
                escalationReason: req.body?.escalationReason
            },
            "admin",
            normalizeText(req.body?.note, 500)
        );

        return res.json(await serializeTicketDetail(updatedTicket));
    } catch (err) {
        if (/Unknown support|characters or fewer/.test(err.message || "")) {
            return res.status(400).json({ error: err.message });
        }

        console.error("Admin support classification failed:", err);
        return res.status(500).json({ error: "Could not update support ticket classification" });
    }
});

module.exports = router;
