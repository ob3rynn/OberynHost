const crypto = require("crypto");

function generateOpaqueToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function isOpaqueToken(value) {
    return typeof value === "string" &&
        value.length >= 32 &&
        value.length <= 128 &&
        /^[A-Za-z0-9_-]+$/.test(value);
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest();
}

function timingSafeEqualString(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}

module.exports = {
    generateOpaqueToken,
    isOpaqueToken,
    timingSafeEqualString
};
