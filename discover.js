// Load environment variables from .env
require("dotenv").config();

const https = require("https");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

// Load API key from environment variable
const apiKey = process.env.OTD_API_KEY;

// Build the request URL exactly like test.js (do not log or expose the URL or key)
const url =
  `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=${apiKey}`;

// Helper function to safely convert protobuf timestamp (number or Long object) to Unix seconds
function toUnixSeconds(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "object" && typeof val.toNumber === "function") {
    return val.toNumber();
  }
  const num = Number(val);
  return isNaN(num) || num === 0 ? null : num;
}

// Track start time to calculate elapsed duration
const startTime = Date.now();

// Make single HTTPS GET request
https.get(url, (res) => {
  const chunks = [];

  res.on("data", (chunk) => {
    chunks.push(chunk);
  });

  res.on("end", () => {
    try {
      const elapsedTimeMs = Date.now() - startTime;
      const buffer = Buffer.concat(chunks);
      const responseSizeBytes = buffer.length;

      // 1. HTTP status, elapsed time (ms), response size (bytes)
      console.log("=== 1. Request Summary ===");
      console.log(`HTTP Status: ${res.statusCode}`);
      console.log(`Elapsed Time: ${elapsedTimeMs} ms`);
      console.log(`Response Size: ${responseSizeBytes} bytes\n`);

      // 2. Whitelisted response headers
      console.log("=== 2. Whitelisted Headers ===");
      const allowedHeaders = new Set([
        "date",
        "last-modified",
        "etag",
        "cache-control",
        "content-length",
        "content-type",
        "retry-after",
      ]);

      let headerFound = false;
      for (const [key, value] of Object.entries(res.headers)) {
        const lowerKey = key.toLowerCase();
        if (allowedHeaders.has(lowerKey) || lowerKey.startsWith("x-ratelimit")) {
          console.log(`  ${key}: ${value}`);
          headerFound = true;
        }
      }
      if (!headerFound) {
        console.log("  (None present)");
      }
      console.log();

      // Check HTTP status before decoding
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.log(`Non-success status code (${res.statusCode}). Skipping decode.`);
        return;
      }

      // Decode protobuf payload into GTFS-RT FeedMessage
      const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
      const nowSec = Date.now() / 1000;

      // 3. Feed header timestamp as ISO time, and its age in seconds versus now
      console.log("=== 3. Feed Header Timestamp ===");
      const headerTimestampSec = toUnixSeconds(feed.header?.timestamp);
      if (headerTimestampSec) {
        const headerIso = new Date(headerTimestampSec * 1000).toISOString();
        const headerAgeSec = (nowSec - headerTimestampSec).toFixed(1);
        console.log(`Feed Timestamp (ISO): ${headerIso}`);
        console.log(`Age vs Now: ${headerAgeSec} seconds\n`);
      } else {
        console.log("Feed Timestamp: Not present\n");
      }

      // 4. Entity analysis and counts
      console.log("=== 4. Entity Statistics ===");
      const totalEntities = feed.entity ? feed.entity.length : 0;
      let countWithVehicle = 0;
      let countWithTripId = 0;
      let countWithRouteId = 0;
      let countWithPosition = 0;

      const vehicleIdCounts = new Map();
      const vehicleAges = [];
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let validPositionCount = 0;

      for (const entity of (feed.entity || [])) {
        const vehicle = entity.vehicle;
        if (vehicle) {
          countWithVehicle++;

          // Check for tripId and routeId
          if (vehicle.trip) {
            if (vehicle.trip.tripId) countWithTripId++;
            if (vehicle.trip.routeId) countWithRouteId++;
          }

          // Check for position coordinates
          if (vehicle.position) {
            countWithPosition++;
            const lat = vehicle.position.latitude;
            const lon = vehicle.position.longitude;
            if (typeof lat === "number" && !isNaN(lat) && typeof lon === "number" && !isNaN(lon)) {
              validPositionCount++;
              if (lat < minLat) minLat = lat;
              if (lat > maxLat) maxLat = lat;
              if (lon < minLon) minLon = lon;
              if (lon > maxLon) maxLon = lon;
            }
          }

          // Track vehicle ID
          const vid = vehicle.vehicle?.id || entity.id;
          if (vid) {
            vehicleIdCounts.set(vid, (vehicleIdCounts.get(vid) || 0) + 1);
          }

          // Track vehicle timestamp age
          const vehicleTimestampSec = toUnixSeconds(vehicle.timestamp);
          if (vehicleTimestampSec) {
            vehicleAges.push(nowSec - vehicleTimestampSec);
          }
        }
      }

      // Compute unique and duplicate vehicle IDs
      const uniqueVehicleIdsCount = vehicleIdCounts.size;
      const duplicateVehicleIds = [];
      for (const [vid, count] of vehicleIdCounts.entries()) {
        if (count > 1) {
          duplicateVehicleIds.push({ id: vid, count });
        }
      }

      console.log(`Total Entities: ${totalEntities}`);
      console.log(`Entities with Vehicle: ${countWithVehicle}`);
      console.log(`Entities with tripId: ${countWithTripId}`);
      console.log(`Entities with routeId: ${countWithRouteId}`);
      console.log(`Entities with Position: ${countWithPosition}`);
      console.log(`Unique Vehicle IDs: ${uniqueVehicleIdsCount}`);
      console.log(`Duplicate Vehicle IDs: ${duplicateVehicleIds.length}`);
      if (duplicateVehicleIds.length > 0) {
        console.log(`  Duplicate IDs: ${duplicateVehicleIds.map(d => `${d.id} (${d.count}x)`).join(", ")}`);
      }
      console.log();

      // 5. Vehicle timestamp age statistics (min, median, max)
      console.log("=== 5. Vehicle Timestamp Age vs Now ===");
      if (vehicleAges.length > 0) {
        vehicleAges.sort((a, b) => a - b);
        const minAge = vehicleAges[0];
        const maxAge = vehicleAges[vehicleAges.length - 1];
        let medianAge;
        const mid = Math.floor(vehicleAges.length / 2);
        if (vehicleAges.length % 2 === 1) {
          medianAge = vehicleAges[mid];
        } else {
          medianAge = (vehicleAges[mid - 1] + vehicleAges[mid]) / 2;
        }

        console.log(`Vehicles with timestamp: ${vehicleAges.length}`);
        console.log(`Min Age: ${minAge.toFixed(1)} seconds`);
        console.log(`Median Age: ${medianAge.toFixed(1)} seconds`);
        console.log(`Max Age: ${maxAge.toFixed(1)} seconds\n`);
      } else {
        console.log("No vehicle timestamps found.\n");
      }

      // 6. Latitude/longitude min and max
      console.log("=== 6. Coordinates Range ===");
      if (validPositionCount > 0) {
        console.log(`Valid Coordinates Count: ${validPositionCount}`);
        console.log(`Latitude:  min = ${minLat.toFixed(6)}, max = ${maxLat.toFixed(6)}`);
        console.log(`Longitude: min = ${minLon.toFixed(6)}, max = ${maxLon.toFixed(6)}`);
      } else {
        console.log("No valid coordinates found.");
      }

    } catch (error) {
      // Print only error.message on decode or processing failure
      console.error("Decode/Processing failed:", error.message);
    }
  });

}).on("error", (error) => {
  // Print only error.message on request failure
  console.error("Request failed:", error.message);
});
