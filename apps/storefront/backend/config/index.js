const {
    ConfigValidationError,
    buildRuntimeConfig
} = require("./validation");

function exitConfigError(message) {
    console.error(`Configuration error: ${message}`);
    process.exit(1);
}

let config;

try {
    config = buildRuntimeConfig(process.env);
} catch (err) {
    if (err instanceof ConfigValidationError) {
        exitConfigError(err.message);
    }

    throw err;
}

module.exports = config;
