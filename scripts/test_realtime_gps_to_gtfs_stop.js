/**
 * Realtime GPS to GTFS Stop Proximity Diagnostic
 *
 * READ-ONLY diagnostic script.
 * Tests whether realtime OTD GPS observations can be mapped to GTFS stops
 * for routes whose route_id exists in the Mobility Database GTFS dataset.
 *
 * Route-level matching:
 * 1. Identifies latest valid realtime .csv.gz snapshot.
 * 2. Loads Mobility GTFS routes.txt, trips.txt, stops.txt, stop_times.txt.
 * 3. Maps each GTFS route_id to all unique stops serving that route.
 * 4. For each realtime observation whose route_id exists in GTFS:
 *    computes the Haversine distance to all GTFS stops on that route and
 *    identifies the nearest stop.
 * 5. Computes distance statistics (min, median, p90, max) and proximity buckets.
 * 6. Clearly distinguishes route-level proximity from trip-level assignment.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

// Base directories
const DATA_DIR = path.resolve(__dirname, "..", "data");
const GTFS_DIR = process.env.GTFS_DIR || path.resolve(DATA_DIR, "gtfs");

const ROUTES_PATH = path.join(GTFS_DIR, "routes.txt");
const TRIPS_PATH = path.join(GTFS_DIR, "trips.txt");
const STOPS_PATH = path.join(GTFS_DIR, "stops.txt");
const STOP_TIMES_PATH = path.join(GTFS_DIR, "stop_times.txt");

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
 * Recursively scans directory for .csv.gz archive files (excluding GTFS subdirectories).
 *
 * @param {string} dir - Directory to scan.
 * @returns {string[]} List of full paths to .csv.gz files.
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
            if (entry.name !== "gtfs" && entry.name !== "kaggle_gtfs") {
                results.push(...findArchiveSnapshots(fullPath));
            }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv.gz")) {
            try {
                const stat = fs.statSync(fullPath);
                // Ensure file has content (> 1KB to skip empty/interrupted polls)
                if (stat.size > 1000) {
                    results.push(fullPath);
                }
            } catch {
                // Skip unreadable files
            }
        }
    }
    return results;
}

/**
 * Computes a sort key for a snapshot file based on date folder and filename
 * Pattern: data/YYYY-MM-DD/HHMMSS.csv.gz -> "YYYY-MM-DD_HHMMSS"
 *
 * @param {string} filePath - Absolute path to file.
 * @returns {string} Sortable key string.
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
async function runGpsToStopDiagnostic() {
    console.log("=================================================");
    console.log("  REALTIME GPS TO GTFS STOP PROXIMITY DIAGNOSTIC");
    console.log("=================================================");
    console.log(`GTFS Directory : ${GTFS_DIR}`);

    // Verify GTFS files
    const gtfsFiles = [
        { name: "routes.txt", path: ROUTES_PATH },
        { name: "trips.txt", path: TRIPS_PATH },
        { name: "stops.txt", path: STOPS_PATH },
        { name: "stop_times.txt", path: STOP_TIMES_PATH }
    ];

    for (const f of gtfsFiles) {
        if (!fs.existsSync(f.path)) {
            console.error(`[ERROR] Required GTFS file missing: ${f.name} at ${f.path}`);
            process.exit(1);
        }
    }

    // Step 1: Select latest valid archive snapshot
    let snapshotPath = process.argv[2];
    if (!snapshotPath) {
        const allSnapshots = findArchiveSnapshots(DATA_DIR);
        if (allSnapshots.length === 0) {
            console.error(`[ERROR] No valid .csv.gz archive snapshots found in ${DATA_DIR}`);
            process.exit(1);
        }
        allSnapshots.sort((a, b) => getFileSortKey(a).localeCompare(getFileSortKey(b)));
        snapshotPath = allSnapshots[allSnapshots.length - 1];
    }

    console.log(`Selected Snapshot: ${snapshotPath}\n`);

    // Step 2: Load GTFS stops.txt
    process.stdout.write("1. Loading stops.txt... ");
    const stopsMap = new Map(); // stop_id -> { stop_id, stop_name, lat, lon }
    let stopIdIdx = -1;
    let stopNameIdx = -1;
    let stopLatIdx = -1;
    let stopLonIdx = -1;

    await streamFileLines(STOPS_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            stopIdIdx = headers.indexOf("stop_id");
            stopNameIdx = headers.indexOf("stop_name");
            stopLatIdx = headers.indexOf("stop_lat");
            stopLonIdx = headers.indexOf("stop_lon");
            if (stopIdIdx === -1 || stopNameIdx === -1 || stopLatIdx === -1 || stopLonIdx === -1) {
                throw new Error("stops.txt missing required headers.");
            }
            return;
        }

        const sId = cols[stopIdIdx];
        const lat = parseFloat(cols[stopLatIdx]);
        const lon = parseFloat(cols[stopLonIdx]);
        if (sId && !isNaN(lat) && !isNaN(lon)) {
            stopsMap.set(sId, {
                stop_id: sId,
                stop_name: cols[stopNameIdx] || "",
                lat,
                lon
            });
        }
    });
    console.log(`loaded ${stopsMap.size} stops.`);

    // Step 3: Load GTFS trips.txt to map trip_id -> route_id
    process.stdout.write("2. Loading trips.txt... ");
    const tripToRouteMap = new Map(); // trip_id -> route_id
    const gtfsRouteIds = new Set();
    let tripRouteIdx = -1;
    let tripIdColIdx = -1;

    await streamFileLines(TRIPS_PATH, (line, index) => {
        const cols = parseCsvLine(line);
        if (index === 0) {
            const headers = cols.map((h) => h.toLowerCase());
            tripRouteIdx = headers.indexOf("route_id");
            tripIdColIdx = headers.indexOf("trip_id");
            if (tripRouteIdx === -1 || tripIdColIdx === -1) {
                throw new Error("trips.txt missing route_id or trip_id header.");
            }
            return;
        }

        const rId = cols[tripRouteIdx];
        const tId = cols[tripIdColIdx];
        if (rId && tId) {
            tripToRouteMap.set(tId, rId);
            gtfsRouteIds.add(rId);
        }
    });
    console.log(`mapped ${tripToRouteMap.size} trips across ${gtfsRouteIds.size} routes.`);

    // Step 4: Stream stop_times.txt to group all unique stops by route_id
    process.stdout.write("3. Streaming stop_times.txt to associate stops with routes... ");
    const routeToStopsMap = new Map(); // route_id -> Map<stop_id, stopObject>
    let stTripIdIdx = -1;
    let stStopIdIdx = -1;

    await streamFileLines(STOP_TIMES_PATH, (line, index) => {
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

        // Fast extraction of trip_id and stop_id
        const firstComma = line.indexOf(",");
        if (firstComma === -1) return;
        const lineTripId = line.substring(0, firstComma).trim().replace(/^["']|["']$/g, "");

        const routeId = tripToRouteMap.get(lineTripId);
        if (!routeId) return;

        const cols = parseCsvLine(line);
        const stopId = cols[stStopIdIdx];
        const stopObj = stopsMap.get(stopId);

        if (stopObj) {
            if (!routeToStopsMap.has(routeId)) {
                routeToStopsMap.set(routeId, new Map());
            }
            routeToStopsMap.get(routeId).set(stopId, stopObj);
        }
    });
    console.log(`associated stops for ${routeToStopsMap.size} routes.`);

    // Convert route stop maps to arrays for rapid distance computation
    const routeStopsArrayMap = new Map();
    for (const [rId, stopSubMap] of routeToStopsMap.entries()) {
        routeStopsArrayMap.set(rId, Array.from(stopSubMap.values()));
    }

    // Step 5: Stream and evaluate realtime snapshot observations
    console.log("4. Evaluating realtime GPS observations from snapshot...");
    let totalObservations = 0;
    let routeMatchedObservations = 0;
    let routeUnmatchedObservations = 0;
    let matchedWithNearestStop = 0;

    const nearestDistances = [];
    const sampleMatchedMappings = [];
    const sampleUnmatchedObservations = [];

    let rVehicleIdx = -1;
    let rTripIdx = -1;
    let rRouteIdx = -1;
    let rLatIdx = -1;
    let rLonIdx = -1;

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
            rVehicleIdx = headers.indexOf("vehicle_id");
            rTripIdx = headers.indexOf("trip_id");
            rRouteIdx = headers.indexOf("route_id");
            rLatIdx = headers.indexOf("latitude");
            rLonIdx = headers.indexOf("longitude");
            if (
                rVehicleIdx === -1 ||
                rTripIdx === -1 ||
                rRouteIdx === -1 ||
                rLatIdx === -1 ||
                rLonIdx === -1
            ) {
                throw new Error("Snapshot missing required headers.");
            }
            snapLineIndex++;
            continue;
        }

        totalObservations++;
        const vehicleId = cols[rVehicleIdx];
        const tripId = cols[rTripIdx];
        const routeId = cols[rRouteIdx];
        const lat = parseFloat(cols[rLatIdx]);
        const lon = parseFloat(cols[rLonIdx]);

        if (isNaN(lat) || isNaN(lon)) {
            continue;
        }

        const candidateStops = routeStopsArrayMap.get(routeId);

        if (candidateStops && candidateStops.length > 0) {
            routeMatchedObservations++;

            let bestDistance = Infinity;
            let bestStop = null;

            for (let i = 0; i < candidateStops.length; i++) {
                const s = candidateStops[i];
                const d = haversineDistanceMeters(lat, lon, s.lat, s.lon);
                if (d < bestDistance) {
                    bestDistance = d;
                    bestStop = s;
                }
            }

            if (bestStop) {
                matchedWithNearestStop++;
                nearestDistances.push(bestDistance);

                if (sampleMatchedMappings.length < 20) {
                    sampleMatchedMappings.push({
                        vehicle_id: vehicleId,
                        route_id: routeId,
                        trip_id: tripId,
                        latitude: lat,
                        longitude: lon,
                        nearest_stop_id: bestStop.stop_id,
                        nearest_stop_name: bestStop.stop_name,
                        distance_meters: bestDistance
                    });
                }
            }
        } else {
            routeUnmatchedObservations++;
            if (sampleUnmatchedObservations.length < 5) {
                sampleUnmatchedObservations.push({
                    vehicle_id: vehicleId,
                    route_id: routeId,
                    trip_id: tripId,
                    latitude: lat,
                    longitude: lon
                });
            }
        }

        snapLineIndex++;
    }

    // Step 6: Compute statistics
    nearestDistances.sort((a, b) => a - b);
    const count = nearestDistances.length;

    let minDist = 0;
    let medianDist = 0;
    let p90Dist = 0;
    let maxDist = 0;

    if (count > 0) {
        minDist = nearestDistances[0];
        maxDist = nearestDistances[count - 1];
        medianDist =
            count % 2 === 1
                ? nearestDistances[Math.floor(count / 2)]
                : (nearestDistances[count / 2 - 1] + nearestDistances[count / 2]) / 2;
        p90Dist = nearestDistances[Math.floor(count * 0.9)];
    }

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

    // Step 7: Print detailed 20 sample mappings
    console.log("\n=================================================");
    console.log("  20 SAMPLE REALTIME GPS -> NEAREST GTFS STOP MAPPINGS");
    console.log("=================================================");
    sampleMatchedMappings.forEach((m, idx) => {
        console.log(`\n[${idx + 1}] Realtime Vehicle  : ${m.vehicle_id}`);
        console.log(`    Realtime Route ID : ${m.route_id}`);
        console.log(`    Realtime Trip ID  : ${m.trip_id}`);
        console.log(`    GPS Position      : (${m.latitude.toFixed(6)}, ${m.longitude.toFixed(6)})`);
        console.log(`    Nearest Stop ID   : ${m.nearest_stop_id}`);
        console.log(`    Nearest Stop Name : ${m.nearest_stop_name}`);
        console.log(`    Distance to Stop  : ${m.distance_meters.toFixed(1)} meters`);
    });

    if (sampleUnmatchedObservations.length > 0) {
        console.log("\n-------------------------------------------------");
        console.log("SAMPLE ROUTE-UNMATCHED OBSERVATIONS (ROUTE NOT IN GTFS)");
        console.log("-------------------------------------------------");
        sampleUnmatchedObservations.forEach((m, idx) => {
            console.log(
                `[${idx + 1}] vehicle: ${m.vehicle_id}, route_id: "${m.route_id}", trip_id: "${m.trip_id}", GPS: (${m.latitude.toFixed(6)}, ${m.longitude.toFixed(6)})`
            );
        });
    }

    // Step 8: Print structured summary
    console.log("\n=================================================");
    console.log("  DIAGNOSTIC SUMMARY");
    console.log("=================================================");
    console.log(`1. Total realtime observations examined : ${totalObservations}`);
    console.log(
        `2. Route-matched observations            : ${routeMatchedObservations} (${((routeMatchedObservations / totalObservations) * 100).toFixed(2)}%)`
    );
    console.log(
        `3. Route-unmatched observations          : ${routeUnmatchedObservations} (${((routeUnmatchedObservations / totalObservations) * 100).toFixed(2)}%)`
    );
    console.log(
        `4. Route-matched obs with nearest stop   : ${matchedWithNearestStop} (${((matchedWithNearestStop / routeMatchedObservations) * 100).toFixed(2)}%)`
    );

    console.log("\n5. Distance Statistics for Nearest GTFS Stops (meters):");
    console.log(`   Min    : ${minDist.toFixed(1)} m`);
    console.log(`   Median : ${medianDist.toFixed(1)} m`);
    console.log(`   P90    : ${p90Dist.toFixed(1)} m`);
    console.log(`   Max    : ${maxDist.toFixed(1)} m`);

    console.log("\n6. Cumulative Proximity Thresholds (Count & % of Matched):");
    console.log(
        `   <= 50 m  : ${c50.toString().padStart(6)} (${((c50 / count) * 100).toFixed(2)}%)`
    );
    console.log(
        `   <= 100 m : ${c100.toString().padStart(6)} (${((c100 / count) * 100).toFixed(2)}%)`
    );
    console.log(
        `   <= 250 m : ${c250.toString().padStart(6)} (${((c250 / count) * 100).toFixed(2)}%)`
    );
    console.log(
        `   <= 500 m : ${c500.toString().padStart(6)} (${((c500 / count) * 100).toFixed(2)}%)`
    );
    console.log(
        `   >  500 m : ${cOver500.toString().padStart(6)} (${((cOver500 / count) * 100).toFixed(2)}%)`
    );

    console.log("\n7. Architectural Distinction (Route-level vs Trip-level):");
    console.log("   - Route-level matching evaluates whether a realtime observation's route_id has");
    console.log("     associated stop definitions in GTFS and measures spatial proximity to the stops");
    console.log("     along that route corridor.");
    console.log("   - Proximity to a GTFS stop does NOT establish assignment to any specific GTFS trip.");
    console.log("     Realtime vehicle trip_ids remain decoupled from static timetable trip_ids.");
    console.log("=================================================");
}

runGpsToStopDiagnostic().catch((err) => {
    console.error(`[ERROR] Diagnostic execution failed: ${err.message}`);
    process.exit(1);
});
