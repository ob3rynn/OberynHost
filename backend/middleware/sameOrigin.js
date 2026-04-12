const config = require("../config");

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

module.exports = function requireSameOrigin(req, res, next) {
    if (!STATE_CHANGING_METHODS.has(req.method)) {
        return next();
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const allowedOrigins = new Set(config.allowedOrigins);

    if (origin && !allowedOrigins.has(origin)) {
        return res.status(403).json({ error: "Cross-origin requests are not allowed" });
    }

    if (referer) {
        try {
            const refererOrigin = new URL(referer).origin;

            if (!allowedOrigins.has(refererOrigin)) {
                return res.status(403).json({ error: "Cross-origin requests are not allowed" });
            }
        } catch {
            return res.status(403).json({ error: "Cross-origin requests are not allowed" });
        }
    }

    next();
};
