const ENCODED_CRLF_PATTERN = /%0[dD]|%0[aA]/;
const RAW_CRLF_PATTERN = /[\r\n]/;

function hasEmailHeaderInjection(value) {
    const text = String(value || "");
    return RAW_CRLF_PATTERN.test(text) || ENCODED_CRLF_PATTERN.test(text);
}

function assertEmailHeaderSafe(value, label = "Email") {
    if (hasEmailHeaderInjection(value)) {
        throw new Error(`${label} must not contain line breaks or encoded line breaks.`);
    }

    return String(value || "").trim();
}

module.exports = {
    assertEmailHeaderSafe,
    hasEmailHeaderInjection
};
