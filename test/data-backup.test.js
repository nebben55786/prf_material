import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import XLSX from "xlsx";
import {
  buildDataBackup,
  registerDataBackupRoute,
} from "../src/data-backup.js";

async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  return db;
}
const records = (book, name) =>
  XLSX.utils.sheet_to_json(book.Sheets[name], { defval: null });

test("Excel data backup includes every job and preserves precision, nulls, binary and long text", async (t) => {
  const db = await database(t);
  await db.exec(
    `create table jobs(id bigint primary key,job_number text); create table details(id bigserial primary key,job_id bigint references jobs(id),qty numeric(18,4),large_id bigint,notes text,empty_text text,nullable_text text,enabled boolean,file_data bytea,created_at timestamptz); insert into jobs values(101,'A'),(102,'B');`,
  );
  const note = "=SUM(1,2) ' quotes and Ω\n" + "😀".repeat(20000);
  const bytes = Buffer.alloc(20000, 255);
  await db.query(
    `insert into details(job_id,qty,large_id,notes,empty_text,nullable_text,enabled,file_data,created_at) values(102,12345678901234.5678,9007199254740993,$1,'',null,true,$2,'2026-10-06 12:00:00+00')`,
    [note, bytes],
  );
  const result = await db.transaction((tx) => buildDataBackup(tx));
  assert.equal(result.tableCount, 2);
  assert.equal(result.rowCount, 3);
  const loaded = XLSX.read(
    XLSX.write(result.workbook, {
      bookType: "xlsx",
      type: "buffer",
      compression: true,
    }),
    { type: "buffer" },
  );
  assert.deepEqual(
    records(loaded, "jobs").map((r) => r.job_number),
    ["A", "B"],
  );
  const row = records(loaded, "details")[0];
  assert.equal(row.qty, "12345678901234.5678");
  assert.equal(row.large_id, "9007199254740993");
  assert.equal(row.enabled, true);
  assert.equal(row.empty_text, "");
  const chunks = records(loaded, "_Long Values");
  const recover = (id) =>
    chunks
      .filter((r) => r.Reference === id)
      .sort((a, b) => a.Chunk - b.Chunk)
      .map((r) => r.Value)
      .join("");
  assert.equal(recover(row.notes), note);
  assert.equal(recover(row.file_data), "\\x" + bytes.toString("hex"));
  assert.ok(chunks.every((r) => r.Value.length <= 30000));
  assert.match(records(loaded, "_Nulls")[0]["Null Columns"], /nullable_text/);
  assert.equal(records(loaded, "_Sequences")[0]["Last Value"], "1");
  assert.equal(
    records(loaded, "_Columns").find((r) => r.Column === "qty")[
      "Postgres Type"
    ],
    "numeric(18,4)",
  );
  assert.equal(
    (await db.query("select count(*)::int as n from details")).rows[0].n,
    1,
  );
});

test("backup handles worksheet limits, name collisions, empty tables and formula-like text", async (t) => {
  const db = await database(t);
  await db.exec(
    `create table "_Tables"(value text);insert into "_Tables" values('=HYPERLINK("evil")'),('+cmd'),('a'); create table "abcdefghijklmnopqrstuvwxyz1234567890_a"(value text);create table "abcdefghijklmnopqrstuvwxyz1234567890_b"(value text);`,
  );
  const result = await db.transaction((tx) =>
    buildDataBackup(tx, { rowsPerSheet: 2 }),
  );
  const tableMap = Object.keys(result.workbook.Sheets)
    .filter((name) => /^_Tables(?:_\d+)?$/.test(name))
    .flatMap((name) => records(result.workbook, name));
  assert.equal(tableMap.filter((r) => r.Table === "_Tables").length, 2);
  const dataSheet = tableMap.find((r) => r.Table === "_Tables").Worksheet;
  assert.equal(result.workbook.Sheets[dataSheet].A2.t, "s");
  assert.equal(result.workbook.Sheets[dataSheet].A2.f, undefined);
  assert.equal(
    new Set(result.workbook.SheetNames.map((n) => n.toLowerCase())).size,
    result.workbook.SheetNames.length,
  );
  assert.ok(result.workbook.SheetNames.every((n) => n.length <= 31));
  assert.equal(result.rowCount, 3);
  assert.equal(tableMap.find((r) => r.Table.endsWith("_a"))["Table Rows"], 0);
});

test("current app schema exports successfully, including migrations and data from independent jobs", async (t) => {
  const db = await database(t);
  for (const file of fs
    .readdirSync(new URL("../db/migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      fs.readFileSync(
        new URL("../db/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  await db.exec(
    "create table schema_migrations(filename text primary key); insert into schema_migrations values('051_remove_reverted_shared_material_schema.sql'); insert into jobs(id,job_number) values(101,'BACKUP-A'),(102,'BACKUP-B'); insert into mrr_logs(job_id,mrr_number,notes) values(101,'MRR-000001','A notes'),(102,'MRR-000001','B notes');",
  );
  const data = await db.transaction((tx) => buildDataBackup(tx));
  assert.ok(data.tableCount > 20);
  assert.deepEqual(
    records(data.workbook, "mrr_logs").map((r) => r.notes),
    ["A notes", "B notes"],
  );
  assert.ok(
    records(data.workbook, "schema_migrations")[0].filename.endsWith(".sql"),
  );
});

test("backup endpoint uses admin authorization, downloads Excel privately and records audit", async (t) => {
  const db = await database(t);
  await db.exec("create table jobs(id bigint);insert into jobs values(1)");
  let route, audit;
  const auth = () => {},
    admin = () => {};
  registerDataBackupRoute(
    {
      get: (path, ...handlers) => {
        route = { path, handlers };
      },
    },
    {
      requireAuth: auth,
      requireRole: (roles) => {
        assert.deepEqual(roles, ["admin"]);
        return admin;
      },
      adminEquivalentRoles: ["admin"],
      asyncHandler: (fn) => fn,
      withTransaction: (fn) => db.transaction(fn),
      pool: db,
      auditLog: async (...args) => {
        audit = args;
      },
      backupTimestamp: () => "2026-10-06",
    },
  );
  assert.equal(route.path, "/user/backups/data.xlsx");
  assert.equal(route.handlers[0], auth);
  assert.equal(route.handlers[1], admin);
  const headers = {};
  let buffer;
  await route.handlers.at(-1)(
    { user: { id: 7 } },
    {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      send: (value) => {
        buffer = value;
      },
    },
  );
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.match(headers["Content-Disposition"], /\.xlsx/);
  assert.equal(records(XLSX.read(buffer, { type: "buffer" }), "jobs")[0].id, 1);
  assert.equal(audit[3], "database_excel");
  assert.match(audit[5], /tables=1;rows=1/);
});
