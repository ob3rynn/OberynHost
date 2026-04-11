function parseCookies(headerValue = "") {
    return headerValue
        .split(";")
        .map(part => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const separatorIndex = part.indexOf("=");

            if (separatorIndex === -1) {
                return cookies;
            }

            const name = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1).trim();

            if (!name) {
                return cookies;
            }

            try {
                cookies[name] = decodeURIComponent(value);
            } catch {
                cookies[name] = value;
            }

            return cookies;
        }, {});
}

function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];

    if (options.maxAgeMs != null) {
        parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`);
    }

    parts.push(`Path=${options.path || "/"}`);

    if (options.httpOnly !== false) {
        parts.push("HttpOnly");
    }

    if (options.sameSite) {
        parts.push(`SameSite=${options.sameSite}`);
    }

    if (options.secure) {
        parts.push("Secure");
    }

    if (options.priority) {
        parts.push(`Priority=${options.priority}`);
    }

    return parts.join("; ");
}

function clearCookie(name, options = {}) {
    return serializeCookie(name, "", {
        ...options,
        maxAgeMs: 0
    });
}

module.exports = {
    parseCookies,
    serializeCookie,
    clearCookie
};
