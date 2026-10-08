/**
 * Realtime OTD <-> GTFS ID Structure Diagnostic
 *
 * READ-ONLY diagnostic script to analyze the structural patterns of:
 * - Realtime trip_ids and route_ids from %TEMP%\ids_sample.csv
 * - Development GTFS routes.txt and trips.txt
 *
 * Reports:
 * 1. Realtime trip_id format examples.
 * 2. GTFS trip_id format examples.
 * 3. Apparent route_id prefix extraction before first "_" in realtime trip_ids.
 * 4. Count of realtime rows where trip_id prefix == realtime route_id.
 * 5. Trip availability in GTFS for realtime routes existing in routes.txt.
 * 6. Sample of 20 unmatched realtime trip_ids whose route_id exists in GTFS,
 *    including GTFS trip counts and sample GTFS trip_ids for that route.
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
 * Does not modify or reformat values.
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
 * Loads GTFS routes.txt to extract all route_ids.
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
                throw new Error(`routes.txt missing route_id header: ${line}`);
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
 * Loads GTFS trips.txt to extract trip_ids, route associations, and sample trips per route.
 *
 * @param {string} filePath - Path to trips.txt.
 * @returns {Promise<{
 *   tripIds: Set<string>,
 *   routeToTrips: Map<string, string[]>,
 *   formatExamples: string[]
 * }>}
 */
async function loadGtfsTrips(filePath) {
    const tripIds = new Set();
    const routeToTrips = new Map();
    const formatExamples = [];
    let tripIdColIdx = -1;
    let routeIdColIdx = -1;

    await streamFileLines(filePath, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            tripIdColIdx = headers.indexOf("trip_id");
            routeIdColIdx = headers.indexOf("route_id");
            if (tripIdColIdx === -1 || routeIdColIdx === -1) {
                throw new Error(`trips.txt missing trip_id or route_id header: ${line}`);
            }
            return;
        }

        const tripId = cols[tripIdColIdx];
        const routeId = cols[routeIdColIdx];
        if (tripId !== undefined && tripId !== "") {
            tripIds.add(tripId);

            if (formatExamples.length < 10) {
                formatExamples.push(tripId);
            }

            if (routeId !== undefined && routeId !== "") {
                if (!routeToTrips.has(routeId)) {
                    routeToTrips.set(routeId, []);
                }
                routeToTrips.get(routeId).push(tripId);
            }
        }
    });

    return { tripIds, routeToTrips, formatExamples };
}

/**
 * Main analysis execution
 */
async function analyzeIdStructure() {
    console.log("=================================================");
    console.log("  REALTIME OTD <-> GTFS ID STRUCTURE ANALYSIS");
    console.log("=================================================");
    console.log(`Realtime sample: ${SAMPLE_PATH}`);
    console.log(`GTFS directory : ${GTFS_DIR}\n`);

    // Verify existence of inputs
    if (!fs.existsSync(SAMPLE_PATH)) {
        console.error(`[ERROR] Realtime sample not found at: ${SAMPLE_PATH}`);
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
    const {
        tripIds: gtfsTripIds,
        routeToTrips: gtfsRouteToTrips,
        formatExamples: gtfsTripExamples
    } = await loadGtfsTrips(TRIPS_PATH);
    console.log(`loaded ${gtfsTripIds.size} trips across ${gtfsRouteToTrips.size} routes.`);

    // 2. Stream and analyze Realtime sample
    console.log("Analyzing realtime sample...\n");

    const realtimeTripExamples = [];
    const uniqueRealtimeRoutes = new Set();
    const uniqueRealtimeTrips = new Set();
    const unmatchedSample = [];
    const seenUnmatchedTrips = new Set();

    let totalRealtimeRows = 0;
    let prefixMatchesRouteCount = 0;
    let prefixMismatchesRouteCount = 0;
    const prefixMismatchesSample = [];

    let rRouteColIdx = -1;
    let rTripColIdx = -1;

    await streamFileLines(SAMPLE_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            rRouteColIdx = headers.indexOf("route_id");
            rTripColIdx = headers.indexOf("trip_id");
            if (rRouteColIdx === -1 || rTripColIdx === -1) {
                throw new Error(`Sample CSV missing route_id or trip_id header: ${line}`);
            }
            return;
        }

        totalRealtimeRows++;
        const rRoute = cols[rRouteColIdx] !== undefined ? cols[rRouteColIdx] : "";
        const rTrip = cols[rTripColIdx] !== undefined ? cols[rTripColIdx] : "";

        if (rRoute !== "") uniqueRealtimeRoutes.add(rRoute);
        if (rTrip !== "") uniqueRealtimeTrips.add(rTrip);

        // Collect sample of realtime trip_id format
        if (rTrip !== "" && realtimeTripExamples.length < 10) {
            realtimeTripExamples.push(rTrip);
        }

        // Apparent route_id prefix before first "_"
        const underscoreIdx = rTrip.indexOf("_");
        const apparentPrefix = underscoreIdx !== -1 ? rTrip.substring(0, underscoreIdx) : "";

        if (apparentPrefix === rRoute && rRoute !== "") {
            prefixMatchesRouteCount++;
        } else {
            prefixMismatchesRouteCount++;
            if (prefixMismatchesSample.length < 5) {
                prefixMismatchesSample.push({
                    realtime_route_id: rRoute,
                    realtime_trip_id: rTrip,
                    extracted_prefix: apparentPrefix
                });
            }
        }

        // Sample of unmatched realtime trip_ids whose route_id DOES exist in GTFS
        if (
            rRoute !== "" &&
            rTrip !== "" &&
            gtfsRouteIds.has(rRoute) &&
            !gtfsTripIds.has(rTrip) &&
            !seenUnmatchedTrips.has(rTrip) &&
            unmatchedSample.length < 20
        ) {
            seenUnmatchedTrips.add(rTrip);
            const gtfsTripsForRoute = gtfsRouteToTrips.get(rRoute) || [];
            unmatchedSample.push({
                realtimeRouteId: rRoute,
                realtimeTripId: rTrip,
                routeExistsInGtfs: true,
                gtfsTripsCount: gtfsTripsForRoute.length,
                sampleGtfsTrips: gtfsTripsForRoute.slice(0, 5)
            });
        }
    });

    // 3. Analysis: Realtime route_ids in GTFS routes.txt and their GTFS trip availability
    const realtimeRoutesInGtfs = Array.from(uniqueRealtimeRoutes).filter((r) =>
        gtfsRouteIds.has(r)
    );

    let routesWithGtfsTripsCount = 0;
    let routesWithoutGtfsTripsCount = 0;
    let totalGtfsTripsForMatchedRoutes = 0;

    for (const rId of realtimeRoutesInGtfs) {
        const trips = gtfsRouteToTrips.get(rId);
        if (trips && trips.length > 0) {
            routesWithGtfsTripsCount++;
            totalGtfsTripsForMatchedRoutes += trips.length;
        } else {
            routesWithoutGtfsTripsCount++;
        }
    }

    // -------------------------------------------------------------
    // PRINT DETAILED REPORT
    // -------------------------------------------------------------

    console.log("1. REALTIME TRIP_ID FORMAT EXAMPLES");
    console.log("-------------------------------------------------");
    realtimeTripExamples.forEach((id, idx) => {
        console.log(`   [${idx + 1}] ${id}`);
    });

    console.log("\n2. GTFS TRIP_ID FORMAT EXAMPLES");
    console.log("-------------------------------------------------");
    gtfsTripExamples.forEach((id, idx) => {
        console.log(`   [${idx + 1}] ${id}`);
    });

    console.log("\n3 & 4. REALTIME TRIP_ID PREFIX vs REALTIME ROUTE_ID");
    console.log("-------------------------------------------------");
    console.log(`Total realtime rows evaluated: ${totalRealtimeRows}`);
    const prefixMatchPct =
        totalRealtimeRows > 0
            ? ((prefixMatchesRouteCount / totalRealtimeRows) * 100).toFixed(2)
            : "0.00";
    console.log(
        `Rows where trip_id prefix (before '_') == route_id: ${prefixMatchesRouteCount} (${prefixMatchPct}%)`
    );
    console.log(
        `Rows where trip_id prefix != route_id: ${prefixMismatchesRouteCount}`
    );
    if (prefixMismatchesSample.length > 0) {
        console.log("Sample prefix mismatches:");
        prefixMismatchesSample.forEach((m) => {
            console.log(
                `   route_id: "${m.realtime_route_id}", trip_id: "${m.realtime_trip_id}", extracted_prefix: "${m.extracted_prefix}"`
            );
        });
    }

    console.log("\n5. GTFS TRIP AVAILABILITY FOR REALTIME ROUTES");
    console.log("-------------------------------------------------");
    console.log(`Unique realtime route_ids in sample: ${uniqueRealtimeRoutes.size}`);
    console.log(
        `Realtime route_ids present in GTFS routes.txt: ${realtimeRoutesInGtfs.length}`
    );
    console.log(
        `  - Realtime routes WITH trips in GTFS trips.txt: ${routesWithGtfsTripsCount}`
    );
    console.log(
        `  - Realtime routes WITHOUT trips in GTFS trips.txt: ${routesWithoutGtfsTripsCount}`
    );
    console.log(
        `Total GTFS trips across all matched routes: ${totalGtfsTripsForMatchedRoutes}`
    );

    console.log("\n6. SAMPLE OF 20 UNMATCHED REALTIME TRIP_IDS (WHOSE ROUTE EXISTS IN GTFS)");
    console.log("-------------------------------------------------");
    if (unmatchedSample.length === 0) {
        console.log("No unmatched realtime trip_ids found whose route_id exists in GTFS.");
    } else {
        unmatchedSample.forEach((item, idx) => {
            console.log(`\n[${idx + 1}] Realtime route_id : ${item.realtimeRouteId}`);
            console.log(`    Realtime trip_id  : ${item.realtimeTripId}`);
            console.log(`    Route in GTFS     : ${item.routeExistsInGtfs ? "Yes" : "No"}`);
            console.log(`    GTFS trips count  : ${item.gtfsTripsCount}`);
            console.log(
                `    Sample GTFS trips : ${
                    item.sampleGtfsTrips.length > 0
                        ? item.sampleGtfsTrips.join(", ")
                        : "(none)"
                }`
            );
        });
    }

    console.log("\n=================================================");
    console.log("  STRUCTURAL ANALYSIS SUMMARY");
    console.log("-------------------------------------------------");
    console.log(`Realtime rows analyzed                     : ${totalRealtimeRows}`);
    console.log(`Realtime rows with trip_id prefix == route : ${prefixMatchesRouteCount} (${prefixMatchPct}%)`);
    console.log(`Realtime unique routes in GTFS             : ${realtimeRoutesInGtfs.length} / ${uniqueRealtimeRoutes.size}`);
    console.log(`Matched routes with GTFS trips             : ${routesWithGtfsTripsCount} / ${realtimeRoutesInGtfs.length}`);
    console.log("=================================================");
}

analyzeIdStructure().catch((err) => {
    console.error(`[ERROR] ID structure analysis failed: ${err.message}`);
    process.exit(1);
});
