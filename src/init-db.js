import { initDb, pool } from "./db.js";

async function main() {
  await initDb();
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
