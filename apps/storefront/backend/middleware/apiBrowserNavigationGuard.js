function isBrowserNavigation(req) {
    const fetchMode = String(req.headers["sec-fetch-mode"] || "").toLowerCase();
    const fetchDest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
    const accept = String(req.headers.accept || "").toLowerCase();
    const hasFetchMetadata = Boolean(fetchMode || fetchDest);

    if (fetchMode === "navigate" || fetchDest === "document") {
        return true;
    }

    if (
        !hasFetchMetadata &&
        (req.method === "GET" || req.method === "HEAD") &&
        accept.includes("text/html")
    ) {
        return true;
    }

    return false;
}

module.exports = function apiBrowserNavigationGuard(req, res, next) {
    if (!isBrowserNavigation(req)) {
        return next();
    }

    return res.status(404).type("text/plain").send("Not Found");
};
