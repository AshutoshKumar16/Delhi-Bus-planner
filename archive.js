// Load environment variables silently
require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

// Load API key from environment
const apiKey = process.env.OTD_API_KEY;
if (!apiKey) {
  console.error("OTD_API_KEY is not set. Please set OTD_API_KEY in environment or .env file.");
  process.exit(1);
}

// Build URL exactly like discover.js (never logged or exposed)
const url = `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=${apiKey}`;

// Parse CLI flags
const cliArgs = process.argv.slice(2);
const onceFlag = cliArgs.includes("--once");
let maxPolls = Infinity;
const maxPollsIdx = cliArgs.indexOf("--max-polls");
if (maxPollsIdx !== -1 && cliArgs[maxPollsIdx + 1]) {
  const parsedMax = parseInt(cliArgs[maxPollsIdx + 1], 10);
  if (!isNaN(parsedMax) && parsedMax > 0) {
    maxPolls = parsedMax;
  }
}
if (onceFlag) {
  maxPolls = 1;
}

// Polling interval from env ARCHIVE_INTERVAL_SEC (default 300)
const intervalSec = parseInt(process.env.ARCHIVE_INTERVAL_SEC, 10) || 300;

// Optional route filter from env ROUTE_FILTER (comma-separated list of route_ids)
const routeFilterEnv = process.env.ROUTE_FILTER;
let routeFilterSet = null;
if (routeFilterEnv && routeFilterEnv.trim().length > 0) {
  routeFilterSet = new Set(
    routeFilterEnv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

// Retry configuration for network errors and 5xx responses
const RETRY_BACKOFFS_MS = [2000, 4000, 8000];
const MAX_RETRIES = 3;

// ScheduleRelationship enum lookup table
const SCHEDULE_RELATIONSHIPS = {
  0: "SCHEDULED",
  1: "ADDED",
  2: "UNSCHEDULED",
  3: "CANCELED",
  5: "REPLACEMENT",
  6: "DUPLICATED",
  7: "DELETED",
  8: "NEW",
};

// CSV header definition
const CSV_HEADER = "fetched_at_iso,vehicle_id,trip_id,route_id,latitude,longitude,speed,vehicle_ts_unix,schedule_relationship\n";

// In-memory state: vehicleId -> vehicle timestamp from previous poll
let previousPollMap = new Map();

// Shutdown coordination for clean SIGINT handling
let isShuttingDown = false;
let activeSleepTimer = null;
let activeSleepResolver = null;

// Graceful interruptable sleep
function interruptableSleep(ms) {
  if (isShuttingDown) return Promise.resolve();
  return new Promise((resolve) => {
    activeSleepResolver = resolve;
    activeSleepTimer = setTimeout(() => {
      activeSleepTimer = null;
      activeSleepResolver = null;
      resolve();
    }, ms);
  });
}

// Clean SIGINT handler
process.on("SIGINT", () => {
  if (isShuttingDown) {
    process.exit(130);
  }
  isShuttingDown = true;
  console.log("\nReceived SIGINT. Shutting down cleanly...");
  if (activeSleepTimer) {
    clearTimeout(activeSleepTimer);
    activeSleepTimer = null;
  }
  if (activeSleepResolver) {
    activeSleepResolver();
    activeSleepResolver = null;
  }
});

// Helper to convert protobuf timestamp to Unix seconds
function toUnixSeconds(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") {
    return val.toNumber();
  }
  const num = Number(val);
  return isNaN(num) || num === 0 ? null : num;
}

// Helper to resolve schedule relationship string
function getScheduleRelationship(trip) {
  if (!trip || trip.scheduleRelationship === null || trip.scheduleRelationship === undefined) {
    return "";
  }
  const sr = trip.scheduleRelationship;
  if (typeof sr === "string") return sr;
  if (typeof sr === "number") return SCHEDULE_RELATIONSHIPS[sr] || String(sr);
  return "";
}

// Escape values for CSV output
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Recursively compute total directory size in bytes
function getDirectorySize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let totalBytes = 0;
  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          totalBytes += fs.statSync(fullPath).size;
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }
  walk(dirPath);
  return totalBytes;
}

// Storage guards check before write
function checkStorageGuards() {
  const dataDir = path.join(__dirname, "data");

  // Guard (a): Total data folder size must stay below MAX_DATA_GB (default 3)
  const maxGbEnv = parseFloat(process.env.MAX_DATA_GB);
  const maxDataGb = !isNaN(maxGbEnv) && maxGbEnv > 0 ? maxGbEnv : 3;
  const maxDataBytes = maxDataGb * 1024 * 1024 * 1024;
  const currentDataBytes = getDirectorySize(dataDir);

  if (currentDataBytes >= maxDataBytes) {
    const currentGb = (currentDataBytes / (1024 * 1024 * 1024)).toFixed(2);
    console.error(
      `Storage guard error: data folder size (${currentGb} GB) exceeds MAX_DATA_GB (${maxDataGb} GB).`
    );
    return false;
  }

  // Guard (b): Free space on the drive holding data must stay above 10 GB
  const minDriveFreeBytes = 10 * 1024 * 1024 * 1024; // 10 GB
  const checkTarget = fs.existsSync(dataDir) ? dataDir : __dirname;
  try {
    const stats = fs.statfsSync(checkTarget);
    const freeBytes = Number(BigInt(stats.bavail) * BigInt(stats.bsize));
    if (freeBytes < minDriveFreeBytes) {
      const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
      console.error(
        `Storage guard error: free drive space (${freeGb} GB) is below required 10 GB.`
      );
      return false;
    }
  } catch (err) {
    console.error(`Storage guard error: failed to verify drive free space: ${err.message}`);
    return false;
  }

  return true;
}

// Format UTC snapshot file paths: data/YYYY-MM-DD/HHMMSS.csv.gz
function getUtcSnapshotPaths(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");

  const dateFolder = `${yyyy}-${mm}-${dd}`;
  const fileName = `${hh}${min}${ss}.csv.gz`;
  const folderPath = path.join(__dirname, "data", dateFolder);
  const filePath = path.join(folderPath, fileName);
  const tmpPath = path.join(folderPath, `${fileName}.tmp`);

  return { folderPath, filePath, tmpPath };
}

// Append one line per poll to logs/archive.log
function appendLogLine(entry) {
  try {
    const logsDir = path.join(__dirname, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, "archive.log");
    const line =
      [
        entry.time,
        entry.status,
        entry.elapsedMs,
        entry.responseBytes,
        entry.totalEntities,
        entry.rowsSaved,
        entry.rowsUnchanged,
        entry.rowsInvalid,
        entry.outputFileSize,
      ].join(",") + "\n";
    fs.appendFileSync(logFile, line, "utf8");
  } catch (err) {
    console.error("Failed to append to log:", err.message);
  }
}

// Single HTTPS request with 10s timeout
function makeSingleRequest(requestUrl) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let req = null;

    try {
      req = https.get(requestUrl, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (timer) clearTimeout(timer);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        });
      });

      req.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      timer = setTimeout(() => {
        req.destroy(new Error("Request timed out after 10s"));
      }, 10000);
    } catch (err) {
      if (timer) clearTimeout(timer);
      reject(err);
    }
  });
}

// Fetch feed with retry policy and backoff
async function fetchFeedWithRetries(requestUrl) {
  let attempt = 0;

  while (!isShuttingDown) {
    try {
      const response = await makeSingleRequest(requestUrl);
      const status = response.statusCode;

      // On 401, 403, 429: log status code (and retry-after) and STOP immediately
      if (status === 401 || status === 403 || status === 429) {
        const retryAfter = response.headers["retry-after"];
        const msg = `HTTP ${status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}`;
        console.error(msg);
        return { fatal: true, statusCode: status, body: response.body };
      }

      // On 5xx: retry up to 3 times with exponential backoff
      if (status >= 500 && status < 600) {
        if (attempt < MAX_RETRIES) {
          const delayMs = RETRY_BACKOFFS_MS[attempt];
          attempt++;
          console.warn(`HTTP ${status} server error. Retrying in ${delayMs / 1000}s...`);
          await interruptableSleep(delayMs);
          continue;
        } else {
          console.error(`HTTP ${status} server error: all retries exhausted. Skipping poll.`);
          return { skipped: true, statusCode: status, body: response.body };
        }
      }

      // Check non-2xx statuses
      if (status < 200 || status >= 300) {
        console.error(`HTTP ${status} unexpected status. Skipping poll.`);
        return { skipped: true, statusCode: status, body: response.body };
      }

      // Success
      return { success: true, statusCode: status, body: response.body };
    } catch (err) {
      // Network error or timeout: retry up to 3 times with exponential backoff
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BACKOFFS_MS[attempt];
        attempt++;
        console.warn(`Network error: ${err.message}. Retrying in ${delayMs / 1000}s...`);
        await interruptableSleep(delayMs);
        continue;
      } else {
        console.error(`Network error: ${err.message}. All retries exhausted. Skipping poll.`);
        return { skipped: true, statusCode: "ERROR", body: Buffer.alloc(0) };
      }
    }
  }

  return { interrupted: true };
}

// Execute a single poll cycle
async function executePoll(pollIndex) {
  const pollStartDate = new Date();
  const pollStartTime = Date.now();
  const fetchedAtIso = pollStartDate.toISOString();

  // Fetch feed with retry logic
  const result = await fetchFeedWithRetries(url);

  // If user requested shutdown during retries
  if (result.interrupted || isShuttingDown) {
    return;
  }

  // Fatal response (401, 403, 429): append log and exit immediately
  if (result.fatal) {
    appendLogLine({
      time: fetchedAtIso,
      status: result.statusCode,
      elapsedMs: Date.now() - pollStartTime,
      responseBytes: result.body ? result.body.length : 0,
      totalEntities: 0,
      rowsSaved: 0,
      rowsUnchanged: 0,
      rowsInvalid: 0,
      outputFileSize: 0,
    });
    process.exit(1);
  }

  // Skipped response (5xx or network errors exhausted, or unexpected status)
  if (result.skipped) {
    appendLogLine({
      time: fetchedAtIso,
      status: result.statusCode,
      elapsedMs: Date.now() - pollStartTime,
      responseBytes: result.body ? result.body.length : 0,
      totalEntities: 0,
      rowsSaved: 0,
      rowsUnchanged: 0,
      rowsInvalid: 0,
      outputFileSize: 0,
    });
    return;
  }

  const responseBuffer = result.body;
  const responseSizeBytes = responseBuffer.length;

  // Decode GTFS-RT protobuf message
  let feed;
  try {
    feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(responseBuffer);
  } catch (err) {
    console.error("Decode error:", err.message);
    appendLogLine({
      time: fetchedAtIso,
      status: "DECODE_ERROR",
      elapsedMs: Date.now() - pollStartTime,
      responseBytes: responseSizeBytes,
      totalEntities: 0,
      rowsSaved: 0,
      rowsUnchanged: 0,
      rowsInvalid: 0,
      outputFileSize: 0,
    });
    return;
  }

  const totalEntities = feed.entity ? feed.entity.length : 0;
  let rowsSaved = 0;
  let rowsUnchanged = 0;
  let rowsInvalid = 0;

  const currentPollMap = new Map();
  const rowsToSave = [];
  const seenInThisPoll = new Set();
  const nowSec = Math.floor(Date.now() / 1000);

  // Process and validate entities
  for (const entity of feed.entity || []) {
    const vehicle = entity.vehicle;
    if (!vehicle) {
      rowsInvalid++;
      continue;
    }

    // Route filter check
    const trip = vehicle.trip;
    const routeId = trip?.routeId != null ? String(trip.routeId).trim() : "";
    if (routeFilterSet && !routeFilterSet.has(routeId)) {
      continue;
    }

    const vehicleId = String(vehicle.vehicle?.id || entity.id || "").trim();
    const lat = vehicle.position?.latitude;
    const lon = vehicle.position?.longitude;
    const vehicleTs = toUnixSeconds(vehicle.timestamp);

    // Validation: latitude 27.5 to 29.8, longitude 76.0 to 78.2, timestamp present and not in future
    const hasValidId = vehicleId.length > 0;
    const hasValidCoords =
      typeof lat === "number" &&
      !isNaN(lat) &&
      lat >= 27.5 &&
      lat <= 29.8 &&
      typeof lon === "number" &&
      !isNaN(lon) &&
      lon >= 76.0 &&
      lon <= 78.2;
    const hasValidTs =
      vehicleTs !== null &&
      typeof vehicleTs === "number" &&
      !isNaN(vehicleTs) &&
      vehicleTs <= nowSec;

    if (!hasValidId || !hasValidCoords || !hasValidTs) {
      rowsInvalid++;
      continue;
    }

    // Avoid duplicate vehicle records within the same snapshot
    if (seenInThisPoll.has(vehicleId)) {
      continue;
    }
    seenInThisPoll.add(vehicleId);
    currentPollMap.set(vehicleId, vehicleTs);

    // Save only new vehicles or vehicles whose timestamp changed
    const prevTs = previousPollMap.get(vehicleId);
    if (prevTs !== undefined && prevTs === vehicleTs) {
      rowsUnchanged++;
    } else {
      rowsSaved++;
      const tripId = trip?.tripId != null ? String(trip.tripId) : "";
      const rawSpeed = vehicle.position?.speed;
      const speed = rawSpeed != null && !isNaN(rawSpeed) ? Number(Number(rawSpeed).toFixed(2)) : "";
      const scheduleRelationship = getScheduleRelationship(trip);

      rowsToSave.push(
        [
          csvEscape(fetchedAtIso),
          csvEscape(vehicleId),
          csvEscape(tripId),
          csvEscape(routeId),
          csvEscape(Number(lat.toFixed(6))),
          csvEscape(Number(lon.toFixed(6))),
          csvEscape(speed),
          csvEscape(vehicleTs),
          csvEscape(scheduleRelationship),
        ].join(",")
      );
    }
  }

  // Build CSV content
  const csvContent = CSV_HEADER + (rowsToSave.length > 0 ? rowsToSave.join("\n") + "\n" : "");

  // Check storage guards before write
  if (!checkStorageGuards()) {
    appendLogLine({
      time: fetchedAtIso,
      status: "STORAGE_GUARD_FAILED",
      elapsedMs: Date.now() - pollStartTime,
      responseBytes: responseSizeBytes,
      totalEntities,
      rowsSaved: 0,
      rowsUnchanged,
      rowsInvalid,
      outputFileSize: 0,
    });
    process.exit(1);
  }

  // Write snapshot as data/YYYY-MM-DD/HHMMSS.csv.gz (UTC) via a temporary file
  const { folderPath, filePath, tmpPath } = getUtcSnapshotPaths(pollStartDate);
  let outputFileSize = 0;

  try {
    fs.mkdirSync(folderPath, { recursive: true });

    const gzippedBuffer = zlib.gzipSync(Buffer.from(csvContent, "utf8"));
    fs.writeFileSync(tmpPath, gzippedBuffer);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.renameSync(tmpPath, filePath);

    outputFileSize = fs.statSync(filePath).size;

    // Update previous poll map only after snapshot is successfully written and measured
    previousPollMap = currentPollMap;
  } catch (err) {
    // Clean up temporary file if write or rename failed
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup error
    }

    console.error("Write error:", err.message);

    appendLogLine({
      time: fetchedAtIso,
      status: "WRITE_ERROR",
      elapsedMs: Date.now() - pollStartTime,
      responseBytes: responseSizeBytes,
      totalEntities,
      rowsSaved: 0,
      rowsUnchanged,
      rowsInvalid,
      outputFileSize: 0,
    });
    return;
  }

  const elapsedMs = Date.now() - pollStartTime;

  // Append poll summary to logs/archive.log
  appendLogLine({
    time: fetchedAtIso,
    status: result.statusCode,
    elapsedMs,
    responseBytes: responseSizeBytes,
    totalEntities,
    rowsSaved,
    rowsUnchanged,
    rowsInvalid,
    outputFileSize,
  });

  console.log(
    `[${fetchedAtIso}] Poll #${pollIndex}: status ${result.statusCode}, ${elapsedMs}ms, ${totalEntities} entities, ${rowsSaved} saved, ${rowsUnchanged} unchanged, ${rowsInvalid} invalid, file: ${outputFileSize}B`
  );
}

// Main polling loop
async function main() {
  let pollIndex = 0;

  while (!isShuttingDown) {
    pollIndex++;
    await executePoll(pollIndex);

    // Stop if shutting down, or if limits reached
    if (isShuttingDown || onceFlag || pollIndex >= maxPolls) {
      break;
    }

    // Wait interval before next poll; guaranteed non-overlapping
    await interruptableSleep(intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
