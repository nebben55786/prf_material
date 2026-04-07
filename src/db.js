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

const defaultVendorCategories = [
  "pipe",
  "civil",
  "steel",
  "pipe fab",
  "support fab",
  "grout",
  "tubing"
];

export let vendorCategories = [...defaultVendorCategories];
export let permissionMatrix = {};

export function setVendorCategories(values) {
  vendorCategories = [...values];
}

export function setPermissionMatrix(values) {
  permissionMatrix = values || {};
}

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
  await pool.query(`
    create table if not exists schema_migrations (
      id bigserial primary key,
      filename text not null unique,
      applied_at timestamptz not null default now()
    )
  `);

  const migrationDir = path.join(process.cwd(), "db", "migrations");
  const migrationFiles = fs.existsSync(migrationDir)
    ? fs.readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()
    : [];
  const tableCheck = await pool.query(`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'app_settings'
    ) as has_app_settings,
    exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'users'
    ) as has_users
  `);
  const hasAppSettings = Boolean(tableCheck.rows[0]?.has_app_settings);
  const hasUsers = Boolean(tableCheck.rows[0]?.has_users);
  const hasLegacySchema = hasAppSettings || hasUsers;
  const appliedRows = await pool.query("select filename from schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => String(row.filename)));

  for (const filename of migrationFiles) {
    if (applied.has(filename)) continue;
    if (filename === "001_initial_schema.sql" && hasLegacySchema) {
      await pool.query("insert into schema_migrations (filename) values ($1) on conflict (filename) do nothing", [filename]);
      applied.add(filename);
      continue;
    }
    const migrationSql = fs.readFileSync(path.join(migrationDir, filename), "utf8");
    await withTransaction(async (client) => {
      await client.query(migrationSql);
      await client.query("insert into schema_migrations (filename) values ($1)", [filename]);
    });
  }

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

  const defaultJobNumber = process.env.DEFAULT_JOB_NUMBER || "0000";
  await pool.query(
    `
      insert into app_settings (key, value)
      values ('job_number', $1)
      on conflict (key) do nothing
    `,
    [defaultJobNumber]
  );

  await pool.query(
    `
      insert into app_settings (key, value)
      values ('vendor_categories', $1)
      on conflict (key) do nothing
    `,
    [defaultVendorCategories.join(",")]
  );

  await pool.query(
    `
      insert into app_settings (key, value)
      values ('permission_matrix', '{}')
      on conflict (key) do nothing
    `
  );

  const categorySetting = await pool.query("select value from app_settings where key = 'vendor_categories'");
  const loadedCategories = String(categorySetting.rows[0]?.value || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  vendorCategories = loadedCategories.length ? loadedCategories : [...defaultVendorCategories];

  const permissionSetting = await pool.query("select value from app_settings where key = 'permission_matrix'");
  try {
    permissionMatrix = JSON.parse(String(permissionSetting.rows[0]?.value || "{}"));
  } catch {
    permissionMatrix = {};
  }
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
