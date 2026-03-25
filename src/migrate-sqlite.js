import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { initDb, pool, withTransaction } from "./db.js";

function sqliteValue(value) {
  return value === undefined ? null : value;
}

function textOrNull(value) {
  const next = sqliteValue(value);
  if (next === null) return null;
  const text = String(next).trim();
  return text === "" ? null : text;
}

function loadTable(db, tableName) {
  const result = db.exec(`select * from ${tableName}`);
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

async function setSequence(client, tableName) {
  await client.query(
    `
      select setval(
        pg_get_serial_sequence($1, 'id'),
        coalesce((select max(id) from ${tableName}), 1),
        true
      )
    `,
    [tableName]
  );
}

async function main() {
  const sqlitePath = path.join(process.cwd(), "app.db");
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }

  await initDb();

  const SQL = await initSqlJs();
  const sqliteBuffer = fs.readFileSync(sqlitePath);
  const sqliteDb = new SQL.Database(sqliteBuffer);

  const users = loadTable(sqliteDb, "users");
  const vendors = loadTable(sqliteDb, "vendors");
  const materialItems = loadTable(sqliteDb, "material_items");
  const rfqs = loadTable(sqliteDb, "rfqs");
  const rfqItems = loadTable(sqliteDb, "rfq_items");
  const quotes = loadTable(sqliteDb, "quotes");
  const purchaseOrders = loadTable(sqliteDb, "purchase_orders");
  const poLines = loadTable(sqliteDb, "po_lines");
  const receipts = loadTable(sqliteDb, "receipts");
  const auditLog = loadTable(sqliteDb, "audit_log");

  await withTransaction(async (client) => {
    await client.query("truncate table receipts, po_lines, purchase_orders, quotes, rfq_items, rfqs, material_items, vendors, audit_log, users restart identity cascade");

    for (const row of users) {
      await client.query(
        "insert into users (id, username, password_hash, role, created_at) values ($1, $2, $3, $4, $5)",
        [row.id, row.username, row.password_hash, row.role, textOrNull(row.created_at) || new Date().toISOString()]
      );
    }

    for (const row of vendors) {
      await client.query(
        "insert into vendors (id, name, email, phone, categories, created_at) values ($1, $2, $3, $4, $5, $6)",
        [row.id, row.name, textOrNull(row.email), textOrNull(row.phone), textOrNull(row.categories) || "", textOrNull(row.created_at) || new Date().toISOString()]
      );
    }

    for (const row of materialItems) {
      await client.query(
        "insert into material_items (id, item_code, description, material_type, uom, created_at) values ($1, $2, $3, $4, $5, $6)",
        [row.id, row.item_code, row.description, row.material_type, row.uom, textOrNull(row.created_at) || new Date().toISOString()]
      );
    }

    for (const row of rfqs) {
      await client.query(
        "insert into rfqs (id, rfq_no, project_name, due_date, status, created_at) values ($1, $2, $3, $4, $5, $6)",
        [row.id, row.rfq_no, row.project_name, textOrNull(row.due_date), row.status || "OPEN", textOrNull(row.created_at) || new Date().toISOString()]
      );
    }

    for (const row of rfqItems) {
      await client.query(
        `
          insert into rfq_items (id, rfq_id, material_item_id, size_1, size_2, thk_1, thk_2, qty, notes, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          row.id,
          row.rfq_id,
          row.material_item_id,
          textOrNull(row.size_1),
          textOrNull(row.size_2),
          textOrNull(row.thk_1),
          textOrNull(row.thk_2),
          Number(row.qty || 0),
          textOrNull(row.notes),
          textOrNull(row.updated_at) || new Date().toISOString()
        ]
      );
    }

    for (const row of quotes) {
      await client.query(
        "insert into quotes (id, rfq_item_id, vendor_id, unit_price, lead_days, quoted_at) values ($1, $2, $3, $4, $5, $6)",
        [row.id, row.rfq_item_id, row.vendor_id, Number(row.unit_price || 0), Number(row.lead_days || 0), textOrNull(row.quoted_at) || new Date().toISOString()]
      );
    }

    for (const row of purchaseOrders) {
      await client.query(
        `
          insert into purchase_orders (id, po_no, vendor_id, rfq_id, status, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          row.id,
          row.po_no,
          row.vendor_id,
          sqliteValue(row.rfq_id),
          row.status || "OPEN",
          textOrNull(row.created_at) || new Date().toISOString(),
          textOrNull(row.updated_at) || textOrNull(row.created_at) || new Date().toISOString()
        ]
      );
    }

    for (const row of poLines) {
      await client.query(
        `
          insert into po_lines (id, po_id, material_item_id, size_1, size_2, thk_1, thk_2, qty_ordered, unit_price, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          row.id,
          row.po_id,
          row.material_item_id,
          textOrNull(row.size_1),
          textOrNull(row.size_2),
          textOrNull(row.thk_1),
          textOrNull(row.thk_2),
          Number(row.qty_ordered || 0),
          Number(row.unit_price || 0),
          textOrNull(row.updated_at) || new Date().toISOString()
        ]
      );
    }

    for (const row of receipts) {
      await client.query(
        `
          insert into receipts (id, po_line_id, qty_received, warehouse, location, osd_status, osd_notes, received_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          row.id,
          row.po_line_id,
          Number(row.qty_received || 0),
          row.warehouse,
          row.location,
          row.osd_status,
          textOrNull(row.osd_notes),
          textOrNull(row.received_at) || new Date().toISOString()
        ]
      );
    }

    for (const row of auditLog) {
      await client.query(
        `
          insert into audit_log (id, user_id, action, entity_type, entity_id, details, created_at)
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          row.id,
          sqliteValue(row.user_id),
          row.action,
          row.entity_type,
          textOrNull(row.entity_id),
          textOrNull(row.details),
          textOrNull(row.created_at) || new Date().toISOString()
        ]
      );
    }

    for (const tableName of ["users", "vendors", "material_items", "rfqs", "rfq_items", "quotes", "purchase_orders", "po_lines", "receipts", "audit_log"]) {
      await setSequence(client, tableName);
    }
  });

  sqliteDb.close();
  console.log("SQLite data migrated into Postgres.");
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
