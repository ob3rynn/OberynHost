const assert = require("node:assert/strict");

const { assertCoreBusinessInvariants } = require("./invariants");

function createPelicanTargetsJson() {
    return JSON.stringify({
        "paper-launch-default": {
            egg: {
                byRuntimeProfile: {
                    "paper-java17": 17,
                    "paper-java21": 21,
                    "paper-java25": 25
                }
            },
            allocationIds: [9001, 9002],
            dockerImage: {
                byRuntimeProfile: {
                    "paper-java17": "ghcr.io/pelican-eggs/yolks:java_17",
                    "paper-java21": "ghcr.io/pelican-eggs/yolks:java_21",
                    "paper-java25": "ghcr.io/pelican-eggs/yolks:java_25"
                }
            },
            startup: "java -Xms128M -Xmx2024M -jar {{SERVER_JARFILE}}",
            environment: {
                SERVER_JARFILE: "server.jar",
                MINECRAFT_VERSION: "{{minecraftVersion}}",
                BUILD_NUMBER: "latest"
            },
            limits: {
                memory: 2424,
                swap: 0,
                disk: 10240,
                io: 500,
                cpu: 0,
                threads: null
            },
            featureLimits: {
                databases: 0,
                allocations: 0,
                backups: 1
            },
            skipScripts: false,
            startOnCompletion: false,
            oomKiller: true
        }
    });
}

function setupCookie(token) {
    return `setup_session=${encodeURIComponent(token)}`;
}

function browserCookie(token) {
    return `browser_session=${encodeURIComponent(token)}`;
}

function adminCookie(token) {
    return `admin_session=${encodeURIComponent(token)}`;
}

function tokenFor(prefix, id) {
    return `${prefix}_${id}_abcdefghijklmnopqrstuvwxyz123456`;
}

async function getServerCatalog(app, serverId) {
    const server = await app.queries.getQuery(
        `SELECT id, type, productCode, inventoryBucketCode, nodeGroupCode,
                provisioningTargetCode, runtimeFamily, runtimeTemplate
         FROM servers
         WHERE id = ?`,
        [serverId]
    );

    assert.ok(server, `expected seeded server ${serverId}`);
    return server;
}

async function seedPaidSetupPurchase(app, options = {}) {
    const now = options.now || Date.now();
    const serverId = options.serverId || 1;
    const server = await getServerCatalog(app, serverId);
    const setupToken = options.setupToken || tokenFor("setup_token_abuse", serverId);
    const purchaseStatus = options.status || "paid";

    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeSessionId, stripeCustomerId,
                stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd,
                stripeCancelAtPeriodEnd, stripePriceId, createdAt, setupToken,
                setupTokenExpiresAt, paidAt, planType, productCode,
                inventoryBucketCode, nodeGroupCode, provisioningTargetCode,
                runtimeFamily, runtimeTemplate, setupStatus, fulfillmentStatus,
                serviceStatus, customerRiskStatus, updatedAt, lastStateOwner
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            serverId,
            options.email || `abuse-${serverId}@example.com`,
            options.serverName || "",
            purchaseStatus,
            options.stripeSessionId || `cs_test_abuse_${serverId}`,
            options.stripeCustomerId || `cus_abuse_${serverId}`,
            options.stripeSubscriptionId || `sub_abuse_${serverId}`,
            options.stripeSubscriptionStatus || "active",
            options.stripeCurrentPeriodEnd || now + 86_400_000,
            Number(options.stripeCancelAtPeriodEnd || 0),
            options.stripePriceId || "price_test_paper_2gb",
            now,
            setupToken,
            options.setupTokenExpiresAt === undefined ? now + 86_400_000 : options.setupTokenExpiresAt,
            options.paidAt || now,
            server.type,
            server.productCode,
            server.inventoryBucketCode,
            server.nodeGroupCode,
            server.provisioningTargetCode,
            server.runtimeFamily,
            server.runtimeTemplate,
            options.setupStatus || "setup_pending",
            options.fulfillmentStatus || "not_started",
            options.serviceStatus || "inactive",
            options.customerRiskStatus || "clear",
            now,
            options.lastStateOwner || "test"
        ]
    );
    await app.queries.runQuery(
        "UPDATE servers SET status = ?, reservationKey = ?, reservedAt = ? WHERE id = ?",
        [options.serverStatus || "held", setupToken, now, serverId]
    );

    const purchase = await app.queries.getQuery(
        "SELECT * FROM purchases WHERE setupToken = ?",
        [setupToken]
    );
    return { purchase, setupToken };
}

async function seedPendingActivationPurchase(app, options = {}) {
    const now = options.now || Date.now();
    const serverId = options.serverId || 1;
    const server = await getServerCatalog(app, serverId);
    const purchaseId = options.purchaseId || 1;
    const hostnameSlug = options.hostnameReservationKey || `abuse-ready-${serverId}`;
    const hostname = options.hostname || `${hostnameSlug}.oberyn.net`;
    const pelicanServerIdentifier = options.pelicanServerIdentifier || `srv_abuse_${serverId}`;
    const pelicanAllocationId = options.pelicanAllocationId || String(9000 + serverId);
    const artifact = {
        kind: "haproxy_desired_mapping",
        version: 1,
        hostname,
        provisioningTargetCode: server.provisioningTargetCode,
        purchaseId,
        pelicanServerIdentifier,
        pelicanAllocationId,
        generatedAt: now
    };

    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                id, serverId, email, serverName, status, stripeSessionId, stripeCustomerId,
                stripeSubscriptionId, stripeSubscriptionStatus, stripeCurrentPeriodEnd,
                stripeCancelAtPeriodEnd, stripePriceId, createdAt, setupToken,
                setupTokenExpiresAt, paidAt, planType, productCode,
                inventoryBucketCode, nodeGroupCode, provisioningTargetCode,
                runtimeFamily, runtimeTemplate, setupStatus, fulfillmentStatus,
                serviceStatus, customerRiskStatus, hostname, hostnameReservationKey,
                hostnameReservedAt, minecraftVersion, runtimeProfileCode, runtimeJavaVersion,
                pelicanUserId, pelicanUsername, pelicanServerId, pelicanServerIdentifier,
                pelicanAllocationId, desiredRoutingArtifactJson,
                desiredRoutingArtifactGeneratedAt, updatedAt, lastStateOwner
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            purchaseId,
            serverId,
            options.email || `ready-${serverId}@example.com`,
            options.serverName || `Abuse Ready ${serverId}`,
            options.status || "paid",
            options.stripeSessionId || `cs_test_ready_abuse_${serverId}`,
            options.stripeCustomerId || `cus_ready_abuse_${serverId}`,
            options.stripeSubscriptionId || `sub_ready_abuse_${serverId}`,
            options.stripeSubscriptionStatus || "active",
            options.stripeCurrentPeriodEnd || now + 86_400_000,
            Number(options.stripeCancelAtPeriodEnd || 0),
            options.stripePriceId || "price_test_paper_2gb",
            now,
            options.setupToken || tokenFor("setup_token_ready_abuse", serverId),
            options.setupTokenExpiresAt || now + 86_400_000,
            options.paidAt || now,
            server.type,
            server.productCode,
            server.inventoryBucketCode,
            server.nodeGroupCode,
            server.provisioningTargetCode,
            server.runtimeFamily,
            server.runtimeTemplate,
            "setup_submitted",
            options.fulfillmentStatus || "pending_activation",
            options.serviceStatus || "inactive",
            options.customerRiskStatus || "clear",
            hostname,
            hostnameSlug,
            now,
            options.minecraftVersion || "1.21.11",
            options.runtimeProfileCode || "paper-java21",
            options.runtimeJavaVersion || 21,
            options.pelicanUserId || `pelican-user-abuse-${serverId}`,
            options.pelicanUsername || `abuse_ready_${serverId}`,
            options.pelicanServerId || `pelican-server-abuse-${serverId}`,
            pelicanServerIdentifier,
            pelicanAllocationId,
            JSON.stringify(options.desiredRoutingArtifact || artifact),
            now,
            now,
            options.lastStateOwner || "test"
        ]
    );
    await app.queries.runQuery(
        "UPDATE servers SET status = ?, allocatedAt = ? WHERE id = ?",
        [options.serverStatus || "allocated", now, serverId]
    );

    const purchase = await app.queries.getQuery("SELECT * FROM purchases WHERE id = ?", [purchaseId]);
    return { purchase };
}

async function seedCheckoutPendingPurchase(app, options = {}) {
    const now = options.now || Date.now();
    const serverId = options.serverId || 1;
    const server = await getServerCatalog(app, serverId);
    const setupToken = options.setupToken || tokenFor("setup_token_checkout_abuse", serverId);
    const browserSessionId = options.browserSessionId || tokenFor("browser_session_abuse", serverId);

    await app.queries.runQuery(
        `INSERT INTO purchases
            (
                serverId, email, serverName, status, stripeSessionId,
                browserSessionId, createdAt, setupToken, setupTokenExpiresAt,
                planType, productCode, inventoryBucketCode, nodeGroupCode,
                provisioningTargetCode, runtimeFamily, runtimeTemplate,
                setupStatus, fulfillmentStatus, serviceStatus, customerRiskStatus,
                updatedAt, lastStateOwner
            )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            serverId,
            options.email || "",
            "",
            "checkout_pending",
            options.stripeSessionId || `cs_test_checkout_abuse_${serverId}`,
            browserSessionId,
            now,
            setupToken,
            options.setupTokenExpiresAt || now + 86_400_000,
            server.type,
            server.productCode,
            server.inventoryBucketCode,
            server.nodeGroupCode,
            server.provisioningTargetCode,
            server.runtimeFamily,
            server.runtimeTemplate,
            "not_started",
            "not_started",
            "inactive",
            "clear",
            now,
            options.lastStateOwner || "test"
        ]
    );
    await app.queries.runQuery(
        "UPDATE servers SET status = ?, reservationKey = ?, reservedAt = ? WHERE id = ?",
        ["held", setupToken, now, serverId]
    );

    const purchase = await app.queries.getQuery("SELECT * FROM purchases WHERE setupToken = ?", [setupToken]);
    return { purchase, setupToken, browserSessionId };
}

async function adminLogin(app, options = {}) {
    const userAgent = options.userAgent || "AbuseAdmin/1.0";
    const response = await app.request("/api/admin/login", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: app.baseUrl,
            ...(options.cookie ? { cookie: options.cookie } : {})
        },
        body: JSON.stringify({ key: options.key || "test-admin-key" }),
        userAgent
    });

    assert.equal(response.status, 200);
    return {
        cookie: app.parseSetCookie(response),
        userAgent,
        response
    };
}

function setupStatus(app, token, options = {}) {
    const headers = {
        "content-type": "application/json",
        ...(options.noOrigin ? {} : { origin: app.baseUrl }),
        ...(options.cookie === false ? {} : { cookie: setupCookie(options.cookieToken || token) }),
        ...(options.headers || {})
    };

    return app.request("/api/setup-status", {
        method: "POST",
        headers,
        body: JSON.stringify(options.body || {}),
        userAgent: options.userAgent || "AbuseSetupStatus/1.0"
    });
}

function completeSetup(app, token, body = {}, options = {}) {
    const headers = {
        "content-type": "application/json",
        ...(options.noOrigin ? {} : { origin: app.baseUrl }),
        ...(options.cookie === false ? {} : { cookie: setupCookie(options.cookieToken || token) }),
        ...(options.headers || {})
    };

    return app.request("/api/complete-setup", {
        method: "POST",
        headers,
        body: JSON.stringify({
            serverName: "Abuse Safe Server",
            minecraftVersion: "1.21.11",
            pelicanUsername: "abuse_safe_user",
            pelicanPassword: "abuse-safe-password",
            ...body
        }),
        userAgent: options.userAgent || "AbuseCompleteSetup/1.0"
    });
}

async function assertSetupPurchaseUnchanged(app, purchaseId) {
    const purchase = await app.queries.getQuery(
        `SELECT serverName, hostname, hostnameReservationKey, fulfillmentStatus,
                pelicanPasswordCiphertext, pelicanPasswordIv, pelicanPasswordAuthTag,
                pelicanPasswordStoredAt
         FROM purchases
         WHERE id = ?`,
        [purchaseId]
    );
    const jobs = await app.queries.getQuery(
        "SELECT COUNT(*) AS count FROM fulfillmentQueue WHERE purchaseId = ?",
        [purchaseId]
    );

    assert.ok(purchase);
    assert.equal(purchase.serverName || "", "");
    assert.equal(purchase.hostname, null);
    assert.equal(purchase.hostnameReservationKey, null);
    assert.equal(purchase.fulfillmentStatus, "not_started");
    assert.equal(purchase.pelicanPasswordCiphertext, null);
    assert.equal(purchase.pelicanPasswordIv, null);
    assert.equal(purchase.pelicanPasswordAuthTag, null);
    assert.equal(purchase.pelicanPasswordStoredAt, null);
    assert.equal(jobs.count, 0);
}

function hostilePayloads() {
    return [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "line\r\nBcc: victim@example.com",
        "audit\nbreak",
        "Robert'); DROP TABLE purchases;--",
        "../../admin",
        "a".repeat(700),
        "null\u0000byte",
        "аdmin"
    ];
}

module.exports = {
    adminCookie,
    adminLogin,
    assertCoreBusinessInvariants,
    assertSetupPurchaseUnchanged,
    browserCookie,
    completeSetup,
    createPelicanTargetsJson,
    hostilePayloads,
    seedCheckoutPendingPurchase,
    seedPaidSetupPurchase,
    seedPendingActivationPurchase,
    setupCookie,
    setupStatus,
    tokenFor
};
