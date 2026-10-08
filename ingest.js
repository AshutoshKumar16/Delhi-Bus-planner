// Load environment variables silently without printing
require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const readline = require("readline");
const { Pool } = require("pg");

// Parse CLI flags
const cliArgs = process.argv.slice(2);
const onceFlag = cliArgs.includes("--once");
const dryRunFlag = cliArgs.includes("--dry-run");

let maxFiles = Infinity;
const maxFilesIdx = cliArgs.indexOf("--max-files");
if (maxFilesIdx !== -1 && cliArgs[maxFilesIdx + 1]) {
  const parsedMax = parseInt(cliArgs[maxFilesIdx + 1], 10);
  if (!isNaN(parsedMax) && parsedMax > 0) {
    maxFiles = parsedMax;
  }
}

// Required CSV header columns per archive schema
const REQUIRED_CSV_COLUMNS = [
  "fetched_at_iso",
  "vehicle_id",
  "trip_id",
  "route_id",
  "latitude",
  "longitude",
  "speed",
  "vehicle_ts_unix",
  "schedule_relationship",
];

// Global shutdown tracking for clean SIGINT handling
let isShuttingDown = false;
process.on("SIGINT", () => {
  if (isShuttingDown) {
    process.exit(130);
  }
  isShuttingDown = true;
  console.log("\n[INTERRUPT] Received SIGINT. Finishing current step and shutting down cleanly...");
});

/**
 * Create PostgreSQL connection pool using environment variables only.
 * Credentials and host details are never printed or logged.
 */
function createDbPool() {
  return new Pool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Format a safe error string using only generic description and error.code.
 * Never includes raw error.message to protect database credentials or connection info.
 */
function formatSafeError(genericDesc, err) {
  if (err && err.code) {
    return `${genericDesc} [code: ${err.code}]`;
  }
  return genericDesc;
}

/**
 * Recursively discover all .csv.gz files under the data directory.
 * Ignores .tmp files and non-.csv.gz files.
 */
function findArchiveFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findArchiveFiles(fullPath));
    } else if (entry.isFile()) {
      // Must end with .csv.gz and must not be a .tmp file
      if (entry.name.endsWith(".csv.gz") && !entry.name.endsWith(".tmp")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Compute SHA-256 hash of a file via streaming.
 */
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Parse an RFC-4180 CSV line into fields, handling quotes, escaped quotes, and empty fields.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // Skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Validate a parsed row against schema and domain constraints.
 * Returns { valid: true, row } or { valid: false }.
 */
function validateRow(fields, headerMap) {
  const getField = (name) => {
    const idx = headerMap[name];
    return idx !== undefined && idx < fields.length ? fields[idx] : "";
  };

  // 1. vehicle_id must exist
  const rawVehicleId = getField("vehicle_id").trim();
  if (!rawVehicleId) {
    return { valid: false };
  }

  // 2. vehicle_ts_unix must be a valid integer
  const rawVehicleTs = getField("vehicle_ts_unix").trim();
  if (!/^-?\d+$/.test(rawVehicleTs)) {
    return { valid: false };
  }
  const vehicleTsUnix = parseInt(rawVehicleTs, 10);
  if (!Number.isSafeInteger(vehicleTsUnix) || vehicleTsUnix <= 0) {
    return { valid: false };
  }

  // 3. latitude must be between 27.5 and 29.8
  const rawLat = getField("latitude").trim();
  const lat = parseFloat(rawLat);
  if (isNaN(lat) || lat < 27.5 || lat > 29.8) {
    return { valid: false };
  }

  // 4. longitude must be between 76.0 and 78.2
  const rawLon = getField("longitude").trim();
  const lon = parseFloat(rawLon);
  if (isNaN(lon) || lon < 76.0 || lon > 78.2) {
    return { valid: false };
  }

  // 5. fetched_at_iso must be a valid timestamp
  const rawFetchedAt = getField("fetched_at_iso").trim();
  if (!rawFetchedAt) {
    return { valid: false };
  }
  const fetchedAtDate = new Date(rawFetchedAt);
  if (isNaN(fetchedAtDate.getTime())) {
    return { valid: false };
  }

  // Optional fields
  const rawTripId = getField("trip_id").trim();
  const tripId = rawTripId.length > 0 ? rawTripId : null;

  const rawRouteId = getField("route_id").trim();
  const routeId = rawRouteId.length > 0 ? rawRouteId : null;

  const rawSpeed = getField("speed").trim();
  let speed = null;
  if (rawSpeed.length > 0) {
    const parsedSpeed = parseFloat(rawSpeed);
    if (!isNaN(parsedSpeed)) {
      speed = parsedSpeed;
    }
  }

  const rawScheduleRel = getField("schedule_relationship").trim();
  const scheduleRelationship = rawScheduleRel.length > 0 ? rawScheduleRel : null;

  return {
    valid: true,
    row: {
      fetched_at: rawFetchedAt,
      vehicle_id: rawVehicleId,
      trip_id: tripId,
      route_id: routeId,
      latitude: lat,
      longitude: lon,
      speed: speed,
      vehicle_ts_unix: vehicleTsUnix,
      schedule_relationship: scheduleRelationship,
    },
  };
}

/**
 * Insert a batch of observations (at most 1000 rows) into vehicle_observations.
 * PostGIS geometry constructed via ST_SetSRID(ST_MakePoint(longitude, latitude), 4326).
 * Duplicate protection via ON CONFLICT (vehicle_id, vehicle_ts_unix) DO NOTHING.
 */
async function insertObservationBatch(client, batchRows) {
  if (!batchRows || batchRows.length === 0) {
    return { rowCount: 0 };
  }

  const valueClauses = [];
  const params = [];
  let paramIdx = 1;

  for (const row of batchRows) {
    const latParam = paramIdx + 4;
    const lonParam = paramIdx + 5;

    valueClauses.push(
      `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${latParam}, $${lonParam}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, ST_SetSRID(ST_MakePoint($${lonParam}, $${latParam}), 4326))`
    );

    params.push(
      row.fetched_at,
      row.vehicle_id,
      row.trip_id,
      row.route_id,
      row.latitude,
      row.longitude,
      row.speed,
      row.vehicle_ts_unix,
      row.schedule_relationship
    );

    paramIdx += 9;
  }

  const insertSql = `
    INSERT INTO vehicle_observations (
      fetched_at,
      vehicle_id,
      trip_id,
      route_id,
      latitude,
      longitude,
      speed,
      vehicle_ts_unix,
      schedule_relationship,
      geom
    )
    VALUES ${valueClauses.join(", ")}
    ON CONFLICT (vehicle_id, vehicle_ts_unix) DO NOTHING;
  `;

  return await client.query(insertSql, params);
}

/**
 * Record a FAILED status in ingested_files outside of any rolled-back transaction.
 * Uses ON CONFLICT (filename) DO UPDATE so failed files can be updated or retried.
 */
async function recordFileFailure(pool, relativeFilename, fileHash, failureDescription, errorCode) {
  const safeMessage = errorCode
    ? `${failureDescription} [code: ${errorCode}]`
    : failureDescription;

  const upsertFailedSql = `
    INSERT INTO ingested_files (
      filename,
      file_hash,
      imported_at,
      row_count,
      status,
      error_message
    )
    VALUES ($1, $2, NOW(), 0, 'FAILED', $3)
    ON CONFLICT (filename) DO UPDATE SET
      file_hash = EXCLUDED.file_hash,
      imported_at = NOW(),
      row_count = 0,
      status = 'FAILED',
      error_message = EXCLUDED.error_message;
  `;

  try {
    await pool.query(upsertFailedSql, [relativeFilename, fileHash, safeMessage]);
  } catch (err) {
    const errCodeStr = err && err.code ? ` [code: ${err.code}]` : "";
    console.error(`[ERROR] Failed to record FAILED status in ingested_files for ${relativeFilename}${errCodeStr}`);
  }
}

/**
 * Check existing SUCCESS records in ingested_files for this filename or hash.
 */
async function checkExistingSuccess(pool, relativeFilename, fileHash) {
  const checkSql = `
    SELECT filename, file_hash, status
    FROM ingested_files
    WHERE (filename = $1 OR file_hash = $2) AND status = 'SUCCESS'
    LIMIT 2;
  `;

  const result = await pool.query(checkSql, [relativeFilename, fileHash]);

  const sameFileRow = result.rows.find((row) => row.filename === relativeFilename);
  const sameHashRow = result.rows.find((row) => row.file_hash === fileHash);

  return { sameFileRow, sameHashRow };
}

/**
 * Process a single archive file.
 */
async function processArchiveFile(pool, fullPath, relativeFilename) {
  // Step 1: Compute SHA-256 hash of the archive
  let fileHash;
  try {
    fileHash = await computeFileHash(fullPath);
  } catch (err) {
    const safeErr = formatSafeError("Archive hash calculation failed", err);
    console.error(`[FAILED] ${relativeFilename}: ${safeErr}`);
    if (!dryRunFlag) {
      await recordFileFailure(pool, relativeFilename, "UNKNOWN", "Archive hash calculation failed", err && err.code);
    }
    return { status: "FAILED" };
  }

  // Step 2: Check if already successfully imported (or content hash duplicate)
  if (pool) {
    try {
      const { sameFileRow, sameHashRow } = await checkExistingSuccess(pool, relativeFilename, fileHash);

      if (sameFileRow) {
        if (sameFileRow.file_hash === fileHash) {
          // Same relative filename + same SHA-256 + SUCCESS -> skip
          console.log(`[SKIPPED] ${relativeFilename}: file skipped because already SUCCESS`);
          return { status: "SKIPPED_SUCCESS" };
        } else {
          // Same relative filename + different SHA-256 + SUCCESS -> suspicious archive replacement and FAIL
          console.error(
            `[FAILED] ${relativeFilename}: Suspicious archive replacement - file content hash differs from successfully imported archive record.`
          );
          return { status: "FAILED" };
        }
      }

      if (sameHashRow) {
        // Different filename + same SHA-256 as a SUCCESS file -> skip as duplicate content
        console.log(`[SKIPPED] ${relativeFilename}: file skipped because duplicate content/hash`);
        return { status: "SKIPPED_DUPLICATE_HASH" };
      }
    } catch (err) {
      if (dryRunFlag) {
        console.warn(`[DRY-RUN] Database check unavailable for ${relativeFilename} [code: ${err.code || 'UNKNOWN'}]. Proceeding with archive dry-run.`);
      } else {
        const safeErr = formatSafeError("Database status verification failed", err);
        console.error(`[FAILED] ${relativeFilename}: ${safeErr}`);
        await recordFileFailure(
          pool,
          relativeFilename,
          fileHash,
          "Database status verification failed",
          err && err.code
        );
        return { status: "FAILED" };
      }
    }
  }

  // Step 3: Stream and parse the archive
  console.log(`[IMPORTING] ${relativeFilename} (SHA-256: ${fileHash.substring(0, 12)}...)`);

  const fileStream = fs.createReadStream(fullPath);
  const gunzip = zlib.createGunzip();

  fileStream.on("error", (err) => {
    gunzip.emit("error", err);
  });

  const rl = readline.createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let headerMap = null;
  let validRowsCount = 0;
  let invalidRowsCount = 0;
  let inFileDuplicatesCount = 0;
  let insertedRowsCount = 0;

  // Track unique keys per file to prevent intra-file duplicate conflicts and count in-file duplicates
  const seenKeysInFile = new Set();
  const BATCH_SIZE = 1000;
  let currentBatch = [];

  let client = null;

  try {
    if (!dryRunFlag) {
      client = await pool.connect();
      await client.query("BEGIN");
    }

    for await (const line of rl) {
      if (isShuttingDown) {
        throw new Error("Shutdown requested during ingestion");
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      const fields = parseCsvLine(trimmed);

      // First non-empty row is the CSV header
      if (!headerMap) {
        headerMap = {};
        for (let i = 0; i < fields.length; i++) {
          headerMap[fields[i].trim()] = i;
        }

        // Validate all required archive schema columns are present in the header
        const missingColumns = REQUIRED_CSV_COLUMNS.filter(
          (col) => headerMap[col] === undefined
        );

        if (missingColumns.length > 0) {
          const err = new Error(`Archive CSV header missing required columns: ${missingColumns.join(", ")}`);
          err.code = "INVALID_HEADER";
          throw err;
        }
        continue;
      }

      // Validate data row
      const validation = validateRow(fields, headerMap);
      if (!validation.valid) {
        invalidRowsCount++;
        continue;
      }

      validRowsCount++;
      const row = validation.row;
      const observationKey = `${row.vehicle_id}_${row.vehicle_ts_unix}`;

      // Prevent duplicate observation keys within the same file from causing intra-batch conflicts
      if (seenKeysInFile.has(observationKey)) {
        inFileDuplicatesCount++;
        continue;
      }
      seenKeysInFile.add(observationKey);

      if (!dryRunFlag) {
        currentBatch.push(row);

        if (currentBatch.length >= BATCH_SIZE) {
          const insertResult = await insertObservationBatch(client, currentBatch);
          insertedRowsCount += insertResult.rowCount;
          currentBatch = [];
        }
      }
    }

    // Ensure the archive provided a valid header row
    if (!headerMap) {
      const err = new Error("Archive CSV is empty: missing header row");
      err.code = "EMPTY_ARCHIVE";
      throw err;
    }

    // Flush any remaining rows in the final batch
    if (!dryRunFlag && currentBatch.length > 0) {
      const insertResult = await insertObservationBatch(client, currentBatch);
      insertedRowsCount += insertResult.rowCount;
      currentBatch = [];
    }

    if (dryRunFlag) {
      console.log(`[DRY-RUN] Results for ${relativeFilename}:`);
      console.log(`  Valid rows count: ${validRowsCount}`);
      console.log(`  Invalid rows count: ${invalidRowsCount}`);
      console.log(`  In-file duplicate rows count: ${inFileDuplicatesCount}`);
      console.log(`  Duplicate row count: DB duplicate comparison is skipped in dry-run mode`);
      console.log(`  Database writes: SKIPPED (0 writes performed)`);
      return {
        status: "DRY_RUN",
        validRows: validRowsCount,
        invalidRows: invalidRowsCount,
        insertedRows: 0,
        duplicateRows: 0,
      };
    }

    // Calculate duplicates: valid rows minus newly inserted rows
    const duplicateRowsCount = validRowsCount - insertedRowsCount;

    // Inside the same transaction: upsert SUCCESS record into ingested_files
    const upsertSuccessSql = `
      INSERT INTO ingested_files (
        filename,
        file_hash,
        imported_at,
        row_count,
        status,
        error_message
      )
      VALUES ($1, $2, NOW(), $3, 'SUCCESS', NULL)
      ON CONFLICT (filename) DO UPDATE SET
        file_hash = EXCLUDED.file_hash,
        imported_at = NOW(),
        row_count = EXCLUDED.row_count,
        status = 'SUCCESS',
        error_message = NULL;
    `;

    await client.query(upsertSuccessSql, [relativeFilename, fileHash, insertedRowsCount]);

    // Commit both observations and ingested_files atomically
    await client.query("COMMIT");

    console.log(`[SUCCESS] Imported ${relativeFilename}`);
    console.log(`  Invalid row count: ${invalidRowsCount}`);
    console.log(`  Inserted row count: ${insertedRowsCount}`);
    console.log(`  Duplicate row count: ${duplicateRowsCount}`);

    return {
      status: "SUCCESS",
      validRows: validRowsCount,
      invalidRows: invalidRowsCount,
      insertedRows: insertedRowsCount,
      duplicateRows: duplicateRowsCount,
    };
  } catch (err) {
    if (!dryRunFlag && client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        // Rollback failure silently handled without leaking details
      }
    }

    const safeErr = formatSafeError("Archive processing or database insertion failed", err);
    console.error(`[FAILED] Import failed for ${relativeFilename}: ${safeErr}`);

    if (!dryRunFlag) {
      await recordFileFailure(
        pool,
        relativeFilename,
        fileHash,
        "Archive processing or database insertion failed",
        err && err.code
      );
    }

    return { status: "FAILED" };
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Main application coordinator.
 */
async function main() {
  const projectRoot = __dirname;
  const dataDir = path.join(projectRoot, "data");

  console.log("--------------------------------------------------");
  console.log("Delhi Bus OTD - Archive Ingestion Service");
  console.log("--------------------------------------------------");
  if (dryRunFlag) {
    console.log("Mode: DRY RUN (No database writes will be executed)");
  }
  if (onceFlag) {
    console.log("Mode: ONCE (Process current archive files once and exit)");
  }
  if (maxFiles !== Infinity) {
    console.log(`Limit: Maximum ${maxFiles} file(s)`);
  }

  // 1. Discover all .csv.gz archive files
  const discoveredFullPaths = findArchiveFiles(dataDir);

  // 2. Sort files in deterministic chronological order using relative POSIX paths
  discoveredFullPaths.sort((a, b) => {
    const relA = path.relative(projectRoot, a).split(path.sep).join("/");
    const relB = path.relative(projectRoot, b).split(path.sep).join("/");
    return relA.localeCompare(relB);
  });

  console.log(`Discovered ${discoveredFullPaths.length} archive file(s) under data/`);

  // Apply --max-files limit if configured
  let filesToProcess = discoveredFullPaths;
  if (maxFiles !== Infinity && filesToProcess.length > maxFiles) {
    filesToProcess = filesToProcess.slice(0, maxFiles);
    console.log(`Processing first ${filesToProcess.length} file(s) according to --max-files limit.`);
  }

  if (filesToProcess.length === 0) {
    console.log("No archive files to process. Exiting.");
    return;
  }

  // Initialize DB pool unless dry-run and credentials are completely absent
  let pool = null;
  if (!dryRunFlag) {
    pool = createDbPool();
  } else {
    // In dry-run, create pool if credentials exist, to check already-imported files if possible
    if (process.env.DB_NAME && process.env.DB_USER) {
      pool = createDbPool();
    }
  }

  let totalDiscovered = filesToProcess.length;
  let totalImported = 0;
  let totalSkippedSuccess = 0;
  let totalSkippedDuplicateHash = 0;
  let totalFailed = 0;
  let totalDryRun = 0;

  try {
    for (const fullPath of filesToProcess) {
      if (isShuttingDown) {
        console.log("Halting file processing due to shutdown request.");
        break;
      }

      // Archive identity relative to project root in POSIX format
      const relativeFilename = path.relative(projectRoot, fullPath).split(path.sep).join("/");

      console.log(`\nDiscovered file: ${relativeFilename}`);

      const result = await processArchiveFile(pool, fullPath, relativeFilename);

      if (result.status === "SUCCESS") {
        totalImported++;
      } else if (result.status === "SKIPPED_SUCCESS") {
        totalSkippedSuccess++;
      } else if (result.status === "SKIPPED_DUPLICATE_HASH") {
        totalSkippedDuplicateHash++;
      } else if (result.status === "FAILED") {
        totalFailed++;
      } else if (result.status === "DRY_RUN") {
        totalDryRun++;
      }
    }
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Quiet pool shutdown
      }
    }
  }

  console.log("\n==================================================");
  console.log("Ingestion Run Summary");
  console.log("==================================================");
  console.log(`Files discovered:           ${totalDiscovered}`);
  if (dryRunFlag) {
    console.log(`Dry-run files processed:    ${totalDryRun}`);
    console.log(`Files skipped (SUCCESS):    ${totalSkippedSuccess}`);
    console.log(`Files skipped (Dup Hash):   ${totalSkippedDuplicateHash}`);
  } else {
    console.log(`Files imported (SUCCESS):   ${totalImported}`);
    console.log(`Files skipped (SUCCESS):    ${totalSkippedSuccess}`);
    console.log(`Files skipped (Dup Hash):   ${totalSkippedDuplicateHash}`);
    console.log(`Files failed:               ${totalFailed}`);
  }
  console.log("==================================================");
}

main().catch((err) => {
  const codeStr = err && err.code ? ` [code: ${err.code}]` : "";
  console.error(`[FATAL] Fatal error during ingestion coordinator${codeStr}`);
  process.exit(1);
});