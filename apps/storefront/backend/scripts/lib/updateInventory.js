const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const BACKEND_ROOT = path.resolve(__dirname, "../..");
const PACKAGE_JSON_PATH = path.join(BACKEND_ROOT, "package.json");

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function execFileJson(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            cwd: BACKEND_ROOT,
            env: {
                ...process.env,
                ...options.env
            },
            maxBuffer: 1024 * 1024 * 8
        }, (error, stdout, stderr) => {
            const trimmedStdout = (stdout || "").trim();
            const trimmedStderr = (stderr || "").trim();

            if (trimmedStdout) {
                try {
                    resolve(JSON.parse(trimmedStdout));
                    return;
                } catch {
                    // fall through to error handling below
                }
            }

            if (error && error.code !== 1) {
                reject(new Error(trimmedStderr || trimmedStdout || error.message));
                return;
            }

            if (!trimmedStdout) {
                resolve({});
                return;
            }

            reject(new Error(trimmedStderr || trimmedStdout || "Command did not return JSON output"));
        });
    });
}

async function getNpmOutdated() {
    const cacheRoot = fs.existsSync("/tmp") ? "/tmp" : process.cwd();
    const cacheDir = path.join(cacheRoot, "oberynn-npm-cache");

    return execFileJson("npm", ["outdated", "--json"], {
        env: {
            npm_config_cache: cacheDir
        }
    });
}

function normalizeOutdatedRecord(name, record, packageJson) {
    return {
        name,
        current: record.current || null,
        wanted: record.wanted || null,
        latest: record.latest || null,
        declared: packageJson.dependencies?.[name] || packageJson.devDependencies?.[name] || null,
        dependencyType: packageJson.dependencies?.[name]
            ? "dependencies"
            : packageJson.devDependencies?.[name]
                ? "devDependencies"
                : "unknown"
    };
}

async function buildUpdateInventory() {
    const packageJson = readJson(PACKAGE_JSON_PATH);
    const outdated = await getNpmOutdated();

    const packages = Object.entries(outdated)
        .map(([name, record]) => normalizeOutdatedRecord(name, record, packageJson))
        .sort((left, right) => left.name.localeCompare(right.name));

    return {
        generatedAt: new Date().toISOString(),
        packageCount: packages.length,
        packages
    };
}

function formatUpdateInventory(inventory) {
    const lines = [
        "Update Inventory",
        `Generated: ${inventory.generatedAt}`,
        `Packages with available updates: ${inventory.packageCount}`
    ];

    for (const entry of inventory.packages) {
        lines.push(
            `- ${entry.name}: current=${entry.current || "unknown"} declared=${entry.declared || "unknown"} wanted=${entry.wanted || "unknown"} latest=${entry.latest || "unknown"} [${entry.dependencyType}]`
        );
    }

    if (!inventory.packages.length) {
        lines.push("- none");
    }

    return lines.join("\n");
}

module.exports = {
    buildUpdateInventory,
    formatUpdateInventory
};
