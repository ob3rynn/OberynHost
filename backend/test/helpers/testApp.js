const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const net = require("net");

const BACKEND_ROOT = path.resolve(__dirname, "../..");

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

function closeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

function waitForListening(server) {
    return new Promise((resolve, reject) => {
        if (server.listening) {
            resolve();
            return;
        }

        server.once("listening", resolve);
        server.once("error", reject);
    });
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : null;

            server.close(err => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(port);
            });
        });

        server.on("error", reject);
    });
}

function clearBackendModules() {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(BACKEND_ROOT)) {
            delete require.cache[key];
        }
    }
}

function parseCookies(headers) {
    return (headers.getSetCookie ? headers.getSetCookie() : headers.get("set-cookie") ? [headers.get("set-cookie")] : [])
        .map(cookie => cookie.split(";")[0])
        .join("; ");
}

async function createTestApp(t, options = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oberynn-test-"));
    const databasePath = path.join(tempDir, "test.db");
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const envKeys = [
        "BASE_URL",
        "PORT",
        "ADMIN_KEY",
        "STRIPE_SECRET_KEY",
        "STRIPE_API_VERSION",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PRICE_2GB",
        "STRIPE_PRICE_4GB",
        "DATABASE_PATH"
    ];
    const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

    process.env.BASE_URL = baseUrl;
    process.env.PORT = String(port);
    process.env.ADMIN_KEY = options.adminKey || "test-admin-key";
    process.env.STRIPE_SECRET_KEY = options.stripeSecretKey || "sk_test_mocked";
    process.env.STRIPE_API_VERSION = options.stripeApiVersion || "2026-02-25.clover";
    process.env.STRIPE_WEBHOOK_SECRET = options.stripeWebhookSecret || "whsec_test_mocked";
    process.env.STRIPE_PRICE_2GB = options.stripePrice2GB || "price_test_2gb";
    process.env.STRIPE_PRICE_4GB = options.stripePrice4GB || "price_test_4gb";
    process.env.DATABASE_PATH = databasePath;

    const stripeState = {
        constructors: [],
        lastCreatedSessionParams: null,
        createSession: async params => ({
            id: `cs_test_${Date.now()}`,
            url: "https://checkout.stripe.test/session",
            ...options.createdSession
        }),
        retrieveSession: async id => ({
            id,
            status: "complete",
            payment_status: "paid",
            customer_details: { email: "buyer@example.com" },
            metadata: {}
        }),
        retrieveSubscription: async id => ({
            id,
            status: "active",
            cancel_at_period_end: false,
            customer: "cus_test_default",
            items: {
                data: [
                    {
                        current_period_end: Math.floor(Date.now() / 1000) + 86400,
                        price: { id: process.env.STRIPE_PRICE_2GB }
                    }
                ]
            }
        }),
        constructEvent: (body, signature) => {
            if (signature === "bad-signature") {
                throw new Error("Bad signature");
            }

            return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body));
        }
    };

    if (options.stripe) {
        Object.assign(stripeState, options.stripe);
    }

    const originalCreateSession = stripeState.createSession;
    stripeState.createSession = async params => {
        stripeState.lastCreatedSessionParams = params;
        return originalCreateSession(params);
    };

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === "stripe") {
            return class MockStripe {
                constructor(apiKey, options) {
                    stripeState.constructors.push({ apiKey, options });
                    return {
                        checkout: {
                            sessions: {
                                create: params => stripeState.createSession(params),
                                retrieve: id => stripeState.retrieveSession(id)
                            }
                        },
                        subscriptions: {
                            retrieve: id => stripeState.retrieveSubscription(id)
                        },
                        webhooks: {
                            constructEvent: (body, signature, secret) =>
                                stripeState.constructEvent(body, signature, secret)
                        }
                    };
                }
            };
        }

        return originalLoad(request, parent, isMain);
    };

    clearBackendModules();

    let server;
    let db;

    try {
        const app = require(path.join(BACKEND_ROOT, "server"));
        await require(path.join(BACKEND_ROOT, "db/init"));
        db = require(path.join(BACKEND_ROOT, "db"));
        server = app.listen(port, "127.0.0.1");
        await waitForListening(server);
    } finally {
        Module._load = originalLoad;
    }

    t.after(async () => {
        if (server) {
            await closeServer(server);
        }

        if (db) {
            await closeDatabase(db);
        }

        clearBackendModules();

        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    return {
        baseUrl,
        databasePath,
        stripeState,
        queries: require(path.join(BACKEND_ROOT, "db/queries")),
        async request(urlPath, options = {}) {
            const headers = new Headers(options.headers || {});

            if (!headers.has("user-agent")) {
                headers.set("user-agent", options.userAgent || "TestAgent/1.0");
            }

            const response = await fetch(`${baseUrl}${urlPath}`, {
                ...options,
                headers
            });

            return response;
        },
        getDb() {
            return db;
        },
        parseSetCookie(response) {
            return parseCookies(response.headers);
        }
    };
}

module.exports = {
    createTestApp
};
