function createRateLimiter({
    windowMs,
    max,
    message = "Too many requests. Please try again later.",
    keyGenerator
}) {
    const hits = new Map();
    let callCount = 0;

    function prune(now) {
        for (const [key, entry] of hits.entries()) {
            if (entry.resetAt <= now) {
                hits.delete(key);
            }
        }
    }

    return (req, res, next) => {
        const now = Date.now();
        callCount += 1;

        if (callCount % 100 === 0) {
            prune(now);
        }

        const key = String(
            keyGenerator ? keyGenerator(req) : (req.ip || req.socket.remoteAddress || "unknown")
        );

        const existing = hits.get(key);
        const entry = !existing || existing.resetAt <= now
            ? { count: 0, resetAt: now + windowMs }
            : existing;

        entry.count += 1;
        hits.set(key, entry);

        if (entry.count > max) {
            res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({ error: message });
        }

        next();
    };
}

module.exports = {
    createRateLimiter
};
