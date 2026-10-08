/**
 * Validation of Matched Realtime <-> Kaggle GTFS Route IDs
 *
 * READ-ONLY diagnostic script.
 * Validates whether the 657 realtime route_ids that match Kaggle routes.csv
 * possess valid, usable GTFS stop sequences and stop definitions.
 *
 * Traversal:
 * Realtime route_id -> Kaggle routes.csv -> trips.csv (representative trip)
 * -> stop_times.csv -> stops.csv
 *
 * Memory safety:
 * Only stores stop_times records for the deterministic representative trips
 * (~657 trips), avoiding buffering the >200MB stop_times.csv file.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

// Path configuration
const defaultKaggleDir = path.resolve(
    __dirname,
    "..",
    "data",
    "kaggle_gtfs",
    "dmrc_gtfs_dataset"
);
const fallbackKaggleDir = path.resolve(__dirname, "..", "data", "kaggle_gtfs");

let KAGGLE_DIR = process.env.KAGGLE_GTFS_DIR;
if (!KAGGLE_DIR) {
    KAGGLE_DIR = fs.existsSync(path.join(defaultKaggleDir, "routes.csv"))
        ? defaultKaggleDir
        : fallbackKaggleDir;
}

const SAMPLE_PATH =
    process.argv[2] ||
    path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "ids_sample.csv");

const ROUTES_PATH = path.join(KAGGLE_DIR, "routes.csv");
const TRIPS_PATH = path.join(KAGGLE_DIR, "trips.csv");
const STOPS_PATH = path.join(KAGGLE_DIR, "stops.csv");
const STOP_TIMES_PATH = path.join(KAGGLE_DIR, "stop_times.csv");

/**
 * Parses a single CSV line supporting comma separation and quotes.
 *
 * @param {string} line - Raw CSV line.
 * @returns {string[]} Array of field values.
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
 * Main execution
 */
async function validateKaggleRouteMatches() {
    console.log("=================================================");
    console.log("  KAGGLE GTFS ROUTE MATCH STRUCTURAL VALIDATION");
    console.log("=================================================");
    console.log(`Realtime sample: ${SAMPLE_PATH}`);
    console.log(`Kaggle GTFS dir: ${KAGGLE_DIR}\n`);

    // Verify all input files exist
    const requiredFiles = [
        { name: "Sample CSV", path: SAMPLE_PATH },
        { name: "routes.csv", path: ROUTES_PATH },
        { name: "trips.csv", path: TRIPS_PATH },
        { name: "stops.csv", path: STOPS_PATH },
        { name: "stop_times.csv", path: STOP_TIMES_PATH }
    ];

    for (const f of requiredFiles) {
        if (!fs.existsSync(f.path)) {
            console.error(`[ERROR] Required file not found: ${f.name} at ${f.path}`);
            process.exit(1);
        }
    }

    // Step 1: Read unique realtime route_ids from sample
    process.stdout.write("1. Reading realtime route_ids... ");
    const realtimeRouteIds = new Set();
    let rRouteIdx = -1;

    await streamFileLines(SAMPLE_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            rRouteIdx = headers.indexOf("route_id");
            if (rRouteIdx === -1) {
                throw new Error(`Sample CSV missing route_id header.`);
            }
            return;
        }
        const rRoute = cols[rRouteIdx];
        if (rRoute) realtimeRouteIds.add(rRoute);
    });
    console.log(`found ${realtimeRouteIds.size} unique realtime route_ids.`);

    // Step 2: Read Kaggle routes.csv and find exact matches
    process.stdout.write("2. Reading Kaggle routes.csv... ");
    const kaggleRoutes = new Map(); // route_id -> { shortName, longName }
    let kRouteIdIdx = -1;
    let kShortNameIdx = -1;
    let kLongNameIdx = -1;

    await streamFileLines(ROUTES_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            kRouteIdIdx = headers.indexOf("route_id");
            kShortNameIdx = headers.indexOf("route_short_name");
            kLongNameIdx = headers.indexOf("route_long_name");
            if (kRouteIdIdx === -1) {
                throw new Error(`routes.csv missing route_id header.`);
            }
            return;
        }

        const rId = cols[kRouteIdIdx];
        if (rId) {
            kaggleRoutes.set(rId, {
                shortName: kShortNameIdx !== -1 && cols[kShortNameIdx] ? cols[kShortNameIdx] : "",
                longName: kLongNameIdx !== -1 && cols[kLongNameIdx] ? cols[kLongNameIdx] : ""
            });
        }
    });

    // Identify exact matched routes
    const matchedRouteIds = Array.from(realtimeRouteIds).filter((r) => kaggleRoutes.has(r));
    console.log(`identified ${matchedRouteIds.length} exact matched routes.`);

    // Step 3: Read trips.csv for matched routes and select deterministic representative trip
    // Selection Rule:
    // For each matched route_id, all associated GTFS trip_ids are sorted lexicographically,
    // and the first trip_id is selected.
    // Explanation: In GTFS, trip_ids follow `<route_id>_<start_hour>_<start_minute>`. Lexicographical
    // ordering reliably selects the earliest scheduled departure trip of the day deterministically.
    process.stdout.write("3. Reading trips.csv & selecting representative trips... ");
    const matchedRouteToTrips = new Map(); // route_id -> trip_id[]
    let tripRouteIdx = -1;
    let tripIdIdx = -1;

    await streamFileLines(TRIPS_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            tripRouteIdx = headers.indexOf("route_id");
            tripIdIdx = headers.indexOf("trip_id");
            if (tripRouteIdx === -1 || tripIdIdx === -1) {
                throw new Error(`trips.csv missing route_id or trip_id header.`);
            }
            return;
        }

        const rId = cols[tripRouteIdx];
        const tId = cols[tripIdIdx];

        if (rId && tId && kaggleRoutes.has(rId) && realtimeRouteIds.has(rId)) {
            if (!matchedRouteToTrips.has(rId)) {
                matchedRouteToTrips.set(rId, []);
            }
            matchedRouteToTrips.get(rId).push(tId);
        }
    });

    const routeToRepresentativeTrip = new Map(); // route_id -> rep_trip_id
    const representativeTripToRoute = new Map(); // rep_trip_id -> route_id

    for (const rId of matchedRouteIds) {
        const trips = matchedRouteToTrips.get(rId) || [];
        if (trips.length > 0) {
            // Deterministic sort: lexicographically earliest trip_id
            trips.sort();
            const repTrip = trips[0];
            routeToRepresentativeTrip.set(rId, repTrip);
            representativeTripToRoute.set(repTrip, rId);
        }
    }
    console.log(`selected ${representativeTripToRoute.size} representative trips.`);

    // Step 4: Load stops.csv
    process.stdout.write("4. Loading stops.csv... ");
    const stopsMap = new Map(); // stop_id -> stop_name
    let stopIdColIdx = -1;
    let stopNameColIdx = -1;

    await streamFileLines(STOPS_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            stopIdColIdx = headers.indexOf("stop_id");
            stopNameColIdx = headers.indexOf("stop_name");
            if (stopIdColIdx === -1 || stopNameColIdx === -1) {
                throw new Error(`stops.csv missing stop_id or stop_name header.`);
            }
            return;
        }

        const sId = cols[stopIdColIdx];
        const sName = cols[stopNameColIdx];
        if (sId !== undefined) {
            stopsMap.set(sId, sName !== undefined ? sName : "");
        }
    });
    console.log(`loaded ${stopsMap.size} stops.`);

    // Step 5: Memory-safely stream stop_times.csv only for representative trips
    process.stdout.write("5. Streaming stop_times.csv (memory-safe)... ");
    const repTripStopTimes = new Map(); // rep_trip_id -> Array<{ stop_id, stop_sequence }>
    let stTripIdIdx = -1;
    let stStopIdIdx = -1;
    let stStopSeqIdx = -1;

    await streamFileLines(STOP_TIMES_PATH, (line, index) => {
        if (index === 0) {
            const cols = parseCsvLine(line);
            const headers = cols.map((h) => h.toLowerCase());
            stTripIdIdx = headers.indexOf("trip_id");
            stStopIdIdx = headers.indexOf("stop_id");
            stStopSeqIdx = headers.indexOf("stop_sequence");
            if (stTripIdIdx === -1 || stStopIdIdx === -1 || stStopSeqIdx === -1) {
                throw new Error(`stop_times.csv missing required headers.`);
            }
            return;
        }

        // Fast preliminary check: extract trip_id before full comma parsing
        const firstComma = line.indexOf(",");
        if (firstComma === -1) return;
        const lineTripId = line.substring(0, firstComma).trim().replace(/^["']|["']$/g, "");

        if (representativeTripToRoute.has(lineTripId)) {
            const cols = parseCsvLine(line);
            const tripId = cols[stTripIdIdx];
            const stopId = cols[stStopIdIdx];
            const stopSeq = parseInt(cols[stStopSeqIdx], 10);

            if (!repTripStopTimes.has(tripId)) {
                repTripStopTimes.set(tripId, []);
            }
            repTripStopTimes.get(tripId).push({
                stop_id: stopId,
                stop_sequence: isNaN(stopSeq) ? 0 : stopSeq
            });
        }
    });
    console.log(`collected stop sequences for ${repTripStopTimes.size} representative trips.\n`);

    // Step 6: Validate stop sequences and compile statistics
    let routesWithAtLeastOneTrip = 0;
    let routesWithUsableStopSequence = 0;
    let routesWithInvalidStopRefs = 0;

    const validatedRoutes = [];

    for (const rId of matchedRouteIds) {
        const routeInfo = kaggleRoutes.get(rId) || { shortName: "", longName: "" };
        const trips = matchedRouteToTrips.get(rId) || [];
        const hasTrip = trips.length > 0;
        if (hasTrip) routesWithAtLeastOneTrip++;

        const repTripId = routeToRepresentativeTrip.get(rId) || null;
        const rawStops = repTripId ? repTripStopTimes.get(repTripId) || [] : [];

        // Sort stops by stop_sequence
        rawStops.sort((a, b) => a.stop_sequence - b.stop_sequence);

        let hasInvalidRef = false;
        for (const st of rawStops) {
            if (!stopsMap.has(st.stop_id)) {
                hasInvalidRef = true;
                break;
            }
        }
        if (hasInvalidRef) routesWithInvalidStopRefs++;

        const isUsable = rawStops.length >= 2 && !hasInvalidRef;
        if (isUsable) routesWithUsableStopSequence++;

        const firstStopName = rawStops.length > 0 ? stopsMap.get(rawStops[0].stop_id) || `[Unknown ID: ${rawStops[0].stop_id}]` : "N/A";
        const lastStopName = rawStops.length > 0 ? stopsMap.get(rawStops[rawStops.length - 1].stop_id) || `[Unknown ID: ${rawStops[rawStops.length - 1].stop_id}]` : "N/A";

        validatedRoutes.push({
            routeId: rId,
            routeShortName: routeInfo.shortName,
            routeLongName: routeInfo.longName,
            tripsCount: trips.length,
            representativeTripId: repTripId || "None",
            stopsCount: rawStops.length,
            firstStopName,
            lastStopName,
            isUsable,
            hasInvalidRef
        });
    }

    // Step 7: Print sample of 20 matched routes
    console.log("=================================================");
    console.log("  SAMPLE OF 20 MATCHED ROUTES (STRUCTURAL DETAILS)");
    console.log("=================================================");

    const sampleRoutes = validatedRoutes.slice(0, 20);
    sampleRoutes.forEach((r, idx) => {
        console.log(`\n[${idx + 1}] Route ID              : ${r.routeId}`);
        console.log(`    Route Short Name      : ${r.routeShortName || "(empty)"}`);
        console.log(`    Route Long Name       : ${r.routeLongName || "(empty)"}`);
        console.log(`    GTFS Trips Count      : ${r.tripsCount}`);
        console.log(`    Representative Trip   : ${r.representativeTripId}`);
        console.log(`    Stops in Sequence     : ${r.stopsCount}`);
        console.log(`    First Stop            : ${r.firstStopName}`);
        console.log(`    Last Stop             : ${r.lastStopName}`);
    });

    // Step 8: Final Summary
    console.log("\n=================================================");
    console.log("  KAGGLE GTFS ROUTE MATCH STRUCTURAL VALIDATION");
    console.log("-------------------------------------------------");
    console.log(`Total matched route_ids               : ${matchedRouteIds.length}`);
    console.log(
        `Routes with at least one GTFS trip    : ${routesWithAtLeastOneTrip} (${((routesWithAtLeastOneTrip / matchedRouteIds.length) * 100).toFixed(2)}%)`
    );
    console.log(
        `Routes with usable stop sequence (>=2): ${routesWithUsableStopSequence} (${((routesWithUsableStopSequence / matchedRouteIds.length) * 100).toFixed(2)}%)`
    );
    console.log(
        `Routes with missing/invalid stop refs : ${routesWithInvalidStopRefs} (${((routesWithInvalidStopRefs / matchedRouteIds.length) * 100).toFixed(2)}%)`
    );
    console.log("-------------------------------------------------");
    console.log("Representative trip selection rule:");
    console.log("  Lexicographically earliest trip_id per route_id (reflects earliest scheduled departure time).");
    console.log("Note:");
    console.log("  This is a structural GTFS sequence verification. It verifies that matched IDs have valid");
    console.log("  GTFS topology and stop sequences; it does not claim semantic identity with realtime operations.");
    console.log("=================================================");
}

validateKaggleRouteMatches().catch((err) => {
    console.error(`[ERROR] Route validation failed: ${err.message}`);
    process.exit(1);
});
