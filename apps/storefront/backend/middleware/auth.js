const config = require("../config");
const { getAdminSession } = require("../services/adminSessions");
const { parseCookies } = require("../utils/cookies");

function requireAdmin(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.adminSessionCookieName];

    if (!token) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const session = getAdminSession(token, {
        userAgent: req.headers["user-agent"]
    });

    if (!session) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.adminSession = session;
    next();
}

module.exports = requireAdmin;
