import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set.");
}

const useSsl =
  !databaseUrl.includes("localhost") &&
  !databaseUrl.includes("127.0.0.1") &&
  !databaseUrl.includes("host.docker.internal");

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

export const vendorCategories = [
  "pipe",
  "civil",
  "steel",
  "pipe fab",
  "support fab",
  "grout",
  "tubing"
];

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function initDb() {
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);

  const username = process.env.DEFAULT_ADMIN_USERNAME || "admin";
  const password = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `
      insert into users (username, password_hash, role)
      values ($1, $2, 'admin')
      on conflict (username) do nothing
    `,
    [username, passwordHash]
  );
}

export async function auditLog(client, userId, action, entityType, entityId = "", details = "") {
  await client.query(
    `
      insert into audit_log (user_id, action, entity_type, entity_id, details)
      values ($1, $2, $3, $4, $5)
    `,
    [userId || null, action, entityType, String(entityId || ""), details]
  );
}
