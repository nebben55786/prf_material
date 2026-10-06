import XLSX from "xlsx";

const identifier = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const integerTypes = new Set([
  "smallint",
  "integer",
  "bigint",
  "real",
  "double precision",
]);
function excelValue(value, type) {
  if (value === null) return null;
  if (type === "boolean") return value === "true" || value === "t";
  if (integerTypes.has(type) || /^numeric(?:\(|$)/.test(type)) {
    if (
      ["smallint", "integer", "bigint"].includes(type) &&
      value.replace(/^-/, "").length > 15
    )
      return value;
    const digits = value
      .replace(/[^0-9]/g, "")
      .replace(/^0+/, "")
      .replace(/0+$/, "");
    const number = Number(value);
    if (digits.length <= 15 && Number.isFinite(number)) return number;
  }
  return value;
}

export async function buildDataBackup(
  db,
  { rowsPerSheet = 1048575, createdAt = new Date(), revision = "" } = {},
) {
  // The caller supplies a transaction. All tables reflect one consistent snapshot.
  await db.query("set transaction isolation level repeatable read read only");
  await db.query("set local bytea_output = 'hex'");
  const tables = (
    await db.query(`
    select n.nspname as schema_name,c.relname as table_name,c.oid
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=current_schema() and c.relkind in ('r','p') and not c.relispartition
    order by c.relname
  `)
  ).rows;
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set();
  const tableIndex = [],
    columnIndex = [],
    longValues = [],
    nullValues = [],
    sequences = [];
  function addSheets(name, headers, records) {
    const parts = [];
    for (
      let offset = 0;
      offset < Math.max(records.length, 1);
      offset += rowsPerSheet
    ) {
      let suffix = "",
        counter = 1;
      const clean = name.replace(/[\\/?*\[\]:]/g, "_") || "Table";
      let sheetName = clean.slice(0, 31);
      while (usedNames.has(sheetName.toLowerCase())) {
        suffix = "_" + ++counter;
        sheetName = clean.slice(0, 31 - suffix.length) + suffix;
      }
      usedNames.add(sheetName.toLowerCase());
      const rows = records.slice(offset, offset + rowsPerSheet);
      const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      sheet["!cols"] = headers.map((h) => ({
        wch: Math.min(35, Math.max(14, h.length + 2)),
      }));
      if (headers.length)
        sheet["!autofilter"] = {
          ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows.length, c: headers.length - 1 },
          }),
        };
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
      parts.push({ sheetName, offset, rows: rows.length });
    }
    return parts;
  }
  // Reserve metadata names before user table names to prevent collisions.
  addSheets(
    "_Backup",
    ["Property", "Value"],
    [
      ["Format", "PRF material data backup v1"],
      ["Created UTC", createdAt.toISOString()],
      ["Revision", revision],
      [
        "Scope",
        "All application tables and all jobs; consistent database snapshot",
      ],
      [
        "Null values",
        "_Nulls records original null columns by table and 1-based data row",
      ],
      [
        "Long values",
        "@long:N references _Long Values; concatenate chunks in order to recover the exact value",
      ],
      [
        "Binary values",
        "Database bytea values are hexadecimal strings beginning with \\x",
      ],
      ["Precision", "Numbers exceeding Excel precision are stored as text"],
      [
        "Restore",
        "Data backup only; restore into the matching app database schema. No in-app Excel restore is included.",
      ],
      [
        "External files",
        "Blob file references are included. Download Blob File Backup separately for the actual uploaded files.",
      ],
    ],
  );
  for (const name of [
    "_Tables",
    "_Columns",
    "_Nulls",
    "_Long Values",
    "_Sequences",
  ])
    usedNames.add(name.toLowerCase());
  for (const table of tables) {
    const columns = (
      await db.query(
        `select attname as name,format_type(atttypid,atttypmod) as type,attnotnull as not_null,attidentity as identity,attgenerated as generated from pg_attribute where attrelid=$1 and attnum>0 and not attisdropped order by attnum`,
        [table.oid],
      )
    ).rows;
    const name = table.table_name;
    for (const col of columns)
      columnIndex.push([
        table.schema_name,
        name,
        col.name,
        col.type,
        col.not_null,
        col.identity,
        col.generated,
      ]);
    const select = columns
      .map((col) => `${identifier(col.name)}::text as ${identifier(col.name)}`)
      .join(",");
    const rows = (
      await db.query(
        `select ${select} from ${identifier(table.schema_name)}.${identifier(name)}`,
      )
    ).rows;
    const records = rows.map((row, index) => {
      const nulls = columns
        .filter((col) => row[col.name] === null)
        .map((col) => col.name);
      if (nulls.length)
        nullValues.push([
          table.schema_name,
          name,
          index + 1,
          JSON.stringify(nulls),
        ]);
      return columns.map((col) => {
        const raw = row[col.name];
        if (raw !== null && raw.length > 30000) {
          const id = "@long:" + (longValues.length + 1);
          let part = 0;
          for (let offset = 0; offset < raw.length;) {
            let end = Math.min(offset + 30000, raw.length);
            const last = raw.charCodeAt(end - 1);
            if (end < raw.length && last >= 0xd800 && last <= 0xdbff) end--;
            longValues.push([
              id,
              table.schema_name,
              name,
              index + 1,
              col.name,
              ++part,
              raw.slice(offset, end),
            ]);
            offset = end;
          }
          return id;
        }
        return excelValue(raw, col.type);
      });
    });
    for (const part of addSheets(
      name.startsWith("_") ? "data" + name : name,
      columns.map((col) => col.name),
      records,
    ))
      tableIndex.push([
        table.schema_name,
        name,
        part.sheetName,
        part.offset + 1,
        part.rows,
        rows.length,
      ]);
  }
  const sequenceList = (
    await db.query(
      `select n.nspname as schema_name,c.relname as sequence_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and n.nspname=current_schema() order by c.relname`,
    )
  ).rows;
  for (const seq of sequenceList) {
    const state = (
      await db.query(
        `select last_value::text as last_value,is_called from ${identifier(seq.schema_name)}.${identifier(seq.sequence_name)}`,
      )
    ).rows[0];
    sequences.push([
      seq.schema_name,
      seq.sequence_name,
      state.last_value,
      state.is_called,
    ]);
  }
  for (const [name, headers, rows] of [
    [
      "_Tables",
      [
        "Schema",
        "Table",
        "Worksheet",
        "First Data Row",
        "Worksheet Rows",
        "Table Rows",
      ],
      tableIndex,
    ],
    [
      "_Columns",
      [
        "Schema",
        "Table",
        "Column",
        "Postgres Type",
        "Not Null",
        "Identity",
        "Generated",
      ],
      columnIndex,
    ],
    ["_Nulls", ["Schema", "Table", "Data Row", "Null Columns"], nullValues],
    [
      "_Long Values",
      ["Reference", "Schema", "Table", "Data Row", "Column", "Chunk", "Value"],
      longValues,
    ],
    [
      "_Sequences",
      ["Schema", "Sequence", "Last Value", "Is Called"],
      sequences,
    ],
  ]) {
    usedNames.delete(name.toLowerCase());
    addSheets(name, headers, rows);
  }
  return {
    workbook,
    tableCount: tables.length,
    rowCount: tableIndex.reduce((sum, part) => sum + part[4], 0),
  };
}

export function registerDataBackupRoute(app, deps) {
  const {
    requireAuth,
    requireRole,
    adminEquivalentRoles,
    asyncHandler,
    withTransaction,
    auditLog,
    pool,
    backupTimestamp,
  } = deps;
  app.get(
    "/user/backups/data.xlsx",
    requireAuth,
    requireRole(adminEquivalentRoles),
    asyncHandler(async (req, res) => {
      const data = await withTransaction((db) =>
        buildDataBackup(db, {
          revision: process.env.VERCEL_GIT_COMMIT_SHA || "",
        }),
      );
      const buffer = XLSX.write(data.workbook, {
        bookType: "xlsx",
        type: "buffer",
        compression: true,
      });
      await auditLog(
        pool,
        req.user.id,
        "backup",
        "database_excel",
        null,
        `tables=${data.tableCount};rows=${data.rowCount}`,
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="material-data-backup-${backupTimestamp()}.xlsx"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.send(buffer);
    }),
  );
}
