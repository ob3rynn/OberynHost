const config = require("../config");
const { generateOpaqueToken } = require("../utils/tokens");

const sessions = new Map();

function pruneExpiredSessions(now = Date.now()) {
    for (const [token, session] of sessions.entries()) {
        if (session.expiresAt <= now) {
            sessions.delete(token);
        }
    }
}

function createAdminSession({ userAgent }) {
    pruneExpiredSessions();

    const token = generateOpaqueToken();
    const expiresAt = Date.now() + config.adminSessionTtlMs;

    sessions.set(token, {
        userAgent: String(userAgent || ""),
        expiresAt
    });

    return {
        token,
        expiresAt
    };
}

function getAdminSession(token, { userAgent }) {
    pruneExpiredSessions();

    const session = sessions.get(token);

    if (!session) {
        return null;
    }

    if (session.userAgent !== String(userAgent || "")) {
        sessions.delete(token);
        return null;
    }

    return session;
}

function destroyAdminSession(token) {
    sessions.delete(token);
}

module.exports = {
    createAdminSession,
    getAdminSession,
    destroyAdminSession
};
