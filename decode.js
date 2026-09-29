require("dotenv").config();

const https = require("https");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const apiKey = process.env.OTD_API_KEY;

const url =
  `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=${apiKey}`;

https.get(url, (res) => {

  const chunks = [];

  res.on("data", (chunk) => {
    chunks.push(chunk);
  });

  res.on("end", () => {

    try {
      const buffer = Buffer.concat(chunks);

      const feed =
        GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

      console.log("Total entities:", feed.entity.length);

      console.log(
        JSON.stringify(feed.entity.slice(0, 3), null, 2)
      );

    } catch (error) {
      console.error("Decode error:", error.message);
    }

  });

}).on("error", (error) => {
  console.error("Request failed:", error.message);
});