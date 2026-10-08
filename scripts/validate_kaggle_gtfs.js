/**
 * Kaggle GTFS Basic Validation
 *
 * READ-ONLY validator for the Kaggle GTFS dataset.
 *
 * Validates:
 * 1. Existence of the six required CSV files:
 *    - agency.csv
 *    - calendar.csv
 *    - routes.csv
 *    - stops.csv
 *    - trips.csv
 *    - stop_times.csv
 * 2. Ability to open and read each file (memory-safe streaming).
 * 3. Presence of all required header columns for each file.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Resolve Kaggle GTFS directory (handles both flat folder and nested dmrc_gtfs_dataset)
let datasetDir =
    process.argv[2] ||
    process.env.KAGGLE_GTFS_DIR ||
    path.resolve(__dirname, "..", "data", "kaggle_gtfs");

if (
    !fs.existsSync(path.join(datasetDir, "agency.csv")) &&
    fs.existsSync(path.join(datasetDir, "dmrc_gtfs_dataset", "agency.csv"))
) {
    datasetDir = path.join(datasetDir, "dmrc_gtfs_dataset");
}

// Required Kaggle GTFS files and mandatory header columns
const REQUIRED_FILES = {
    "agency.csv": [
        "agency_id",
        "agency_name"
    ],
    "calendar.csv": [
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
    "routes.csv": [
        "route_id",
        "agency_id",
        "route_short_name",
        "route_long_name",
        "route_type"
    ],
    "stops.csv": [
        "stop_id",
        "stop_code",
        "stop_name",
        "stop_lat",
        "stop_lon"
    ],
    "trips.csv": [
        "route_id",
        "service_id",
        "trip_id"
    ],
    "stop_times.csv": [
        "trip_id",
        "arrival_time",
        "departure_time",
        "stop_id",
        "stop_sequence"
    ]
};

/**
 * Reads the first non-empty line of a file using streams to avoid
 * loading large files (e.g. stop_times.csv > 200MB) entirely into memory.
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
 * Parses a CSV header line into normalized column names.
 *
 * @param {string} headerLine - Raw CSV header string.
 * @returns {string[]} Array of column names.
 */
function parseHeaders(headerLine) {
    return headerLine
        .split(",")
        .map((col) => col.trim().replace(/^["']|["']$/g, "").trim());
}

/**
 * Runs validation across all six required Kaggle GTFS files.
 */
async function validateKaggleGTFS() {
    console.log("========================================");
    console.log("  KAGGLE GTFS BASIC VALIDATION");
    console.log("========================================");
    console.log(`Target Directory: ${datasetDir}\n`);

    if (!fs.existsSync(datasetDir)) {
        console.error(`[FAIL] Dataset directory does not exist: ${datasetDir}`);
        process.exit(1);
    }

    let hasErrors = false;
    const fileEntries = Object.entries(REQUIRED_FILES);

    for (const [filename, requiredColumns] of fileEntries) {
        const filePath = path.join(datasetDir, filename);

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
            console.log(
                `[PASS] ${filename}: Exists, readable, all ${requiredColumns.length} required headers present.`
            );
        }
    }

    console.log("\n----------------------------------------");
    if (hasErrors) {
        console.error("Validation FAILED: One or more Kaggle GTFS files failed validation.");
        process.exit(1);
    } else {
        console.log("Validation PASSED: All 6 Kaggle GTFS files exist, are readable, and have required headers.");
        process.exit(0);
    }
}

validateKaggleGTFS();
