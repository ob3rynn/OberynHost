const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");

const config = require("./config");
const dbReady = require("./db/init");

const requireSameOrigin = require("./middleware/sameOrigin");
const securityHeaders = require("./middleware/securityHeaders");
const stripeWebhook = require("./middleware/stripeWebhook");
const frontendRoutes = require("./routes/frontend");

const plansRoutes = require("./routes/api/plans");
const checkoutRoutes = require("./routes/api/checkout");
const setupRoutes = require("./routes/api/setup");
const adminRoutes = require("./routes/api/admin");

const app = express();

app.disable("x-powered-by");
app.use(securityHeaders);

// Stripe FIRST
app.post(
    "/api/stripe/webhook",
    express.raw({ limit: "256kb", type: "application/json" }),
    stripeWebhook
);

// JSON AFTER
app.use(express.json({ limit: "10kb" }));
app.use("/api", requireSameOrigin);

// Static + frontend
app.use("/", frontendRoutes);
app.use(express.static(path.join(__dirname, "../frontend")));

// API routes
app.use("/api", plansRoutes);
app.use("/api", checkoutRoutes);
app.use("/api", setupRoutes);
app.use("/api", adminRoutes);

async function startServer() {
    await dbReady;

    return app.listen(config.port, config.host, () => {
        console.log(`Server running on ${config.baseUrl}`);
    });
}

if (require.main === module) {
    startServer().catch(err => {
        console.error("Failed to start server:", err);
        process.exit(1);
    });
}

module.exports = app;
