const config = require("../config");

const RESERVED_HOSTNAME_SLUGS = new Set([
    "admin",
    "api",
    "billing",
    "mail",
    "minecraft",
    "node",
    "panel",
    "status",
    "support",
    "www"
]);

function normalizeHostnameSlug(value) {
    const slug = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");

    return slug.slice(0, 48);
}

function buildCustomerHostname(slug) {
    const normalizedSlug = normalizeHostnameSlug(slug);

    if (!normalizedSlug) {
        return "";
    }

    return `${normalizedSlug}.${config.customerHostnameRootDomain}`;
}

function validateCustomerHostnameSlug(slug) {
    const normalizedSlug = normalizeHostnameSlug(slug);

    if (!normalizedSlug || normalizedSlug.length < 3) {
        return {
            ok: false,
            slug: normalizedSlug,
            reason: "Server name must create a hostname with at least 3 letters or numbers."
        };
    }

    if (RESERVED_HOSTNAME_SLUGS.has(normalizedSlug)) {
        return {
            ok: false,
            slug: normalizedSlug,
            reason: "That server name creates a reserved hostname. Please choose a more specific server name."
        };
    }

    return {
        ok: true,
        slug: normalizedSlug,
        hostname: buildCustomerHostname(normalizedSlug)
    };
}

module.exports = {
    buildCustomerHostname,
    normalizeHostnameSlug,
    validateCustomerHostnameSlug
};
