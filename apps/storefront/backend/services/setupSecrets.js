const crypto = require("crypto");

const config = require("../config");

function getCipherKey() {
    return crypto.createHash("sha256")
        .update(String(config.setupSecretKey || config.adminKey || ""))
        .digest();
}

function encryptSetupSecret(value) {
    const plaintext = String(value || "");

    if (!plaintext) {
        return null;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getCipherKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final()
    ]);

    return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64")
    };
}

function decryptSetupSecret(secretEnvelope) {
    if (
        !secretEnvelope ||
        !secretEnvelope.ciphertext ||
        !secretEnvelope.iv ||
        !secretEnvelope.authTag
    ) {
        return "";
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getCipherKey(),
        Buffer.from(secretEnvelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(secretEnvelope.authTag, "base64"));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(secretEnvelope.ciphertext, "base64")),
        decipher.final()
    ]);

    return plaintext.toString("utf8");
}

module.exports = {
    decryptSetupSecret,
    encryptSetupSecret
};
