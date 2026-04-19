const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const dotenv = require("dotenv");

const projectRoot = path.join(__dirname, "..");
const envPath = path.join(projectRoot, ".env");

// This helper is intentionally dev-only. It can read backend/.env for BASE_URL so
// the backend runtime itself does not need to load dotenv at startup.
const parsedEnv = fs.existsSync(envPath)
    ? dotenv.parse(fs.readFileSync(envPath))
    : {};

const baseUrl = (process.env.BASE_URL || parsedEnv.BASE_URL || "").trim();

if (!baseUrl) {
    console.error("BASE_URL must be available through the environment or backend/.env to start local Stripe forwarding.");
    console.error("This helper is development-only. The backend runtime does not read backend/.env at startup.");
    process.exit(1);
}

let webhookUrl;

try {
    webhookUrl = new URL("/api/stripe/webhook", baseUrl).toString();
} catch {
    console.error("BASE_URL must be a valid absolute URL.");
    process.exit(1);
}

const useWatchMode = process.argv.includes("--watch");
const configuredStripeBin = (process.env.STRIPE_CLI_BIN || "").trim();
const stripeArgs = [
    "listen",
    "--events",
    [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.expired",
        "invoice.paid",
        "invoice.payment_failed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted"
    ].join(","),
    "--forward-to",
    webhookUrl
];

let serverProcess = null;
let stripeSecret = "";
let shuttingDown = false;

function resolveStripeCommand() {
    if (configuredStripeBin) {
        return configuredStripeBin;
    }

    const lookup = spawnSync(
        "sh",
        ["-lc", "command -v stripe"],
        { encoding: "utf8" }
    );

    const resolved = (lookup.stdout || "").trim();

    return resolved || "stripe";
}

function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGINT");
    }

    if (stripeProcess && !stripeProcess.killed) {
        stripeProcess.kill("SIGINT");
    }

    setTimeout(() => process.exit(code), 100);
}

function startServer() {
    if (serverProcess || !stripeSecret) return;

    const nodeArgs = [];

    if (useWatchMode) {
        nodeArgs.push("--watch");
    }

    nodeArgs.push("server.js");

    serverProcess = spawn(process.execPath, nodeArgs, {
        cwd: projectRoot,
        env: {
            ...process.env,
            STRIPE_WEBHOOK_SECRET: stripeSecret
        },
        stdio: "inherit"
    });

    console.log(`Starting backend with a temporary development webhook secret for ${webhookUrl}`);

    serverProcess.on("exit", code => {
        if (!shuttingDown) {
            shutdown(code ?? 0);
        }
    });
}

function handleStripeOutput(chunk) {
    const text = chunk.toString();
    process.stdout.write(text);

    if (stripeSecret) return;

    const match = text.match(/Your webhook signing secret is (whsec_[A-Za-z0-9]+)/);

    if (match) {
        stripeSecret = match[1];
        console.log("Captured a temporary Stripe webhook signing secret from the local listener.");
        startServer();
    }
}

const stripeProcess = spawn(resolveStripeCommand(), stripeArgs, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"]
});

stripeProcess.stdout.on("data", handleStripeOutput);
stripeProcess.stderr.on("data", handleStripeOutput);

stripeProcess.on("error", err => {
    if (err.code === "ENOENT") {
        console.error("Stripe CLI is not installed or not on PATH.");
        console.error(`Run this manually once installed: stripe listen --forward-to ${webhookUrl}`);
        console.error("Use this only for local development inside the storefront devtools container.");
    } else {
        console.error("Failed to start Stripe listener:", err.message);
    }

    process.exit(1);
});

stripeProcess.on("exit", code => {
    if (!shuttingDown) {
        if (!stripeSecret) {
            console.error("Stripe listener exited before a webhook signing secret was received.");
        }

        shutdown(code ?? 1);
    }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
