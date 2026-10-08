/**
 * GitHub OTD-GTFS-Routes vs Real OTD Realtime Validation Diagnostic
 *
 * READ-ONLY diagnostic script.
 * Validates the GitHub OTD-GTFS-Routes dataset against the real OTD realtime archive.
 *
 * Dataset paths:
 * - GitHub GTFS: E:\Delhi-Bus-OTD\data\OTD-GTFS-Routes-master\gtfs-github
 *   Files used ONLY: routes.txt, trips.txt, stop_times.txt, stops.txt
 * - Realtime archive: E:\Delhi-Bus-OTD\data\ (latest valid .csv.gz snapshot)
 *
 * Core Tests:
 * 1. ROUTE ID MATCH:
 *    Extract unique realtime route_ids, compare exact values with GTFS routes.txt,
 *    report total, matched, unmatched, and match percentage.
 * 2. TRIP ID MATCH:
 *    Extract unique realtime trip_ids, compare exact values with GTFS trips.txt,
 *    report total, matched, unmatched, match percentage, and verify route_id consistency.
 * 3. GPS -> GTFS STOP PROXIMITY:
 *    For realtime observations whose route_id exists in GitHub GTFS:
 *    (routes -> trips -> stop_times -> stops), compute Haversine distance to nearest stop.
 *    Report min, median, p90, max, and distance buckets (<=50m, <=100m, <=250m, <=500m, >500m),
 *    plus 20 sample mappings.
 * 4. STRUCTURAL VALIDATION:
 *    Verify matched routes have trips, trips have stop_times, and stop_times stop_ids exist in stops.txt.
 *
 * STRICT RULES:
 * - Exact matching only. No modification or normalization of IDs.
 * - No inference of trip matches from route_id.
 * - No modification of GTFS files or database.
 * - No reading or printing of .env or credentials.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

// Paths
const GITHUB_GTFS_DIR =
    process.env.GITHUB_GTFS_DIR ||
    path.resolve(__dirname, "..", "data", "OTD-GTFS-Routes-master", "gtfs-github");
const DATA_DIR = path.resolve(__dirname, "..", "data");

const ROUTES_FILE = path.join(GITHUB_GTFS_DIR, "routes.txt");
const TRIPS_FILE = path.join(GITHUB_GTFS_DIR, "trips.txt");
const STOPS_FILE = path.join(GITHUB_GTFS_DIR, "stops.txt");
const STOP_TIMES_FILE = path.join(GITHUB_GTFS_DIR, "stop_times.txt");

/**
 * Calculates great-circle distance between two GPS coordinates using the Haversine formula.
 *
 * @param {number} lat1 - Latitude of point 1 in degrees.
 * @param {number} lon1 - Longitude of point 1 in degrees.
 * @param {number} lat2 - Latitude of point 2 in degrees.
 * @param {number} lon2 - Longitude of point 2 in degrees.
 * @returns {number} Distance in meters.
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    const EARTH_RADIUS_METERS = 6371000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
        Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_METERS * c;
}

/**
 * Parses a single CSV line supporting comma separation and quotes.
 * Strictly preserves exact field values without altering or normalizing IDs.
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
 * Streams a text file line-by-line using Node.js readline interface.
 *
 * @param {string} filePath - Absolute path to file.
 * @param {function(string, number): void} onLine - Line handler callback.
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
 * Recursively scans data directory for .csv.gz archive snapshots,
 * excluding non-archive directories (gtfs, kaggle_gtfs, OTD-GTFS-Routes-master, dotfiles).
 *
 * @param {string} dir - Directory to scan.
 * @returns {string[]} List of snapshot file paths.
 */
function findArchiveSnapshots(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;

    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nameLower = entry.name.toLowerCase();
            if (
                nameLower !== "gtfs" &&
                nameLower !== "kaggle_gtfs" &&
                nameLower !== "otd-gtfs-routes-master" &&
                !nameLower.startsWith(".")
            ) {
                results.push(...findArchiveSnapshots(fullPath));
            }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv.gz")) {
            try {
                const stat = fs.statSync(fullPath);
                // Ensure file has meaningful content (> 1000 bytes) to skip interrupted/empty downloads
                if (stat.size > 1000) {
                    results.push(fullPath);
                }
            } catch {
                // Ignore inaccessible files
            }
        }
    }
    return results;
}

/**
 * Extracts a sortable timestamp key from snapshot file path.
 *
 * @param {string} filePath - Absolute path to .csv.gz file.
 * @returns {string} Sortable string key.
 */
function getFileSortKey(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    const match = normalized.match(/(\d{4}-\d{2}-\d{2})\/(\d{6})\.csv\.gz$/i);
    if (match) {
        return `${match[1]}_${match[2]}`;
    }
    try {
        const stats = fs.statSync(filePath);
        return new Date(stats.mtimeMs).toISOString();
    } catch {
        return "";
    }
}

/**
 * Main diagnostic execution function.
 */
async function runDiagnostic() {
    console.log("================================================================================");
    console.log("   GITHUB OTD-GTFS-ROUTES vs REALTIME ARCHIVE DIAGNOSTIC VALIDATION");
    console.log("================================================================================");
    console.log(`GitHub GTFS Dir : ${GITHUB_GTFS_DIR}`);
    console.log(`Realtime Dir    : ${DATA_DIR}`);

    // Verify required GTFS files exist
    const requiredFiles = [
        { name: "routes.txt", path: ROUTES_FILE },
        { name: "trips.txt", path: TRIPS_FILE },
        { name: "stops.txt", path: STOPS_FILE },
        { name: "stop_times.txt", path: STOP_TIMES_FILE }
    ];

    for (const f of requiredFiles) {
        if (!fs.existsSync(f.path)) {
            console.error(`[ERROR] Required GTFS file missing: ${f.name} at ${f.path}`);
            process.exit(1);
        }
    }

    // Step 0: Identify latest valid realtime .csv.gz snapshot
    let snapshotPath = process.argv[2];
    if (!snapshotPath) {
        const allSnapshots = findArchiveSnapshots(DATA_DIR);
        if (allSnapshots.length === 0) {
            console.error(`[ERROR] No valid .csv.gz archive snapshots found in ${DATA_DIR}`);
            process.exit(1);
        }
        allSnapshots.sort((a, b) => getFileSortKey(a).localeCompare(getFileSortKey(b)));
        snapshotPath = allSnapshots[allSnapshots.length - 1];
    } else {
        snapshotPath = path.resolve(snapshotPath);
    }

    console.log(`Latest Snapshot : ${snapshotPath}\n`);

    // =========================================================================
    // STEP 1: LOAD GITHUB GTFS DATA
    // =========================================================================
    console.log("--- Loading GitHub GTFS Data (routes.txt, trips.txt, stops.txt, stop_times.txt) ---");

    // 1A. Load stops.txt
    process.stdout.write("1. Loading stops.txt... ");
    const gtfsStops = new Map(); // stop_id -> { stop_id, stop_name, lat, lon }
    let sStopIdIdx = -1;
    let sStopNameIdx = -1;
    let sLatIdx = -1;
    let sLonIdx = -1;

    await streamFileLines(STOPS_FILE, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            sStopIdIdx = headers.indexOf("stop_id");
            sStopNameIdx = headers.indexOf("stop_name");
            sLatIdx = headers.indexOf("stop_lat");
            sLonIdx = headers.indexOf("stop_lon");
            if (sStopIdIdx === -1 || sLatIdx === -1 || sLonIdx === -1) {
                throw new Error("stops.txt missing stop_id, stop_lat, or stop_lon headers.");
            }
            return;
        }

        const stopId = cols[sStopIdIdx];
        const stopName = sStopNameIdx !== -1 ? cols[sStopNameIdx] : "";
        const lat = parseFloat(cols[sLatIdx]);
        const lon = parseFloat(cols[sLonIdx]);

        if (stopId !== undefined && stopId !== "" && !isNaN(lat) && !isNaN(lon)) {
            gtfsStops.set(stopId, {
                stop_id: stopId,
                stop_name: stopName,
                lat,
                lon
            });
        }
    });
    console.log(`loaded ${gtfsStops.size} valid stops.`);

    // 1B. Load routes.txt
    process.stdout.write("2. Loading routes.txt... ");
    const gtfsRoutes = new Map(); // route_id -> { route_id, route_short_name, route_long_name }
    let rRouteIdIdx = -1;
    let rShortNameIdx = -1;
    let rLongNameIdx = -1;

    await streamFileLines(ROUTES_FILE, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            rRouteIdIdx = headers.indexOf("route_id");
            rShortNameIdx = headers.indexOf("route_short_name");
            rLongNameIdx = headers.indexOf("route_long_name");
            if (rRouteIdIdx === -1) {
                throw new Error("routes.txt missing route_id header.");
            }
            return;
        }

        const routeId = cols[rRouteIdIdx];
        if (routeId !== undefined && routeId !== "") {
            gtfsRoutes.set(routeId, {
                route_id: routeId,
                route_short_name: rShortNameIdx !== -1 ? cols[rShortNameIdx] : "",
                route_long_name: rLongNameIdx !== -1 ? cols[rLongNameIdx] : ""
            });
        }
    });
    console.log(`loaded ${gtfsRoutes.size} unique route_ids.`);

    // 1C. Load trips.txt
    process.stdout.write("3. Loading trips.txt... ");
    const gtfsTripToRoute = new Map(); // trip_id -> route_id
    const gtfsRouteToTrips = new Map(); // route_id -> Set<trip_id>
    let tTripIdIdx = -1;
    let tRouteIdIdx = -1;

    await streamFileLines(TRIPS_FILE, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            tTripIdIdx = headers.indexOf("trip_id");
            tRouteIdIdx = headers.indexOf("route_id");
            if (tTripIdIdx === -1 || tRouteIdIdx === -1) {
                throw new Error("trips.txt missing trip_id or route_id header.");
            }
            return;
        }

        const tripId = cols[tTripIdIdx];
        const routeId = cols[tRouteIdIdx];
        if (tripId !== undefined && tripId !== "" && routeId !== undefined && routeId !== "") {
            gtfsTripToRoute.set(tripId, routeId);

            if (!gtfsRouteToTrips.has(routeId)) {
                gtfsRouteToTrips.set(routeId, new Set());
            }
            gtfsRouteToTrips.get(routeId).add(tripId);
        }
    });
    console.log(`loaded ${gtfsTripToRoute.size} trips across ${gtfsRouteToTrips.size} routes.`);

    // 1D. Stream stop_times.txt
    process.stdout.write("4. Streaming stop_times.txt (associating stops with routes & structural check)... ");
    const routeToStops = new Map(); // route_id -> Map<stop_id, stopObj>
    const tripsWithStopTimes = new Set();
    const distinctStopIdsInStopTimes = new Set();
    const missingStopsInStopTimes = new Set();

    let stTripIdIdx = -1;
    let stStopIdIdx = -1;

    await streamFileLines(STOP_TIMES_FILE, (line, index) => {
        if (index === 0) {
            const cols = parseCsvLine(line);
            const headers = cols.map((h) => h.toLowerCase());
            stTripIdIdx = headers.indexOf("trip_id");
            stStopIdIdx = headers.indexOf("stop_id");
            if (stTripIdIdx === -1 || stStopIdIdx === -1) {
                throw new Error("stop_times.txt missing trip_id or stop_id header.");
            }
            return;
        }

        const cols = parseCsvLine(line);
        const tripId = cols[stTripIdIdx];
        const stopId = cols[stStopIdIdx];

        if (!tripId || !stopId) return;

        tripsWithStopTimes.add(tripId);
        distinctStopIdsInStopTimes.add(stopId);

        const stopObj = gtfsStops.get(stopId);
        if (!stopObj) {
            missingStopsInStopTimes.add(stopId);
        }

        const routeId = gtfsTripToRoute.get(tripId);
        if (routeId && stopObj) {
            if (!routeToStops.has(routeId)) {
                routeToStops.set(routeId, new Map());
            }
            routeToStops.get(routeId).set(stopId, stopObj);
        }
    });

    // Convert route stops to arrays for high-performance distance calculation
    const routeStopsArrayMap = new Map();
    for (const [rId, stopMap] of routeToStops.entries()) {
        routeStopsArrayMap.set(rId, Array.from(stopMap.values()));
    }
    console.log(
        `processed. ${tripsWithStopTimes.size} trips have stop_times; ${routeToStops.size} routes have stops mapped.\n`
    );

    // =========================================================================
    // STEP 2: STREAM REALTIME SNAPSHOT
    // =========================================================================
    console.log("--- Reading Realtime Snapshot Observations ---");

    const realtimeRouteIds = new Set();
    const realtimeTripIds = new Set();
    const realtimeObservations = []; // sample & matching obs

    let snapTotalRows = 0;
    let snapRouteIdIdx = -1;
    let snapTripIdIdx = -1;
    let snapVehicleIdIdx = -1;
    let snapLatIdx = -1;
    let snapLonIdx = -1;

    const readStream = fs.createReadStream(snapshotPath);
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
        input: readStream.pipe(gunzip),
        crlfDelay: Infinity
    });

    let snapLineIndex = 0;
    for await (const line of rl) {
        const cleanLine = snapLineIndex === 0 ? line.replace(/^\uFEFF/, "").trim() : line.trim();
        if (cleanLine.length === 0) continue;

        const cols = parseCsvLine(cleanLine);
        if (snapLineIndex === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            snapRouteIdIdx = headers.indexOf("route_id");
            snapTripIdIdx = headers.indexOf("trip_id");
            snapVehicleIdIdx = headers.indexOf("vehicle_id");
            snapLatIdx = headers.indexOf("latitude");
            snapLonIdx = headers.indexOf("longitude");

            if (
                snapRouteIdIdx === -1 ||
                snapTripIdIdx === -1 ||
                snapVehicleIdIdx === -1 ||
                snapLatIdx === -1 ||
                snapLonIdx === -1
            ) {
                throw new Error("Snapshot missing required headers (route_id, trip_id, vehicle_id, latitude, longitude).");
            }
            snapLineIndex++;
            continue;
        }

        snapTotalRows++;
        const routeId = cols[snapRouteIdIdx];
        const tripId = cols[snapTripIdIdx];
        const vehicleId = cols[snapVehicleIdIdx];
        const lat = parseFloat(cols[snapLatIdx]);
        const lon = parseFloat(cols[snapLonIdx]);

        if (routeId !== undefined && routeId !== "") {
            realtimeRouteIds.add(routeId);
        }
        if (tripId !== undefined && tripId !== "") {
            realtimeTripIds.add(tripId);
        }

        // Store observation record
        realtimeObservations.push({
            vehicle_id: vehicleId || "",
            route_id: routeId || "",
            trip_id: tripId || "",
            latitude: lat,
            longitude: lon,
            validGps: !isNaN(lat) && !isNaN(lon)
        });

        snapLineIndex++;
    }

    console.log(`Loaded ${snapTotalRows} realtime observations from snapshot.`);
    console.log(`Unique realtime route_ids : ${realtimeRouteIds.size}`);
    console.log(`Unique realtime trip_ids  : ${realtimeTripIds.size}\n`);

    // =========================================================================
    // TEST 1: ROUTE ID MATCH
    // =========================================================================
    console.log("================================================================================");
    console.log("  TEST 1: ROUTE ID MATCH");
    console.log("================================================================================");

    const matchedRouteIds = [];
    const unmatchedRouteIds = [];

    for (const rId of realtimeRouteIds) {
        if (gtfsRoutes.has(rId)) {
            matchedRouteIds.push(rId);
        } else {
            unmatchedRouteIds.push(rId);
        }
    }

    const routeMatchPct =
        realtimeRouteIds.size > 0
            ? ((matchedRouteIds.length / realtimeRouteIds.size) * 100).toFixed(2)
            : "0.00";

    console.log(`Total Unique Realtime Route IDs : ${realtimeRouteIds.size}`);
    console.log(`Exact Matched in GTFS routes.txt: ${matchedRouteIds.length}`);
    console.log(`Unmatched Route IDs             : ${unmatchedRouteIds.length}`);
    console.log(`Route Match Percentage          : ${routeMatchPct}%`);

    if (matchedRouteIds.length > 0) {
        console.log(`\nSample Matched Route IDs (${Math.min(20, matchedRouteIds.length)} shown):`);
        matchedRouteIds.slice(0, 20).forEach((id, idx) => {
            const rInfo = gtfsRoutes.get(id);
            const label = rInfo ? `(short: "${rInfo.route_short_name}", long: "${rInfo.route_long_name}")` : "";
            console.log(`  [${(idx + 1).toString().padStart(2)}] "${id}" ${label}`);
        });
    } else {
        console.log("\n[INFO] No realtime route_ids matched GitHub GTFS routes.txt.");
    }

    if (unmatchedRouteIds.length > 0) {
        console.log(`\nSample Unmatched Realtime Route IDs (${Math.min(20, unmatchedRouteIds.length)} shown):`);
        unmatchedRouteIds.slice(0, 20).forEach((id, idx) => {
            console.log(`  [${(idx + 1).toString().padStart(2)}] "${id}"`);
        });
    }

    // =========================================================================
    // TEST 2: TRIP ID MATCH
    // =========================================================================
    console.log("\n================================================================================");
    console.log("  TEST 2: TRIP ID MATCH");
    console.log("================================================================================");

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

    console.log(`Total Unique Realtime Trip IDs  : ${realtimeTripIds.size}`);
    console.log(`Exact Matched in GTFS trips.txt : ${matchedTripIds.length}`);
    console.log(`Unmatched Trip IDs              : ${unmatchedTripIds.length}`);
    console.log(`Trip Match Percentage           : ${tripMatchPct}%`);

    // For matched trips, verify if GTFS trip belongs to the same route_id
    let tripRouteConsistentCount = 0;
    let tripRouteInconsistentCount = 0;
    const tripRouteMismatchesSample = [];

    if (matchedTripIds.length > 0) {
        // Evaluate relationship on realtime observations that have matched trip_id
        for (const obs of realtimeObservations) {
            if (gtfsTripToRoute.has(obs.trip_id)) {
                const gtfsRouteId = gtfsTripToRoute.get(obs.trip_id);
                if (gtfsRouteId === obs.route_id) {
                    tripRouteConsistentCount++;
                } else {
                    tripRouteInconsistentCount++;
                    if (tripRouteMismatchesSample.length < 20) {
                        tripRouteMismatchesSample.push({
                            trip_id: obs.trip_id,
                            realtime_route_id: obs.route_id,
                            gtfs_route_id: gtfsRouteId
                        });
                    }
                }
            }
        }

        const totalEvaluatedRows = tripRouteConsistentCount + tripRouteInconsistentCount;
        const consistentPct =
            totalEvaluatedRows > 0
                ? ((tripRouteConsistentCount / totalEvaluatedRows) * 100).toFixed(2)
                : "0.00";

        console.log(`\nMatched Trip Relationship Verification (Realtime row vs GTFS trips.txt):`);
        console.log(`  Observations with Matched trip_id: ${totalEvaluatedRows}`);
        console.log(`  Trip belongs to SAME route_id    : ${tripRouteConsistentCount} (${consistentPct}%)`);
        console.log(`  Trip belongs to DIFFERENT route  : ${tripRouteInconsistentCount}`);

        if (tripRouteMismatchesSample.length > 0) {
            console.log("\n  Sample Relationship Mismatches:");
            tripRouteMismatchesSample.forEach((m, idx) => {
                console.log(
                    `    [${idx + 1}] Trip "${m.trip_id}": Realtime Route="${m.realtime_route_id}" vs GTFS Route="${m.gtfs_route_id}"`
                );
            });
        }
    } else {
        console.log("\n[INFO] Zero realtime trip_ids matched GTFS trips.txt.");
        console.log("       Trip -> Route consistency check is N/A because no trips matched.");
    }

    if (unmatchedTripIds.length > 0) {
        console.log(`\nSample Unmatched Realtime Trip IDs (${Math.min(20, unmatchedTripIds.length)} shown):`);
        unmatchedTripIds.slice(0, 20).forEach((id, idx) => {
            console.log(`  [${(idx + 1).toString().padStart(2)}] "${id}"`);
        });
    }

    // =========================================================================
    // TEST 3: GPS -> GTFS STOP PROXIMITY
    // =========================================================================
    console.log("\n================================================================================");
    console.log("  TEST 3: GPS -> GTFS STOP PROXIMITY");
    console.log("================================================================================");

    let routeMatchedObservations = 0;
    let routeUnmatchedObservations = 0;
    let invalidGpsCount = 0;
    const nearestDistances = [];
    const sampleMappings = [];

    for (const obs of realtimeObservations) {
        if (!obs.validGps) {
            invalidGpsCount++;
            continue;
        }

        const candidateStops = routeStopsArrayMap.get(obs.route_id);

        if (candidateStops && candidateStops.length > 0) {
            routeMatchedObservations++;

            let bestDistance = Infinity;
            let bestStop = null;

            for (let i = 0; i < candidateStops.length; i++) {
                const s = candidateStops[i];
                const d = haversineDistanceMeters(obs.latitude, obs.longitude, s.lat, s.lon);
                if (d < bestDistance) {
                    bestDistance = d;
                    bestStop = s;
                }
            }

            if (bestStop) {
                nearestDistances.push(bestDistance);

                if (sampleMappings.length < 20) {
                    sampleMappings.push({
                        vehicle_id: obs.vehicle_id,
                        route_id: obs.route_id,
                        trip_id: obs.trip_id,
                        latitude: obs.latitude,
                        longitude: obs.longitude,
                        nearest_stop_id: bestStop.stop_id,
                        nearest_stop_name: bestStop.stop_name,
                        distance_meters: bestDistance
                    });
                }
            }
        } else {
            routeUnmatchedObservations++;
        }
    }

    console.log(`Total Observations Evaluated       : ${realtimeObservations.length}`);
    console.log(
        `Route-Matched Observations         : ${routeMatchedObservations} (${(
            (routeMatchedObservations / (realtimeObservations.length || 1)) *
            100
        ).toFixed(2)}%)`
    );
    console.log(
        `Route-Unmatched Observations       : ${routeUnmatchedObservations} (${(
            (routeUnmatchedObservations / (realtimeObservations.length || 1)) *
            100
        ).toFixed(2)}%)`
    );
    if (invalidGpsCount > 0) {
        console.log(`Invalid GPS Observations Skipped   : ${invalidGpsCount}`);
    }

    if (nearestDistances.length > 0) {
        nearestDistances.sort((a, b) => a - b);
        const count = nearestDistances.length;
        const minDist = nearestDistances[0];
        const maxDist = nearestDistances[count - 1];
        const medianDist =
            count % 2 === 1
                ? nearestDistances[Math.floor(count / 2)]
                : (nearestDistances[count / 2 - 1] + nearestDistances[count / 2]) / 2;
        const p90Dist = nearestDistances[Math.floor(count * 0.9)];

        let c50 = 0;
        let c100 = 0;
        let c250 = 0;
        let c500 = 0;
        let cOver500 = 0;

        for (const d of nearestDistances) {
            if (d <= 50) c50++;
            if (d <= 100) c100++;
            if (d <= 250) c250++;
            if (d <= 500) c500++;
            if (d > 500) cOver500++;
        }

        console.log("\nDistance Distribution to Nearest Stop on Route (meters):");
        console.log(`  Min    : ${minDist.toFixed(1)} m`);
        console.log(`  Median : ${medianDist.toFixed(1)} m`);
        console.log(`  P90    : ${p90Dist.toFixed(1)} m`);
        console.log(`  Max    : ${maxDist.toFixed(1)} m`);

        console.log("\nProximity Buckets (Count & % of Matched Observations):");
        console.log(`  <=  50m : ${c50.toString().padStart(6)} (${((c50 / count) * 100).toFixed(2)}%)`);
        console.log(`  <= 100m : ${c100.toString().padStart(6)} (${((c100 / count) * 100).toFixed(2)}%)`);
        console.log(`  <= 250m : ${c250.toString().padStart(6)} (${((c250 / count) * 100).toFixed(2)}%)`);
        console.log(`  <= 500m : ${c500.toString().padStart(6)} (${((c500 / count) * 100).toFixed(2)}%)`);
        console.log(`  >  500m : ${cOver500.toString().padStart(6)} (${((cOver500 / count) * 100).toFixed(2)}%)`);

        console.log("\n20 Sample Realtime GPS -> Nearest GTFS Stop Mappings:");
        sampleMappings.forEach((m, idx) => {
            console.log(
                `  [${(idx + 1).toString().padStart(2)}] Vehicle: ${m.vehicle_id.padEnd(12)} | Route: ${m.route_id.padEnd(8)} | Pos: (${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}) -> Nearest Stop [${m.nearest_stop_id}]: "${m.nearest_stop_name}" @ ${m.distance_meters.toFixed(1)}m`
            );
        });
    } else {
        console.log("\n[INFO] No realtime observations matched any GTFS route with stops.");
        console.log("       Proximity statistics (min, median, p90, max, buckets) are N/A (0 matched obs).");
    }

    // =========================================================================
    // TEST 4: STRUCTURAL VALIDATION
    // =========================================================================
    console.log("\n================================================================================");
    console.log("  TEST 4: STRUCTURAL VALIDATION");
    console.log("================================================================================");

    // 4A. Verify matched GTFS routes have trips
    const matchedRoutesList = matchedRouteIds;
    console.log("1. Matched GTFS Routes -> Trips Verification:");
    if (matchedRoutesList.length > 0) {
        let matchedRoutesWithTrips = 0;
        let matchedRoutesWithoutTrips = 0;
        for (const rId of matchedRoutesList) {
            const trips = gtfsRouteToTrips.get(rId);
            if (trips && trips.size > 0) {
                matchedRoutesWithTrips++;
            } else {
                matchedRoutesWithoutTrips++;
            }
        }
        console.log(`   Matched routes evaluated    : ${matchedRoutesList.length}`);
        console.log(
            `   Matched routes WITH trips   : ${matchedRoutesWithTrips} (${(
                (matchedRoutesWithTrips / matchedRoutesList.length) *
                100
            ).toFixed(2)}%)`
        );
        console.log(`   Matched routes WITHOUT trips: ${matchedRoutesWithoutTrips}`);
    } else {
        console.log("   Matched routes from realtime : 0 (No matched routes to verify).");
    }

    // Baseline across ALL GitHub GTFS routes
    let allGtfsRoutesWithTrips = 0;
    for (const [rId] of gtfsRoutes) {
        const trips = gtfsRouteToTrips.get(rId);
        if (trips && trips.size > 0) {
            allGtfsRoutesWithTrips++;
        }
    }
    console.log(`   [Baseline] Total GitHub GTFS routes.txt : ${gtfsRoutes.size}`);
    console.log(
        `   [Baseline] GTFS routes WITH trips in trips.txt: ${allGtfsRoutesWithTrips} (${(
            (allGtfsRoutesWithTrips / (gtfsRoutes.size || 1)) *
            100
        ).toFixed(2)}%)`
    );

    // 4B. Verify trips have stop_times
    console.log("\n2. Trips -> Stop Times Verification:");
    let tripsWithTimesCount = 0;
    let tripsWithoutTimesCount = 0;

    for (const [tId] of gtfsTripToRoute) {
        if (tripsWithStopTimes.has(tId)) {
            tripsWithTimesCount++;
        } else {
            tripsWithoutTimesCount++;
        }
    }

    console.log(`   Total GitHub GTFS trips in trips.txt: ${gtfsTripToRoute.size}`);
    console.log(
        `   Trips WITH entries in stop_times.txt: ${tripsWithTimesCount} (${(
            (tripsWithTimesCount / (gtfsTripToRoute.size || 1)) *
            100
        ).toFixed(2)}%)`
    );
    console.log(`   Trips WITHOUT stop_times           : ${tripsWithoutTimesCount}`);

    // If there were matched routes, check their trips specifically
    if (matchedRoutesList.length > 0) {
        let matchedRouteTripsTotal = 0;
        let matchedRouteTripsWithTimes = 0;
        for (const rId of matchedRoutesList) {
            const trips = gtfsRouteToTrips.get(rId);
            if (trips) {
                for (const tId of trips) {
                    matchedRouteTripsTotal++;
                    if (tripsWithStopTimes.has(tId)) {
                        matchedRouteTripsWithTimes++;
                    }
                }
            }
        }
        console.log(`   Trips for matched routes            : ${matchedRouteTripsTotal}`);
        console.log(
            `   Matched route trips WITH stop_times : ${matchedRouteTripsWithTimes} (${(
                (matchedRouteTripsWithTimes / (matchedRouteTripsTotal || 1)) *
                100
            ).toFixed(2)}%)`
        );
    }

    // 4C. Verify stop_time stop_ids exist in stops.txt
    console.log("\n3. Stop Times -> Stops Verification:");
    const totalDistinctStopIdsInTimes = distinctStopIdsInStopTimes.size;
    const validStopIdsCount = totalDistinctStopIdsInTimes - missingStopsInStopTimes.size;
    const missingStopIdsCount = missingStopsInStopTimes.size;

    console.log(`   Distinct stop_ids referenced in stop_times.txt : ${totalDistinctStopIdsInTimes}`);
    console.log(
        `   Referenced stop_ids FOUND in stops.txt         : ${validStopIdsCount} (${(
            (validStopIdsCount / (totalDistinctStopIdsInTimes || 1)) *
            100
        ).toFixed(2)}%)`
    );
    console.log(`   Referenced stop_ids MISSING in stops.txt       : ${missingStopIdsCount}`);

    if (missingStopIdsCount > 0) {
        console.log("   Sample Missing stop_ids in stops.txt:");
        Array.from(missingStopsInStopTimes)
            .slice(0, 10)
            .forEach((id, idx) => {
                console.log(`     [${idx + 1}] "${id}"`);
            });
    }

    console.log("\n================================================================================");
    console.log("  DIAGNOSTIC VALIDATION COMPLETE");
    console.log("================================================================================");
}

runDiagnostic().catch((err) => {
    console.error(`\n[FATAL ERROR] Diagnostic failed: ${err.message}`);
    process.exit(1);
});
