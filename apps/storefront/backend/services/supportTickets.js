const { allQuery, getQuery, runQuery } = require("../db/queries");
const { rollbackTransaction } = require("../db/transactions");
const { generateOpaqueToken } = require("../utils/tokens");
const {
    SUPPORT_PRIORITY,
    SUPPORT_TICKET_STATUS,
    normalizeSupportCategory,
    normalizeSupportPriority,
    normalizeSupportScope,
    normalizeSupportStatus
} = require("../support/taxonomy");
const { buildSupportSnapshot } = require("./supportContext");
const {
    recommendSupportAction,
    serializeRuleRecommendation
} = require("./supportRules");

const PUBLIC_REF_PREFIX = "OH";
const MAX_REF_ATTEMPTS = 6;

function normalizeText(value, maxLength, fieldName) {
    const text = typeof value === "string" ? value.trim() : "";

    if (!text) {
        throw new Error(`${fieldName} is required.`);
    }

    if (text.length > maxLength) {
        throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
    }

    return text;
}

function normalizeOptionalText(value, maxLength) {
    if (value === undefined || value === null) {
        return "";
    }

    const text = String(value).trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function buildPublicRef() {
    return `${PUBLIC_REF_PREFIX}-${generateOpaqueToken().replace(/[-_]/g, "").slice(0, 6).toUpperCase()}`;
}

async function createUniquePublicRef() {
    for (let attempt = 0; attempt < MAX_REF_ATTEMPTS; attempt += 1) {
        const publicRef = buildPublicRef();
        const existing = await getQuery(
            "SELECT id FROM supportTickets WHERE publicRef = ?",
            [publicRef]
        );

        if (!existing) {
            return publicRef;
        }
    }

    throw new Error("Could not generate a unique support ticket reference.");
}

function parseJson(value, fallback = null) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function serializeTicket(row) {
    if (!row) {
        return null;
    }

    return {
        ...row,
        humanRequired: Boolean(row.humanRequired),
        ruleRecommendation: parseJson(row.ruleRecommendationJson, null)
    };
}

async function recordTicketEvent(ticketId, eventType, actorType, body = "", payload = null, options = {}) {
    const now = Number(options.now || Date.now());

    await runQuery(
        `INSERT INTO supportTicketEvents
            (ticketId, eventType, actorType, body, payloadJson, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            ticketId,
            eventType,
            actorType,
            body || "",
            payload ? JSON.stringify(payload) : null,
            now
        ]
    );
}

async function createSupportTicket(input, context, options = {}) {
    const now = Number(options.now || Date.now());
    const category = normalizeSupportCategory(input.category);
    const email = normalizeText(input.email || context.email, 320, "Email");
    const subject = normalizeText(input.subject, 140, "Subject");
    const message = normalizeText(input.message, 5000, "Message");
    const serviceReference = normalizeOptionalText(input.serviceReference, 120);
    const recommendation = recommendSupportAction(category, context);
    const ruleRecommendation = serializeRuleRecommendation(recommendation);
    const status = recommendation.defaultStatus;
    const publicRef = await createUniquePublicRef();
    const snapshot = buildSupportSnapshot(context);

    normalizeSupportStatus(status);
    normalizeSupportScope(recommendation.scopeClassification);
    normalizeSupportPriority(recommendation.priority || SUPPORT_PRIORITY.NORMAL);

    try {
        await runQuery("BEGIN IMMEDIATE TRANSACTION");

        const insertResult = await runQuery(
            `INSERT INTO supportTickets
                (
                    publicRef,
                    customerId,
                    purchaseId,
                    serviceId,
                    email,
                    subject,
                    message,
                    category,
                    scopeClassification,
                    priority,
                    humanRequired,
                    ruleRecommendationJson,
                    escalationReason,
                    status,
                    createdAt,
                    updatedAt
                )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                publicRef,
                null,
                context.purchaseId || null,
                serviceReference || null,
                email,
                subject,
                message,
                category,
                recommendation.scopeClassification,
                recommendation.priority || SUPPORT_PRIORITY.NORMAL,
                recommendation.humanRequired ? 1 : 0,
                JSON.stringify(ruleRecommendation),
                recommendation.escalationReason || null,
                status,
                now,
                now
            ]
        );

        const ticketId = insertResult.lastID;

        await runQuery(
            `INSERT INTO supportTicketSnapshots
                (ticketId, snapshotType, snapshotJson, createdAt)
             VALUES (?, ?, ?, ?)`,
            [
                ticketId,
                "creation",
                JSON.stringify(snapshot),
                now
            ]
        );

        await recordTicketEvent(ticketId, "created", "customer", "", {
            category,
            status,
            serviceReference: serviceReference || null,
            ruleRecommendation
        }, { now });

        if (!recommendation.humanRequired) {
            await recordTicketEvent(ticketId, "auto_guidance_sent", "system", recommendation.customerGuidance, {
                macroId: recommendation.macroId,
                defaultStatus: status
            }, { now });
        }

        await runQuery("COMMIT");

        const ticket = await getSupportTicketById(ticketId);

        return {
            ticket,
            recommendation,
            snapshot
        };
    } catch (err) {
        await rollbackTransaction();
        throw err;
    }
}

async function getSupportTicketById(ticketId) {
    const row = await getQuery(
        "SELECT * FROM supportTickets WHERE id = ?",
        [ticketId]
    );

    return serializeTicket(row);
}

async function getSupportTicketByPublicRef(publicRef) {
    const row = await getQuery(
        "SELECT * FROM supportTickets WHERE publicRef = ?",
        [publicRef]
    );

    return serializeTicket(row);
}

async function listSupportTickets(options = {}) {
    const status = options.status ? normalizeSupportStatus(options.status) : "";
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
    const params = [];
    let where = "";

    if (status) {
        where = "WHERE status = ?";
        params.push(status);
    }

    params.push(limit);

    const rows = await allQuery(
        `SELECT *
         FROM supportTickets
         ${where}
         ORDER BY
            CASE status
                WHEN 'needs_admin' THEN 0
                WHEN 'admin_review' THEN 1
                WHEN 'replied' THEN 2
                WHEN 'waiting_on_customer' THEN 3
                WHEN 'resolved' THEN 4
                ELSE 5
            END,
            updatedAt DESC,
            id DESC
         LIMIT ?`,
        params
    );

    return rows.map(serializeTicket);
}

async function listSupportTicketEvents(ticketId) {
    const rows = await allQuery(
        `SELECT *
         FROM supportTicketEvents
         WHERE ticketId = ?
         ORDER BY createdAt ASC, id ASC`,
        [ticketId]
    );

    return rows.map(row => ({
        ...row,
        payload: parseJson(row.payloadJson, null)
    }));
}

async function getCreationSnapshot(ticketId) {
    const row = await getQuery(
        `SELECT *
         FROM supportTicketSnapshots
         WHERE ticketId = ?
           AND snapshotType = 'creation'
         ORDER BY createdAt ASC, id ASC
         LIMIT 1`,
        [ticketId]
    );

    return row ? parseJson(row.snapshotJson, null) : null;
}

async function updateSupportTicketStatus(ticketId, status, actorType, body = "", options = {}) {
    const normalizedStatus = normalizeSupportStatus(status);
    const now = Number(options.now || Date.now());
    const resolvedAt = [
        SUPPORT_TICKET_STATUS.RESOLVED,
        SUPPORT_TICKET_STATUS.CLOSED_NO_RESPONSE
    ].includes(normalizedStatus)
        ? now
        : null;

    await runQuery(
        `UPDATE supportTickets
         SET status = ?,
             updatedAt = ?,
             resolvedAt = CASE WHEN ? IS NULL THEN resolvedAt ELSE ? END
         WHERE id = ?`,
        [normalizedStatus, now, resolvedAt, resolvedAt, ticketId]
    );

    await recordTicketEvent(ticketId, "status_changed", actorType, body, {
        status: normalizedStatus
    }, { now });

    return getSupportTicketById(ticketId);
}

async function updateSupportTicketClassification(ticketId, patch, actorType, body = "", options = {}) {
    const now = Number(options.now || Date.now());
    const scopeClassification = normalizeSupportScope(patch.scopeClassification);
    const priority = normalizeSupportPriority(patch.priority);
    const humanRequired = patch.humanRequired ? 1 : 0;
    const escalationReason = normalizeOptionalText(patch.escalationReason, 500) || null;

    await runQuery(
        `UPDATE supportTickets
         SET scopeClassification = ?,
             priority = ?,
             humanRequired = ?,
             escalationReason = ?,
             updatedAt = ?
         WHERE id = ?`,
        [
            scopeClassification,
            priority,
            humanRequired,
            escalationReason,
            now,
            ticketId
        ]
    );

    await recordTicketEvent(ticketId, "classification_changed", actorType, body, {
        scopeClassification,
        priority,
        humanRequired: Boolean(humanRequired),
        escalationReason
    }, { now });

    return getSupportTicketById(ticketId);
}

module.exports = {
    createSupportTicket,
    getCreationSnapshot,
    getSupportTicketById,
    getSupportTicketByPublicRef,
    listSupportTicketEvents,
    listSupportTickets,
    recordTicketEvent,
    updateSupportTicketClassification,
    updateSupportTicketStatus
};
