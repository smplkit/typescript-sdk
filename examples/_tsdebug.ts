import { SmplClient } from "../src/index.js";
const client = new SmplClient({ environment: "production", service: "showcase-service" });
await client.waitUntilReady();
const cfg = await client.config.get("showcase-user-service");
const dbHost = cfg.get("database.host");
console.log("database.host =", JSON.stringify(dbHost), "typeof:", typeof dbHost);
const maxRetries = cfg.get("max_retries");
console.log("max_retries =", JSON.stringify(maxRetries), "typeof:", typeof maxRetries);
client.close();
