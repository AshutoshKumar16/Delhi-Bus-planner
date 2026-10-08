/**
 * Diagnostic Script: Extract route_id and trip_id sample from latest OTD archive snapshot
 *
 * Requirements:
 * 1. Recursively scan data/ for .csv.gz archive files.
 * 2. Select latest available valid .csv.gz file by actual path/date and filename.
 * 3. Decompress snapshot using Node.js built-ins.
 * 4. Extract route_id and trip_id.
 * 5. Write to %TEMP%\ids_sample.csv.
 * 6. Print snapshot path, row count, output path.
 * 7. Non-zero exit code if no files found or on error.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const os = require("os");

const DATA_DIR = path.resolve(__dirname, "..", "data");

/**
 * Recursively scans a directory for files matching .csv.gz
 *
 * @param {string} dir - Directory path to search.
 * @returns {string[]} List of absolute paths to .csv.gz files.
 */
function findCsvGzFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) {
        return results;
    }

    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.error(`Warning: Cannot read directory ${dir}: ${err.message}`);
        return results;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
            if (entry.isDirectory()) {
                results.push(...findCsvGzFiles(fullPath));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv.gz")) {
                results.push(fullPath);
            }
        } catch {
            // Skip inaccessible paths
        }
    }
    return results;
}

/**
 * Computes a sort key for a snapshot file based on date folder and filename
 * Pattern: data/YYYY-MM-DD/HHMMSS.csv.gz -> "YYYY-MM-DD_HHMMSS"
 * Fallback: file mtimeMs ISO string
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
 * Parses a single CSV line supporting standard comma separation and quotes.
 *
 * @param {string} line - CSV row string.
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
 * Reads and decompresses the selected snapshot, extracts route_id and trip_id,
 * and writes the result to the destination CSV file.
 *
 * @param {string} snapshotPath - Input .csv.gz file.
 * @param {string} outputPath - Destination CSV file.
 * @returns {Promise<number>} Number of extracted data rows.
 */
function processSnapshot(snapshotPath, outputPath) {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(snapshotPath);
        const gunzip = zlib.createGunzip();
        const writeStream = fs.createWriteStream(outputPath, { encoding: "utf8" });

        const rl = readline.createInterface({
            input: readStream.pipe(gunzip),
            crlfDelay: Infinity
        });

        let isHeader = true;
        let routeIdx = -1;
        let tripIdx = -1;
        let rowCount = 0;
        let finished = false;

        function fail(err) {
            if (!finished) {
                finished = true;
                rl.close();
                readStream.destroy();
                gunzip.destroy();
                writeStream.destroy();
                reject(err);
            }
        }

        readStream.on("error", fail);
        gunzip.on("error", fail);
        writeStream.on("error", fail);

        writeStream.write("route_id,trip_id\n");

        rl.on("line", (line) => {
            const trimmed = line.replace(/^\uFEFF/, "").trim();
            if (!trimmed) return;

            const cols = parseCsvLine(trimmed);

            if (isHeader) {
                isHeader = false;
                const normalized = cols.map((c) => c.toLowerCase());
                routeIdx = normalized.indexOf("route_id");
                tripIdx = normalized.indexOf("trip_id");

                if (routeIdx === -1 || tripIdx === -1) {
                    fail(new Error(`Snapshot missing required header columns ('route_id' or 'trip_id'). Found: ${line}`));
                }
                return;
            }

            const routeId = routeIdx !== -1 && cols[routeIdx] !== undefined ? cols[routeIdx] : "";
            const tripId = tripIdx !== -1 && cols[tripIdx] !== undefined ? cols[tripIdx] : "";

            writeStream.write(`${routeId},${tripId}\n`);
            rowCount++;
        });

        rl.on("close", () => {
            if (!finished) {
                finished = true;
                writeStream.end(() => {
                    resolve(rowCount);
                });
            }
        });
    });
}

/**
 * Main execution
 */
async function main() {
    const allFiles = findCsvGzFiles(DATA_DIR);

    if (allFiles.length === 0) {
        console.error(`[ERROR] No .csv.gz archive files found in: ${DATA_DIR}`);
        process.exit(1);
    }

    // Filter out zero-byte or inaccessible files
    const validFiles = allFiles.filter((filePath) => {
        try {
            const stat = fs.statSync(filePath);
            return stat.isFile() && stat.size > 0;
        } catch {
            return false;
        }
    });

    if (validFiles.length === 0) {
        console.error(`[ERROR] No valid non-empty .csv.gz archive files found in: ${DATA_DIR}`);
        process.exit(1);
    }

    // Sort ascending by chronological key so last element is latest
    validFiles.sort((a, b) => {
        const keyA = getFileSortKey(a);
        const keyB = getFileSortKey(b);
        return keyA.localeCompare(keyB);
    });

    const latestSnapshot = validFiles[validFiles.length - 1];

    const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
    const outputPath = path.join(tempDir, "ids_sample.csv");

    try {
        const rowCount = await processSnapshot(latestSnapshot, outputPath);
        console.log(`Selected snapshot: ${latestSnapshot}`);
        console.log(`Row count: ${rowCount}`);
        console.log(`Output path: ${outputPath}`);
        process.exit(0);
    } catch (err) {
        console.error(`[ERROR] Failed to process snapshot: ${err.message}`);
        process.exit(1);
    }
}

main();
