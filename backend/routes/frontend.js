const express = require("express");
const path = require("path");

const router = express.Router();

router.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../../frontend/index.html"));
});

router.get("/pricing", (req, res) => {
    res.sendFile(path.join(__dirname, "../../frontend/pricing.html"));
});

router.get("/success", (req, res) => {
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
