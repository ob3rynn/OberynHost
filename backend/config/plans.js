const PLAN_DEFINITIONS = {
    "2GB": {
        features: [
            "2GB RAM",
            "Paper server software",
            "Shared CPU",
            "Optimized configuration",
            "No setup required",
            "Best for small worlds"
        ]
    },
    "4GB": {
        features: [
            "4GB RAM",
            "Paper server software",
            "2 Dedicated CPU Threads",
            "Optimized configuration",
            "No setup required",
            "Better for heavier usage"
        ]
    }
};

const VALID_PLAN_TYPES = new Set(Object.keys(PLAN_DEFINITIONS));

module.exports = {
    PLAN_DEFINITIONS,
    VALID_PLAN_TYPES
};
