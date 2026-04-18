const express = require("express");
const path = require("path");
const config = require("../config");
const { parseCookies, serializeCookie } = require("../utils/cookies");
const { generateOpaqueToken, isOpaqueToken } = require("../utils/tokens");

const router = express.Router();

function ensureBrowserSession(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    const existingSession = typeof cookies[config.browserSessionCookieName] === "string"
        ? cookies[config.browserSessionCookieName].trim()
        : "";

    if (isOpaqueToken(existingSession)) {
        return;
    }

    res.append("Set-Cookie", serializeCookie(config.browserSessionCookieName, generateOpaqueToken(), {
        httpOnly: true,
        maxAgeMs: 1000 * 60 * 60 * 24 * 30,
        path: "/",
        priority: "High",
        sameSite: "Lax",
        secure: config.secureCookies
    }));
}

router.get("/", (req, res) => {
    ensureBrowserSession(req, res);
    res.sendFile(path.join(__dirname, "../../frontend/index.html"));
});

router.get("/pricing", (req, res) => {
    ensureBrowserSession(req, res);
    res.sendFile(path.join(__dirname, "../../frontend/pricing.html"));
});

router.get("/support", (req, res) => {
    ensureBrowserSession(req, res);
    res.sendFile(path.join(__dirname, "../../frontend/support.html"));
});

router.get("/billing", (req, res) => {
    ensureBrowserSession(req, res);
    res.sendFile(path.join(__dirname, "../../frontend/billing.html"));
});

router.get("/guidelines", (req, res) => {
    ensureBrowserSession(req, res);
    res.sendFile(path.join(__dirname, "../../frontend/guidelines.html"));
});

router.get("/success", (req, res) => {
    ensureBrowserSession(req, res);
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "../../frontend/success.html"));
});

router.get("/admin", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "../../frontend/admin.html"));
});

router.get("/admin.html", (req, res) => {
    return res.status(403).send("Forbidden");
});

module.exports = router;
