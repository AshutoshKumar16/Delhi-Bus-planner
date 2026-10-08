/**
 * Realtime OTD <-> GTFS Compatibility Diagnostic Check
 *
 * READ-ONLY diagnostic script.
 * Compares realtime IDs from %TEMP%\ids_sample.csv against development GTFS:
 * - data/gtfs/routes.txt
 * - data/gtfs/trips.txt
 *
 * Reports:
 * A. Realtime route_id coverage (unique, exact matches, %, unmatched count & sample)
 * B. Realtime trip_id coverage (unique, exact matches, %, unmatched count & sample)
 * C. Trip -> Route relationship consistency for trips found in GTFS
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

// Path configuration
const SAMPLE_PATH =
    process.argv[2] ||
    path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "ids_sample.csv");

const GTFS_DIR =
    process.env.GTFS_DIR || path.resolve(__dirname, "..", "data", "gtfs");

const ROUTES_PATH = path.join(GTFS_DIR, "routes.txt");
const TRIPS_PATH = path.join(GTFS_DIR, "trips.txt");

/**
 * Parses a single CSV line supporting comma separation and quotes.
 * Does not modify or reformat ID values beyond standard CSV extraction.
 *
 * @param {string} line - Raw CSV line.
 * @returns {string[]} Array of column values.
 */
function parseCsvLine(line) {
    const result = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === "," && !inQuotes) {
            result.push(cur.trim());
            cur = "";
        } else {
            cur += char;
        }
    }
    result.push(cur.trim());
    return result;
}

/**
 * Streams a text file line-by-line using Node.js readline.
 *
 * @param {string} filePath - Absolute path of file to read.
 * @param {function(string, number): void} onLine - Callback for each line.
 * @returns {Promise<void>}
 */
function streamFileLines(filePath, onLine) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { encoding: "utf8" });
        const rl = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        let lineIndex = 0;
        rl.on("line", (line) => {
            const cleanLine = lineIndex === 0 ? line.replace(/^\uFEFF/, "").trim() : line.trim();
            if (cleanLine.length > 0) {
                onLine(cleanLine, lineIndex);
                lineIndex++;
            }
        });

        rl.on("close", resolve);
        rl.on("error", reject);
        stream.on("error", reject);
    });
}

/**
 * Loads GTFS routes.txt and extracts all exact route_id strings into a Set.
 *
 * @param {string} filePath - Path to routes.txt.
 * @returns {Promise<Set<string>>}
 */
async function loadGtfsRoutes(filePath) {
    const routeIds = new Set();
    let routeIdColIdx = -1;

    await streamFileLines(filePath, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            routeIdColIdx = headers.indexOf("route_id");
            if (routeIdColIdx === -1) {
                throw new Error(`routes.txt is missing route_id header. Found: ${line}`);
            }
            return;
        }

        const routeId = cols[routeIdColIdx];
        if (routeId !== undefined && routeId !== "") {
            routeIds.add(routeId);
        }
    });

    return routeIds;
}

/**
 * Loads GTFS trips.txt and maps each trip_id to its associated route_id.
 *
 * @param {string} filePath - Path to trips.txt.
 * @returns {Promise<Map<string, string>>}
 */
async function loadGtfsTrips(filePath) {
    const tripToRoute = new Map();
    let tripIdColIdx = -1;
    let routeIdColIdx = -1;

    await streamFileLines(filePath, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            tripIdColIdx = headers.indexOf("trip_id");
            routeIdColIdx = headers.indexOf("route_id");
            if (tripIdColIdx === -1 || routeIdColIdx === -1) {
                throw new Error(`trips.txt is missing trip_id or route_id header. Found: ${line}`);
            }
            return;
        }

        const tripId = cols[tripIdColIdx];
        const routeId = cols[routeIdColIdx];
        if (tripId !== undefined && tripId !== "") {
            tripToRoute.set(tripId, routeId !== undefined ? routeId : "");
        }
    });

    return tripToRoute;
}

/**
 * Main compatibility analysis
 */
async function runCompatibilityCheck() {
    console.log("=================================================");
    console.log("  REALTIME OTD <-> GTFS COMPATIBILITY DIAGNOSTIC");
    console.log("=================================================");
    console.log(`Realtime sample: ${SAMPLE_PATH}`);
    console.log(`GTFS directory : ${GTFS_DIR}\n`);

    // Verify file existence
    if (!fs.existsSync(SAMPLE_PATH)) {
        console.error(`[ERROR] Sample file not found at: ${SAMPLE_PATH}`);
        console.error("Please run scripts/create_otd_id_sample.js first.");
        process.exit(1);
    }
    if (!fs.existsSync(ROUTES_PATH)) {
        console.error(`[ERROR] GTFS routes.txt not found at: ${ROUTES_PATH}`);
        process.exit(1);
    }
    if (!fs.existsSync(TRIPS_PATH)) {
        console.error(`[ERROR] GTFS trips.txt not found at: ${TRIPS_PATH}`);
        process.exit(1);
    }

    // 1. Load GTFS reference data
    process.stdout.write("Loading GTFS routes.txt... ");
    const gtfsRouteIds = await loadGtfsRoutes(ROUTES_PATH);
    console.log(`loaded ${gtfsRouteIds.size} unique route_ids.`);

    process.stdout.write("Loading GTFS trips.txt...  ");
    const gtfsTripToRoute = await loadGtfsTrips(TRIPS_PATH);
    console.log(`loaded ${gtfsTripToRoute.size} trips.`);

    // 2. Stream and process realtime sample
    console.log("Processing realtime sample...");
    const realtimeRouteIds = new Set();
    const realtimeTripIds = new Set();

    let totalSampleRows = 0;
    let relEvaluatedRows = 0;
    let relMatching = 0;
    let relMismatching = 0;
    const relMismatchesSample = [];

    let rRouteColIdx = -1;
    let rTripColIdx = -1;

    await streamFileLines(SAMPLE_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            rRouteColIdx = headers.indexOf("route_id");
            rTripColIdx = headers.indexOf("trip_id");
            if (rRouteColIdx === -1 || rTripColIdx === -1) {
                throw new Error(`Sample CSV missing route_id or trip_id column. Found: ${line}`);
            }
            return;
        }

        totalSampleRows++;
        const rRoute = cols[rRouteColIdx] !== undefined ? cols[rRouteColIdx] : "";
        const rTrip = cols[rTripColIdx] !== undefined ? cols[rTripColIdx] : "";

        if (rRoute !== "") realtimeRouteIds.add(rRoute);
        if (rTrip !== "") realtimeTripIds.add(rTrip);

        // Relationship consistency: for rows where trip_id exists in GTFS
        if (rTrip !== "" && gtfsTripToRoute.has(rTrip)) {
            relEvaluatedRows++;
            const gtfsAssociatedRoute = gtfsTripToRoute.get(rTrip);
            if (gtfsAssociatedRoute === rRoute) {
                relMatching++;
            } else {
                relMismatching++;
                if (relMismatchesSample.length < 20) {
                    relMismatchesSample.push({
                        trip_id: rTrip,
                        realtime_route_id: rRoute,
                        gtfs_route_id: gtfsAssociatedRoute
                    });
                }
            }
        }
    });

    // 3. Compute route_id coverage
    const matchedRouteIds = [];
    const unmatchedRouteIds = [];
    for (const rId of realtimeRouteIds) {
        if (gtfsRouteIds.has(rId)) {
            matchedRouteIds.push(rId);
        } else {
            unmatchedRouteIds.push(rId);
        }
    }

    const routeMatchPct =
        realtimeRouteIds.size > 0
            ? ((matchedRouteIds.length / realtimeRouteIds.size) * 100).toFixed(2)
            : "0.00";

    // 4. Compute trip_id coverage
    const matchedTripIds = [];
    const unmatchedTripIds = [];
    for (const tId of realtimeTripIds) {
        if (gtfsTripToRoute.has(tId)) {
            matchedTripIds.push(tId);
        } else {
            unmatchedTripIds.push(tId);
        }
    }

    const tripMatchPct =
        realtimeTripIds.size > 0
            ? ((matchedTripIds.length / realtimeTripIds.size) * 100).toFixed(2)
            : "0.00";

    // 5. Relationship consistency percentage
    const relConsistencyPct =
        relEvaluatedRows > 0
            ? ((relMatching / relEvaluatedRows) * 100).toFixed(2)
            : "N/A";

    // 6. Print detailed reports and samples
    console.log("\n=================================================");
    console.log("  DETAILED SAMPLES (MAX 20 EACH)");
    console.log("=================================================");

    console.log(`\nA. Matched route_ids (${matchedRouteIds.length} total, showing up to 20):`);
    console.log(
        matchedRouteIds.length > 0
            ? matchedRouteIds.slice(0, 20).join(", ")
            : "None"
    );

    console.log(`\nB. Unmatched route_ids (${unmatchedRouteIds.length} total, showing up to 20):`);
    console.log(
        unmatchedRouteIds.length > 0
            ? unmatchedRouteIds.slice(0, 20).join(", ")
            : "None"
    );

    console.log(`\nC. Matched trip_ids (${matchedTripIds.length} total, showing up to 20):`);
    console.log(
        matchedTripIds.length > 0
            ? matchedTripIds.slice(0, 20).join(", ")
            : "None"
    );

    console.log(`\nD. Unmatched trip_ids (${unmatchedTripIds.length} total, showing up to 20):`);
    console.log(
        unmatchedTripIds.length > 0
            ? unmatchedTripIds.slice(0, 20).join(", ")
            : "None"
    );

    console.log(`\nE. Relationship mismatches (${relMismatching} total, showing up to 20):`);
    if (relMismatchesSample.length === 0) {
        console.log("None");
    } else {
        relMismatchesSample.forEach((m) => {
            console.log(
                `  trip_id: ${m.trip_id} -> realtime route_id: "${m.realtime_route_id}", GTFS route_id: "${m.gtfs_route_id}"`
            );
        });
    }

    // 7. Final structured summary
    console.log("\n=================================================");
    console.log("REALTIME OTD <-> GTFS COMPATIBILITY");
    console.log("-------------------------------------------------");
    console.log(`Total sample records: ${totalSampleRows}`);
    console.log(`Realtime unique route_ids: ${realtimeRouteIds.size}`);
    console.log(
        `Exact GTFS route_id matches: ${matchedRouteIds.length} (${routeMatchPct}%)`
    );
    console.log(`Unmatched route_ids: ${unmatchedRouteIds.length}`);
    console.log("");
    console.log(`Realtime unique trip_ids: ${realtimeTripIds.size}`);
    console.log(
        `Exact GTFS trip_id matches: ${matchedTripIds.length} (${tripMatchPct}%)`
    );
    console.log(`Unmatched trip_ids: ${unmatchedTripIds.length}`);
    console.log("");
    console.log("Trip -> route consistency (for trips found in GTFS):");
    console.log(`Evaluated rows: ${relEvaluatedRows}`);
    console.log(`Matching: ${relMatching}`);
    console.log(`Mismatching: ${relMismatching}`);
    console.log(`Consistency: ${relConsistencyPct}%`);
    console.log("=================================================");
}

runCompatibilityCheck().catch((err) => {
    console.error(`[ERROR] Diagnostic check failed: ${err.message}`);
    process.exit(1);
});
