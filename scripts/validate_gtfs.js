/**
 * GTFS Basic Validation - Layer 1
 *
 * Validates:
 * 1. Existence of the six required GTFS files.
 * 2. Ability to open and read each file.
 * 3. Presence of all required header columns for each file.
 *
 * Dataset source: Mobility Database GTFS dataset (development source).
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Resolve path to data/gtfs directory relative to this script
const GTFS_DIR = process.env.GTFS_DIR || path.resolve(__dirname, "..", "data", "gtfs");

// Required GTFS files and their mandatory columns for Layer 1 validation
const REQUIRED_FILES = {
    "agency.txt": [
        "agency_id",
        "agency_name"
    ],
    "calendar.txt": [
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date"
    ],
    "routes.txt": [
        "route_id",
        "agency_id",
        "route_short_name",
        "route_long_name",
        "route_type"
    ],
    "stops.txt": [
        "stop_id",
        "stop_code",
        "stop_name",
        "stop_lat",
        "stop_lon"
    ],
    "trips.txt": [
        "route_id",
        "service_id",
        "trip_id"
    ],
    "stop_times.txt": [
        "trip_id",
        "arrival_time",
        "departure_time",
        "stop_id",
        "stop_sequence"
    ]
};

/**
 * Reads the first non-empty line of a file using streams to avoid
 * loading large files (e.g. stop_times.txt) entirely into memory.
 *
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<string>} The first line of the file.
 */
function readHeaderLine(filePath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { encoding: "utf8" });
        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        let resolved = false;

        rl.on("line", (line) => {
            const trimmed = line.replace(/^\uFEFF/, "").trim();
            if (trimmed.length > 0 && !resolved) {
                resolved = true;
                rl.close();
                stream.destroy();
                resolve(trimmed);
            }
        });

        rl.on("close", () => {
            if (!resolved) {
                reject(new Error("File is empty (no header line found)"));
            }
        });

        rl.on("error", (err) => {
            if (!resolved) {
                resolved = true;
                reject(err);
            }
        });

        stream.on("error", (err) => {
            if (!resolved) {
                resolved = true;
                reject(err);
            }
        });
    });
}

/**
 * Parses a CSV header line into an array of cleaned column names.
 *
 * @param {string} headerLine - Raw CSV header string.
 * @returns {string[]} Array of normalized column names.
 */
function parseHeaders(headerLine) {
    return headerLine
        .split(",")
        .map((col) => col.trim().replace(/^["']|["']$/g, "").trim());
}

/**
 * Runs Layer 1 validation across all required GTFS files.
 */
async function validateGTFS() {
    console.log("========================================");
    console.log("  GTFS Basic Validation - Layer 1");
    console.log("========================================");
    console.log(`GTFS Directory: ${GTFS_DIR}\n`);

    if (!fs.existsSync(GTFS_DIR)) {
        console.error(`[FAIL] GTFS directory does not exist: ${GTFS_DIR}`);
        process.exit(1);
    }

    let hasErrors = false;
    const fileEntries = Object.entries(REQUIRED_FILES);

    for (const [filename, requiredColumns] of fileEntries) {
        const filePath = path.join(GTFS_DIR, filename);

        // 1. Check file existence
        if (!fs.existsSync(filePath)) {
            console.error(`[FAIL] ${filename}: File does not exist at ${filePath}`);
            hasErrors = true;
            continue;
        }

        // 2. Check file readability & read header
        let headerLine = "";
        try {
            headerLine = await readHeaderLine(filePath);
        } catch (err) {
            console.error(`[FAIL] ${filename}: Unable to read file - ${err.message}`);
            hasErrors = true;
            continue;
        }

        // 3. Parse headers and verify required columns
        const actualHeaders = parseHeaders(headerLine);
        const missingColumns = requiredColumns.filter(
            (col) => !actualHeaders.includes(col)
        );

        if (missingColumns.length > 0) {
            console.error(
                `[FAIL] ${filename}: Missing required header(s): ${missingColumns.join(", ")}`
            );
            console.error(`       Found headers: ${actualHeaders.join(", ")}`);
            hasErrors = true;
        } else {
            console.log(`[PASS] ${filename}: Exists, readable, all ${requiredColumns.length} required headers present.`);
        }
    }

    console.log("\n----------------------------------------");
    if (hasErrors) {
        console.error("Validation FAILED: One or more GTFS files failed Layer 1 validation.");
        process.exit(1);
    } else {
        console.log("Validation PASSED: All 6 GTFS files exist, are readable, and have required headers.");
        process.exit(0);
    }
}

validateGTFS();
