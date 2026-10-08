require("dotenv").config({ quiet: true });

const { Client } = require("pg");

const client = new Client({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || "delhi_bus_otd",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

async function testConnection() {
    try {
        await client.connect();

        const result = await client.query(
            "SELECT current_database(), PostGIS_Version();"
        );

        console.log("Database:", result.rows[0].current_database);
        console.log("PostGIS:", result.rows[0].postgis_version);
        console.log("DB connection successful.");
    } catch (error) {
        // Print only the error code, never the message (it can echo the user/password value)
        console.error("DB connection failed. Error code:", error.code || "unknown");
    } finally {
        await client.end();
    }
}

testConnection();