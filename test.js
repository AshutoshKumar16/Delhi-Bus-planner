require("dotenv").config();

const https = require("https");

const apiKey = process.env.OTD_API_KEY;

const url =
  `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=${apiKey}`;

https.get(url, (res) => {
  console.log("Status:", res.statusCode);
  console.log("Content-Type:", res.headers["content-type"]);

  const chunks = [];

  res.on("data", (chunk) => {
    chunks.push(chunk);
  });

  res.on("end", () => {
    const buffer = Buffer.concat(chunks);

    console.log("Response size:", buffer.length, "bytes");
  });

}).on("error", (error) => {
  console.error("Request failed:", error.message);
});