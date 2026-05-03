import { SmplClient } from "../src/index.js";
async function main() {
  const client = new SmplClient({ environment: "production", service: "showcase-service" });
  await client.waitUntilReady();
  const cfg = await client.config.get("showcase-user-service");
  const dbHost = cfg.get("database.host");
  console.log("database.host =", JSON.stringify(dbHost), "typeof:", typeof dbHost);
  client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
