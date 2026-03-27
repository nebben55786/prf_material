import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import bcrypt from "bcryptjs";
import XLSX from "xlsx";
import { initDb, query, withTransaction, auditLog, vendorCategories, pool } from "./db.js";

const app = express();
const upload = multer();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const bomTypes = ["pipe", "pipe fab", "support fab", "steel", "civil", "tubing", "grout", "misc", "equipment"];
const bomStatuses = ["DRAFT", "ACTIVE", "ISSUED_FOR_RFQ", "PARTIALLY_PROCURED", "FULLY_PROCURED", "CLOSED"];
const bomLineStatuses = ["PLANNED", "ON_RFQ", "AWARDED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "ISSUED_TO_FIELD", "CLOSED"];
const requisitionStatuses = ["REQUESTED", "VERIFIED", "ISSUED", "CLOSED"];

app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(cookieParser());

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title, body, user) {
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>
      :root {
        --bg: #dfe3e8;
        --panel: #ffffff;
        --ink: #16212b;
        --muted: #4d5b69;
        --line: #9ca8b3;
        --line-strong: #798693;
        --brand: #2d5d87;
        --brand-2: #4b5966;
        --warn: #a23622;
        --header: #cfd6de;
        --header-strong: #bcc6cf;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", Tahoma, Verdana, sans-serif; color: var(--ink); background: var(--bg); }
      .shell { max-width: 1600px; margin: 0 auto; padding: 12px; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; padding: 10px 12px; background: linear-gradient(180deg, var(--header) 0%, var(--header-strong) 100%); border: 1px solid var(--line-strong); border-radius: 2px; box-shadow: inset 0 1px 0 rgba(255,255,255,.55); }
      .brand { font-size: 22px; font-weight: 700; letter-spacing: .01em; }
      .userline { color: var(--muted); font-size: 12px; }
      nav { display: flex; gap: 6px; flex-wrap: wrap; }
      nav a { color: #12324b; text-decoration: none; font-weight: 600; padding: 6px 9px; border: 1px solid transparent; border-radius: 2px; }
      nav a:hover { background: #edf1f4; border-color: var(--line); }
      .card { background: var(--panel); border: 1px solid var(--line-strong); border-radius: 2px; box-shadow: none; padding: 12px; margin-bottom: 10px; }
      h1, h2, h3 { margin: 0 0 12px; }
      h1 { font-size: 24px; }
      h2 { font-size: 20px; }
      h3 { font-size: 16px; text-transform: uppercase; letter-spacing: .03em; }
      .muted { color: var(--muted); font-size: 12px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .stat { padding: 10px; border: 1px solid var(--line-strong); border-radius: 2px; background: linear-gradient(180deg, #f6f8fa 0%, #e9eef2 100%); }
      .stat strong { display: block; font-size: 24px; margin-top: 4px; }
      label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 3px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
      input, select, textarea { width: 100%; padding: 7px 8px; border-radius: 2px; border: 1px solid var(--line-strong); background: #fff; color: var(--ink); font: inherit; box-shadow: inset 0 1px 1px rgba(0,0,0,.04); }
      textarea { min-height: 96px; resize: vertical; }
      button, .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 92px; height: 32px; padding: 0 12px; border-radius: 2px; border: 1px solid rgba(0,0,0,.15); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,.25); }
      button, .btn-primary { background: linear-gradient(180deg, #4278a9 0%, var(--brand) 100%); color: white; }
      .btn-secondary { background: linear-gradient(180deg, #6a7681 0%, var(--brand-2) 100%); color: white; }
      .btn-danger { background: linear-gradient(180deg, #bf5b49 0%, var(--warn) 100%); color: white; }
      .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .check-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px 14px; }
      .check-option { display: grid; grid-template-columns: 18px 1fr; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; text-transform: uppercase; }
      .check-option input { width: 14px; height: 14px; margin: 0; justify-self: center; }
      .scroll { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
      th, td { padding: 6px 7px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { color: #223240; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: linear-gradient(180deg, #e5eaef 0%, #d3dbe3 100%); }
      tr:nth-child(even) td { background: #f7f9fb; }
      .data-grid { table-layout: fixed; min-width: 1400px; }
      .data-grid th { position: relative; user-select: none; }
      .data-grid td { overflow: hidden; text-overflow: ellipsis; }
      .data-grid td.wrap, .data-grid th.wrap { white-space: normal; }
      .data-grid td.nowrap, .data-grid th.nowrap { white-space: nowrap; }
      .resize-handle { position: absolute; top: 0; right: -4px; width: 8px; height: 100%; cursor: col-resize; }
      .chip { display: inline-block; padding: 3px 8px; border-radius: 2px; background: #e3ebf2; border: 1px solid #b6c4d1; color: #264b69; font-weight: 700; }
      .error { border-color: #d0a19b; background: #f8ecea; color: var(--warn); }
      .stack { display: grid; gap: 10px; }
      @media (max-width: 900px) { .grid, .grid-4, .stats { grid-template-columns: 1fr; } .topbar { flex-direction: column; align-items: flex-start; } }
    </style>
    <script>
      function togglePassword(button, targetId) {
        const input = document.getElementById(targetId);
        if (!input) return;
        const nextType = input.type === "password" ? "text" : "password";
        input.type = nextType;
        button.textContent = nextType === "password" ? "Show" : "Hide";
      }
      function applyPhoneMask(input) {
        if (!input) return;
        const digits = String(input.value || "").replace(/\D/g, "").slice(0, 10);
        if (digits.length <= 3) {
          input.value = digits;
          return;
        }
        if (digits.length <= 6) {
          input.value = `${digits.slice(0, 3)}-${digits.slice(3)}`;
          return;
        }
        input.value = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
      }
      function filterTableRows(inputId, tableId) {
        const input = document.getElementById(inputId);
        const table = document.getElementById(tableId);
        if (!input || !table) return;
        const term = input.value.toLowerCase();
        const rows = table.querySelectorAll("tbody tr");
        rows.forEach((row) => {
          row.style.display = row.innerText.toLowerCase().includes(term) ? "" : "none";
        });
      }
      function enableResizableTable(tableId) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const headers = table.querySelectorAll("th[data-resizable='true']");
        headers.forEach((header) => {
          if (header.querySelector(".resize-handle")) return;
          const handle = document.createElement("span");
          handle.className = "resize-handle";
          header.appendChild(handle);
          handle.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const startX = event.pageX;
            const startWidth = header.offsetWidth;
            const onMove = (moveEvent) => {
              const nextWidth = Math.max(60, startWidth + (moveEvent.pageX - startX));
              header.style.width = nextWidth + "px";
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          });
        });
      }
    </script>
  </head>
  <body>
    <div class="shell">
      <div class="topbar">
        <div>
          <div class="brand">Material Control</div>
          ${user ? `<div class="userline">${esc(user.username)} | ${esc(user.role)}</div>` : ""}
        </div>
        ${user ? `<nav><a href="/">Dashboard</a><a href="/vendors">Vendors</a><a href="/bom">BOMs</a><a href="/requisitions">Requisitions</a><a href="/rfq">RFQs</a><a href="/po">POs</a><a href="/receive">Receiving</a><a href="/inventory">Inventory</a>${user.role === "admin" ? `<a href="/settings">Settings</a>` : ""}<a href="/logout">Logout</a></nav>` : ""}
      </div>
      ${body}
    </div>
  </body>
  </html>`;
}

function normalizeCategories(input) {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  return vendorCategories.filter((category) => values.includes(category)).join(",");
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function nextSortDir(currentSort, currentDir, column) {
  if (currentSort !== column) return "asc";
  return currentDir === "asc" ? "desc" : "asc";
}

function parseUploadedRows(file, pastedText) {
  const normalizeHeader = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (file?.buffer?.length) {
    if ((file.originalname || "").toLowerCase().endsWith(".xlsx")) {
      const workbook = XLSX.read(file.buffer, { type: "buffer" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), String(value ?? "").trim()])));
    }
    pastedText = file.buffer.toString("utf8");
  }
  if (!pastedText?.trim()) return [];
  const lines = pastedText.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((cell) => normalizeHeader(cell));
  return lines.filter((line) => line.trim()).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "").trim()]));
  });
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function quoteCell(unitPrice, leadDays) {
  return `$${Number(unitPrice).toFixed(2)} | ${num(leadDays)}d`;
}

function validatePasswordRules(password) {
  const value = String(password || "");
  if (value.length < 10) return "Password must be at least 10 characters.";
  if (!/[A-Z]/.test(value)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(value)) return "Password must include at least one lowercase letter.";
  if (!/[0-9]/.test(value)) return "Password must include at least one number.";
  return "";
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const rfqItemColumns = ["item_code", "description", "material_type", "uom", "spec", "commodity_code", "tag_number", "size_1", "size_2", "thk_1", "thk_2", "qty", "notes"];

function parseDelimitedRows(text, columns = rfqItemColumns) {
  if (!text?.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.length === 0) return [];
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const splitLine = (line) => line.split(delimiter).map((cell) => String(cell ?? "").trim());
  const firstRow = splitLine(lines[0]);
  const normalizedFirstRow = firstRow.map((cell) => String(cell ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
  const hasHeaders = normalizedFirstRow.some((cell) => columns.includes(cell));
  const headers = hasHeaders ? normalizedFirstRow : columns;
  const dataLines = hasHeaders ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const values = splitLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "").trim()]));
  });
}

async function upsertMaterialItem(client, row) {
  const itemCode = String(row.item_code || "").trim();
  const description = String(row.description || "").trim();
  const materialType = String(row.material_type || "").trim();
  const uom = String(row.uom || "").trim();
  if (!itemCode) throw new Error("Item code is required.");
  const existing = await client.query("select id, description, material_type, uom from material_items where item_code = $1", [itemCode]);
  if (existing.rows[0]) {
    const current = existing.rows[0];
    await client.query(
      "update material_items set description = $2, material_type = $3, uom = $4 where id = $1",
      [current.id, description || current.description, materialType || current.material_type, uom || current.uom]
    );
    return current.id;
  }
  const insert = await client.query(
    "insert into material_items (item_code, description, material_type, uom) values ($1, $2, $3, $4) returning id",
    [itemCode, description || itemCode, materialType || "misc", uom || "EA"]
  );
  return insert.rows[0].id;
}

async function upsertRfqItemRow(client, rfqId, row) {
  const itemCode = String(row.item_code || "").trim();
  const qty = num(row.qty);
  if (!itemCode) return { status: "skipped", errorCode: "missing_item_code", message: "Item code is required." };
  if (qty <= 0) return { status: "skipped", errorCode: "invalid_qty", message: "Qty must be greater than zero." };
  const materialItemId = await upsertMaterialItem(client, row);
  const existingItem = await client.query(`
    select id
    from rfq_items
    where rfq_id = $1 and material_item_id = $2
      and coalesce(size_1, '') = $3 and coalesce(size_2, '') = $4
      and coalesce(thk_1, '') = $5 and coalesce(thk_2, '') = $6
  `, [rfqId, materialItemId, row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || ""]);
  if (existingItem.rows[0]) {
    await client.query(`
      update rfq_items
      set spec = $2, commodity_code = $3, tag_number = $4, qty = $5, notes = $6, updated_at = now()
      where id = $1
    `, [existingItem.rows[0].id, row.spec || "", row.commodity_code || "", row.tag_number || "", qty, row.notes || ""]);
    return { status: "updated" };
  }
  await client.query(`
    insert into rfq_items (rfq_id, material_item_id, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes, updated_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
  `, [rfqId, materialItemId, row.spec || "", row.commodity_code || "", row.tag_number || "", row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qty, row.notes || ""]);
  return { status: "inserted" };
}

async function writeQuoteRevision(client, { rfqItemId, vendorId, unitPrice, leadDays, sourceType, sourceBatchId = null, createdBy = null }) {
  await client.query(`
    insert into quote_revisions (rfq_item_id, vendor_id, unit_price, lead_days, source_type, source_batch_id, created_by)
    values ($1, $2, $3, $4, $5, $6, $7)
  `, [rfqItemId, vendorId, unitPrice, leadDays, sourceType, sourceBatchId, createdBy]);
}

async function createImportBatch(client, { entityType, rfqId, uploadedBy, filename }) {
  const result = await client.query(`
    insert into import_batches (entity_type, rfq_id, uploaded_by, filename, status)
    values ($1, $2, $3, $4, 'COMPLETED')
    returning id
  `, [entityType, rfqId, uploadedBy || null, filename || ""]);
  return result.rows[0].id;
}

async function updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount, status = "COMPLETED" }) {
  await client.query(`
    update import_batches
    set inserted_count = $2, updated_count = $3, skipped_count = $4, status = $5
    where id = $1
  `, [batchId, insertedCount, updatedCount, skippedCount, status]);
}

async function addImportBatchError(client, batchId, rowNumber, errorCode, message, rawPayload) {
  await client.query(`
    insert into import_batch_errors (batch_id, row_number, error_code, message, raw_payload)
    values ($1, $2, $3, $4, $5::jsonb)
  `, [batchId, rowNumber, errorCode, message, JSON.stringify(rawPayload || {})]);
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function currentUser(req) {
  return readSession(req.cookies.session_token);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    res.redirect("/login");
    return;
  }
  req.user = user;
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      res.status(403).send(layout("Forbidden", `<div class="card error"><h3>Forbidden</h3><p>You do not have access to this action.</p></div>`, req.user));
      return;
    }
    next();
  };
}

async function recalcRfqStatus(client, rfqId) {
  const total = Number((await client.query("select count(*) from rfq_items where rfq_id = $1", [rfqId])).rows[0].count);
  const issued = Number((await client.query(`
    select count(distinct pl.rfq_item_id)
    from purchase_orders po
    join po_lines pl on pl.po_id = po.id
    where po.rfq_id = $1 and pl.rfq_item_id is not null
  `, [rfqId])).rows[0].count);
  await client.query("update rfqs set status = $2 where id = $1", [rfqId, total > 0 && issued >= total ? "CLOSED" : "OPEN"]);
}

async function recalcPoStatus(client, poId) {
  const po = (await client.query("select status from purchase_orders where id = $1", [poId])).rows[0];
  if (!po || po.status === "CANCELLED" || po.status === "DRAFT") return;
  const totals = (await client.query(`
    select
      count(*) as line_count,
      count(*) filter (
        where coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) >= pl.qty_ordered
      ) as fully_received_count,
      count(*) filter (
        where coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) > 0
      ) as received_count
    from po_lines pl
    where pl.po_id = $1
  `, [poId])).rows[0];
  const lineCount = num(totals?.line_count);
  const fullyReceivedCount = num(totals?.fully_received_count);
  const receivedCount = num(totals?.received_count);
  let nextStatus = "ISSUED";
  if (lineCount > 0 && fullyReceivedCount >= lineCount) nextStatus = "FULLY_RECEIVED";
  else if (receivedCount > 0) nextStatus = "PARTIALLY_RECEIVED";
  await client.query(`
    update purchase_orders
    set status = $2,
        issued_at = case when $2 in ('ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED') and issued_at is null then now() else issued_at end,
        closed_at = case when $2 = 'FULLY_RECEIVED' then now() else null end,
        updated_at = now()
    where id = $1
  `, [poId, nextStatus]);
}

async function getJobNumber(client = null) {
  const runner = client || { query };
  const result = await runner.query("select value from app_settings where key = 'job_number'");
  return String(result.rows[0]?.value || "0000").trim() || "0000";
}

async function getNextRfqNumber(client = null) {
  const runner = client || { query };
  const jobNumber = await getJobNumber(client);
  const result = await runner.query(`
    select coalesce(max(cast(right(rfq_no, 5) as integer)), 0) as max_no
    from rfqs
    where rfq_no ~ '-RFQ-[0-9]{5}$'
  `);
  const nextNumber = num(result.rows[0]?.max_no) + 1;
  return `${jobNumber}-RFQ-${String(nextNumber).padStart(5, "0")}`;
}

async function getNextRequisitionNumber(client = null) {
  const runner = client || { query };
  const jobNumber = await getJobNumber(client);
  const result = await runner.query(`
    select coalesce(max(cast(right(requisition_no, 5) as integer)), 0) as max_no
    from material_requisitions
    where requisition_no ~ '-MR-[0-9]{5}$'
  `);
  const nextNumber = num(result.rows[0]?.max_no) + 1;
  return `${jobNumber}-MR-${String(nextNumber).padStart(5, "0")}`;
}

function loginPage(error = "") {
  return layout("Login", `
    ${error ? `<div class="card error"><strong>${esc(error)}</strong></div>` : ""}
    <div class="card">
      <h2>Sign In</h2>
      <p class="muted">Default admin login: <strong>admin</strong> / <strong>admin123</strong></p>
      <form method="post" action="/login" class="stack">
        <div class="grid">
          <div><label>Username</label><input name="username" required /></div>
          <div><label>Password</label><input type="password" name="password" required /></div>
        </div>
        <div class="actions"><button type="submit">Sign In</button></div>
      </form>
    </div>
  `, null);
}

app.get("/login", (req, res) => {
  res.send(loginPage());
});

app.post("/login", async (req, res) => {
  const { username = "", password = "" } = req.body;
  const result = await query("select id, username, role, password_hash, is_active from users where username = $1", [username.trim()]);
  const user = result.rows[0];
  if (user && !user.is_active) {
    res.status(401).send(loginPage("This user is inactive. Contact an administrator."));
    return;
  }
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).send(loginPage("Invalid username or password."));
    return;
  }
  const token = signSession({ id: user.id, username: user.username, role: user.role });
  res.cookie("session_token", token, { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  res.clearCookie("session_token", { path: "/" });
  res.redirect("/login");
});

app.get("/", requireAuth, async (req, res) => {
  const [rfqs, pos, receipts, vendors, osd, jobNumber] = await Promise.all([
    query("select count(*) from rfqs"),
    query("select count(*) from purchase_orders"),
    query("select count(*) from receipts"),
    query("select count(*) from vendors"),
    query("select count(*) from receipts where osd_status <> 'OK'"),
    getJobNumber()
  ]);
  res.send(layout("Dashboard", `
    <h1>Operations Dashboard</h1>
    <div class="card"><strong>Job Number:</strong> ${esc(jobNumber)}</div>
    <div class="stats">
      <div class="stat"><div>RFQs</div><strong>${rfqs.rows[0].count}</strong></div>
      <div class="stat"><div>POs</div><strong>${pos.rows[0].count}</strong></div>
      <div class="stat"><div>Receipts</div><strong>${receipts.rows[0].count}</strong></div>
      <div class="stat"><div>OS&D Cases</div><strong>${osd.rows[0].count}</strong></div>
    </div>
  `, req.user));
});

app.get("/settings", requireAuth, requireRole(["admin"]), async (req, res) => {
  const jobNumber = await getJobNumber();
  const usersRes = req.user.role === "admin"
    ? await query("select id, username, role, is_active, created_at from users order by username")
    : { rows: [] };
  const userRows = usersRes.rows.map((record) => `
    <tr>
      <td>${esc(record.username)}</td>
      <td>${esc(record.role)}</td>
      <td>${record.is_active ? `<span class="chip">Active</span>` : `<span class="chip error">Inactive</span>`}</td>
      <td>${esc(record.created_at)}</td>
      <td>
        <div class="stack">
          <form method="post" action="/settings/users/${record.id}/edit" class="stack">
            <div class="grid">
              <div><input name="username" value="${esc(record.username)}" required /></div>
              <div>
                <select name="role">
                  <option value="admin" ${record.role === "admin" ? "selected" : ""}>admin</option>
                  <option value="buyer" ${record.role === "buyer" ? "selected" : ""}>buyer</option>
                  <option value="warehouse" ${record.role === "warehouse" ? "selected" : ""}>warehouse</option>
                </select>
              </div>
              <div>
                <select name="is_active">
                  <option value="true" ${record.is_active ? "selected" : ""}>active</option>
                  <option value="false" ${!record.is_active ? "selected" : ""}>inactive</option>
                </select>
              </div>
            </div>
            <div class="actions">
              <input type="password" name="password" placeholder="Enter a new password to reset it" />
              <button type="submit">Save User</button>
            </div>
            <div class="muted">Passwords are never displayed. Enter a new password only if you want to reset it.</div>
          </form>
          <div class="actions">
            ${req.user.id === record.id ? `<span class="muted">Current user</span>` : `<a class="btn btn-danger" href="/settings/users/${record.id}/delete">Delete</a>`}
          </div>
        </div>
      </td>
    </tr>
  `).join("");
  res.send(layout("Settings", `
    <h1>Settings</h1>
    <div class="card">
      <form method="post" action="/settings/job-number" class="stack">
        <div class="grid">
          <div><label>Job Number</label><input name="job_number" value="${esc(jobNumber)}" required /></div>
        </div>
        <p class="muted">Future RFQs will use this format: <strong>${esc(jobNumber)}-RFQ-00001</strong></p>
        <div class="actions"><button type="submit">Save Job Number</button></div>
      </form>
    </div>
    ${req.user.role === "admin" ? `
    <div class="card">
      <h3>User Management</h3>
      <form method="post" action="/settings/users/add" class="stack">
        <div class="grid">
          <div><label>Username</label><input name="username" required /></div>
          <div>
            <label>Role</label>
            <select name="role">
              <option value="buyer">buyer</option>
              <option value="warehouse">warehouse</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <div class="grid">
          <div>
            <label>Password</label>
            <div class="actions">
              <input id="new-user-password" type="password" name="password" required />
              <button type="button" class="btn btn-secondary" onclick="togglePassword(this, 'new-user-password')">Show</button>
            </div>
            <div class="muted">Minimum 10 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 number.</div>
          </div>
        </div>
        <div class="actions"><button type="submit">Add User</button></div>
      </form>
    </div>
    <div class="card scroll">
      <h3>Existing Users</h3>
      <table>
        <tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Edit / Delete</th></tr>
        ${userRows || `<tr><td colspan="5" class="muted">No users found.</td></tr>`}
      </table>
    </div>
    ` : ""}
  `, req.user));
});

app.post("/settings/job-number", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const jobNumber = String(req.body.job_number || "").trim().toUpperCase();
  if (!jobNumber) throw new Error("Job number is required.");
  await withTransaction(async (client) => {
    await client.query(`
      insert into app_settings (key, value, updated_at)
      values ('job_number', $1, now())
      on conflict (key) do update
      set value = excluded.value, updated_at = now()
    `, [jobNumber]);
    await auditLog(client, req.user.id, "update", "app_setting", "job_number", jobNumber);
  });
  res.redirect("/settings");
});

app.post("/settings/users/add", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "buyer").trim();
  if (!username) throw new Error("Username is required.");
  if (!password) throw new Error("Password is required.");
  if (!["admin", "buyer", "warehouse"].includes(role)) throw new Error("Invalid role.");
  const passwordError = validatePasswordRules(password);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await bcrypt.hash(password, 8);
  await withTransaction(async (client) => {
    await client.query("insert into users (username, password_hash, role, is_active) values ($1, $2, $3, true)", [username, passwordHash, role]);
    await auditLog(client, req.user.id, "create", "user", username, role);
  });
  res.redirect("/settings");
}));

app.post("/settings/users/:id/edit", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "buyer").trim();
  const isActive = String(req.body.is_active || "true") === "true";
  if (!username) throw new Error("Username is required.");
  if (!["admin", "buyer", "warehouse"].includes(role)) throw new Error("Invalid role.");
  let passwordHash = "";
  if (password) {
    const passwordError = validatePasswordRules(password);
    if (passwordError) throw new Error(passwordError);
    passwordHash = await bcrypt.hash(password, 8);
  }
  await withTransaction(async (client) => {
    const current = (await client.query("select id, username, role, is_active from users where id = $1", [userId])).rows[0];
    if (!current) throw new Error("User not found.");
    if (current.role === "admin" && role !== "admin") {
      const adminCount = Number((await client.query("select count(*) from users where role = 'admin'")).rows[0].count);
      if (adminCount <= 1) throw new Error("At least one admin user is required.");
    }
    if (current.role === "admin" && !isActive) {
      const activeAdminCount = Number((await client.query("select count(*) from users where role = 'admin' and is_active = true")).rows[0].count);
      if (activeAdminCount <= 1) throw new Error("At least one active admin user is required.");
    }
    if (req.user.id === userId && !isActive) throw new Error("You cannot deactivate your own user.");
    if (passwordHash) {
      await client.query("update users set username = $2, role = $3, password_hash = $4, is_active = $5 where id = $1", [userId, username, role, passwordHash, isActive]);
    } else {
      await client.query("update users set username = $2, role = $3, is_active = $4 where id = $1", [userId, username, role, isActive]);
    }
    await auditLog(client, req.user.id, "update", "user", userId, `${username}|${role}|${isActive ? "active" : "inactive"}`);
  });
  res.redirect("/settings");
}));

app.get("/settings/users/:id/delete", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  const current = (await query("select id, username, role, is_active, created_at from users where id = $1", [userId])).rows[0];
  if (!current) throw new Error("User not found.");
  if (req.user.id === userId) throw new Error("You cannot deactivate your own user.");
  res.send(layout("Confirm User Deactivation", `
    <h1>Confirm User Deactivation</h1>
    <div class="card">
      <p><strong>User:</strong> ${esc(current.username)}</p>
      <p><strong>Role:</strong> ${esc(current.role)}</p>
      <p><strong>Status:</strong> ${current.is_active ? "Active" : "Inactive"}</p>
      <p class="muted">This will mark the user inactive. They will no longer be able to sign in, but their history will remain in the system.</p>
      <div class="actions">
        <form method="post" action="/settings/users/${current.id}/delete"><button class="btn btn-danger" type="submit">Confirm Deactivate</button></form>
        <a class="btn btn-secondary" href="/settings">Cancel</a>
      </div>
    </div>
  `, req.user));
}));

app.post("/settings/users/:id/delete", requireAuth, requireRole(["admin"]), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  if (req.user.id === userId) throw new Error("You cannot deactivate your own user.");
  await withTransaction(async (client) => {
    const current = (await client.query("select id, username, role, is_active from users where id = $1", [userId])).rows[0];
    if (!current) throw new Error("User not found.");
    if (current.role === "admin" && current.is_active) {
      const activeAdminCount = Number((await client.query("select count(*) from users where role = 'admin' and is_active = true")).rows[0].count);
      if (activeAdminCount <= 1) throw new Error("At least one active admin user is required.");
    }
    await client.query("update users set is_active = false where id = $1", [userId]);
    await auditLog(client, req.user.id, "deactivate", "user", userId, current.username);
  });
  res.redirect("/settings");
}));

app.get("/bom", requireAuth, async (req, res) => {
  const bomNo = String(req.query.bom_no || "").trim();
  const bomType = String(req.query.bom_type || "").trim();
  const area = String(req.query.area || "").trim();
  const systemName = String(req.query.system || req.query.system_name || "").trim();
  const status = String(req.query.status || "").trim();
  const jobNumber = await getJobNumber();
  const where = [];
  const params = [];
  if (bomNo) { params.push(`%${bomNo}%`); where.push(`bh.bom_no ilike $${params.length}`); }
  if (bomType) { params.push(bomType); where.push(`bh.bom_type = $${params.length}`); }
  if (area) { params.push(`%${area}%`); where.push(`bh.area ilike $${params.length}`); }
  if (systemName) { params.push(`%${systemName}%`); where.push(`bh.system_name ilike $${params.length}`); }
  if (status) { params.push(status); where.push(`bh.status = $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const boms = (await query(`
    select bh.*, coalesce((select count(*) from bom_lines bl where bl.bom_id = bh.id), 0) as line_count
    from bom_headers bh
    ${whereSql}
    order by bh.id desc
    limit 300
  `, params)).rows;
  const filterTypeOptions = [`<option value="">All Types</option>`].concat(
    bomTypes.map((value) => `<option value="${esc(value)}" ${bomType === value ? "selected" : ""}>${esc(value)}</option>`)
  ).join("");
  const filterStatusOptions = [`<option value="">All Statuses</option>`].concat(
    bomStatuses.map((value) => `<option value="${esc(value)}" ${status === value ? "selected" : ""}>${esc(value)}</option>`)
  ).join("");
  const createTypeOptions = bomTypes.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
  const createStatusOptions = bomStatuses.map((value) => `<option value="${esc(value)}" ${value === "DRAFT" ? "selected" : ""}>${esc(value)}</option>`).join("");
  const rows = boms.map((bom) => `<tr>
    <td><a href="/bom/${bom.id}">${esc(bom.bom_no)}</a></td>
    <td>${esc(bom.job_number)}</td>
    <td>${esc(bom.bom_type)}</td>
    <td>${esc(bom.area || "")}</td>
    <td>${esc(bom.system_name || "")}</td>
    <td>${esc(bom.revision || "")}</td>
    <td>${bom.line_count}</td>
    <td><span class="chip">${esc(bom.status)}</span></td>
  </tr>`).join("");
  res.send(layout("BOMs", `
    <h1>BOM Planning</h1>
    <div class="card">
      <form method="get" action="/bom" class="stack">
        <div class="grid-4">
          <div><label>BOM #</label><input name="bom_no" value="${esc(bomNo)}" /></div>
          <div><label>Type</label><select name="bom_type">${filterTypeOptions}</select></div>
          <div><label>Area</label><input name="area" value="${esc(area)}" /></div>
          <div><label>System</label><input name="system" value="${esc(systemName)}" /></div>
        </div>
        <div class="grid">
          <div><label>Status</label><select name="status">${filterStatusOptions}</select></div>
        </div>
        <div class="actions"><button type="submit">Filter BOMs</button><a class="btn btn-secondary" href="/bom">Clear</a><span class="muted">${boms.length} result(s), max 300 shown</span></div>
      </form>
    </div>
    <div class="card">
      <form method="post" action="/bom" class="stack">
        <div class="grid-4">
          <div><label>Job Number</label><input name="job_number" value="${esc(jobNumber)}" required /></div>
          <div><label>BOM Number</label><input name="bom_no" required /></div>
          <div><label>BOM Type</label><select name="bom_type">${createTypeOptions}</select></div>
          <div><label>Status</label><select name="status">${createStatusOptions}</select></div>
        </div>
        <div class="grid">
          <div><label>Area</label><input name="area" /></div>
          <div><label>System</label><input name="system" /></div>
          <div><label>Revision</label><input name="revision" value="0" /></div>
          <div><label>Description</label><input name="description" /></div>
        </div>
        <div><label>Notes</label><textarea name="notes"></textarea></div>
        <div class="actions"><button type="submit">Create BOM</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>BOM</th><th>Job</th><th>Type</th><th>Area</th><th>System</th><th>Revision</th><th>Lines</th><th>Status</th></tr>${rows || `<tr><td colspan="8" class="muted">No BOMs match the current filter.</td></tr>`}</table></div>
  `, req.user));
});

app.post("/bom", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const bomId = await withTransaction(async (client) => {
    const insert = await client.query(`
      insert into bom_headers (job_number, bom_no, bom_type, area, system_name, revision, status, description, notes, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      returning id
    `, [
      String(req.body.job_number || "").trim().toUpperCase(),
      String(req.body.bom_no || "").trim(),
      req.body.bom_type || "misc",
      req.body.area || "",
      req.body.system || req.body.system_name || "",
      req.body.revision || "0",
      req.body.status || "DRAFT",
      req.body.description || "",
      req.body.notes || ""
    ]);
    await auditLog(client, req.user.id, "create", "bom_header", insert.rows[0].id, req.body.bom_no || "");
    return insert.rows[0].id;
  });
  res.redirect(`/bom/${bomId}`);
});

app.get("/bom/:id/edit", requireAuth, async (req, res) => {
  const bom = (await query("select * from bom_headers where id = $1", [req.params.id])).rows[0];
  if (!bom) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>BOM not found.</h3></div>`, req.user));
    return;
  }
  const typeOptions = bomTypes.map((value) => `<option value="${esc(value)}" ${bom.bom_type === value ? "selected" : ""}>${esc(value)}</option>`).join("");
  const statusOptions = bomStatuses.map((value) => `<option value="${esc(value)}" ${bom.status === value ? "selected" : ""}>${esc(value)}</option>`).join("");
  res.send(layout("Edit BOM", `
    <h1>Edit BOM</h1>
    <div class="card">
      <form method="post" action="/bom/${bom.id}/edit" class="stack">
        <div class="grid-4">
          <div><label>Job Number</label><input name="job_number" value="${esc(bom.job_number)}" required /></div>
          <div><label>BOM Number</label><input name="bom_no" value="${esc(bom.bom_no)}" required /></div>
          <div><label>BOM Type</label><select name="bom_type">${typeOptions}</select></div>
          <div><label>Status</label><select name="status">${statusOptions}</select></div>
        </div>
        <div class="grid">
          <div><label>Area</label><input name="area" value="${esc(bom.area || "")}" /></div>
          <div><label>System</label><input name="system" value="${esc(bom.system_name || "")}" /></div>
          <div><label>Revision</label><input name="revision" value="${esc(bom.revision || "")}" /></div>
          <div><label>Description</label><input name="description" value="${esc(bom.description || "")}" /></div>
        </div>
        <div><label>Notes</label><textarea name="notes">${esc(bom.notes || "")}</textarea></div>
        <div class="actions"><button type="submit">Save BOM</button><a class="btn btn-secondary" href="/bom/${bom.id}">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/bom/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    await client.query(`
      update bom_headers
      set job_number = $2, bom_no = $3, bom_type = $4, area = $5, system_name = $6, revision = $7, status = $8, description = $9, notes = $10, updated_at = now()
      where id = $1
    `, [
      req.params.id,
      String(req.body.job_number || "").trim().toUpperCase(),
      String(req.body.bom_no || "").trim(),
      req.body.bom_type || "misc",
      req.body.area || "",
      req.body.system || req.body.system_name || "",
      req.body.revision || "0",
      req.body.status || "DRAFT",
      req.body.description || "",
      req.body.notes || ""
    ]);
    await auditLog(client, req.user.id, "update", "bom_header", req.params.id, req.body.bom_no || "");
  });
  res.redirect(`/bom/${req.params.id}`);
});

app.get("/bom/:id", requireAuth, async (req, res) => {
  const bom = (await query("select * from bom_headers where id = $1", [req.params.id])).rows[0];
  if (!bom) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>BOM not found.</h3></div>`, req.user));
    return;
  }
  const [importsRes, coverageRes, requisitionSummaryRes] = await Promise.all([
    query(`
      select ib.id, ib.status, ib.inserted_count, ib.updated_count, ib.skipped_count, ib.created_at,
             coalesce((select count(*) from import_batch_errors ibe where ibe.batch_id = ib.id), 0) as error_count
      from import_batches ib
      where ib.entity_type = 'bom_lines' and ib.rfq_id = $1
      order by ib.id desc
      limit 5
    `, [req.params.id]),
    query(`
      select
        count(*) as line_count,
        coalesce(sum(qty_required), 0) as qty_required,
        coalesce(sum(qty_issued), 0) as qty_issued,
        count(*) filter (where planning_status = 'ON_RFQ') as on_rfq_count,
        count(*) filter (where planning_status in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'ISSUED_TO_FIELD', 'CLOSED')) as ordered_count,
        count(*) filter (where planning_status in ('PARTIALLY_RECEIVED', 'RECEIVED', 'ISSUED_TO_FIELD', 'CLOSED')) as received_count
      from bom_lines
      where bom_id = $1
    `, [req.params.id]),
    query(`select count(*) as filtered_count from bom_lines where ${lineWhereSql}`, lineParams),
    query(`
      select count(*) as requisition_count, coalesce(sum(mrl.qty_requested), 0) as qty_requested
      from material_requisitions mr
      join material_requisition_lines mrl on mrl.requisition_id = mr.id
      where mr.bom_id = $1
    `, [req.params.id])
  ]);
  const coverage = coverageRes.rows[0];
  const requisitionSummary = requisitionSummaryRes.rows[0];
  const importRows = importsRes.rows.length > 0
    ? importsRes.rows.map((batch) => `<tr><td><a href="/imports/${batch.id}">${batch.id}</a></td><td>${esc(batch.created_at)}</td><td>${esc(batch.status)}</td><td>${batch.inserted_count}</td><td>${batch.updated_count}</td><td>${batch.skipped_count}</td><td>${batch.error_count}</td></tr>`).join("")
    : `<tr><td colspan="7" class="muted">No imports logged yet.</td></tr>`;
  res.send(layout(`BOM ${bom.bom_no}`, `
    <h1>BOM ${esc(bom.bom_no)}</h1>
    <div class="card">
      <p class="muted">Job: ${esc(bom.job_number)} | Type: ${esc(bom.bom_type)} | Area: ${esc(bom.area || "")} | System: ${esc(bom.system_name || "")} | Revision: ${esc(bom.revision || "")} | Status: ${esc(bom.status)}</p>
      <p>${esc(bom.description || "")}</p>
      ${bom.notes ? `<p class="muted">${esc(bom.notes)}</p>` : ""}
      <div class="actions"><a class="btn btn-secondary" href="/bom/${bom.id}/edit">Edit BOM</a></div>
    </div>
    <div class="stats">
      <div class="stat"><div>Lines</div><strong>${coverage.line_count}</strong></div>
      <div class="stat"><div>Qty Required</div><strong>${esc(coverage.qty_required)}</strong></div>
      <div class="stat"><div>Qty Issued</div><strong>${esc(coverage.qty_issued)}</strong></div>
      <div class="stat"><div>Requisitioned</div><strong>${esc(requisitionSummary.qty_requested)}</strong></div>
    </div>
    <div class="card">
      <h3>Create RFQ From BOM</h3>
      <p class="muted">Creates an RFQ for BOM lines that are still in planning and marks those lines as <code>ON_RFQ</code>.</p>
      <form method="post" action="/bom/${bom.id}/to-rfq" class="stack">
        <div class="grid">
          <div><label>Project</label><input name="project_name" value="${esc(bom.description || bom.bom_no)}" required /></div>
          <div><label>Due Date</label><input type="date" name="due_date" /></div>
        </div>
        <div class="actions"><button type="submit">Create RFQ From BOM Lines</button></div>
      </form>
    </div>
    <div class="card">
      <h3>Upload BOM Lines</h3>
      <p class="muted">CSV/XLSX columns: line_no, item_code, description, material_type, uom, spec, commodity_code, tag_number, iwp_no, iso_no, size_1, size_2, thk_1, thk_2, qty_required, notes</p>
      <form method="post" enctype="multipart/form-data" action="/bom/${bom.id}/lines/import" class="stack">
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div><label>Or Paste CSV</label><textarea name="csv_text"></textarea></div>
        <div class="actions"><button type="submit">Import BOM Lines</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Batch</th><th>Created</th><th>Status</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Errors</th></tr>${importRows}</table></div>
  `, req.user));
});

app.post("/bom/:id/to-rfq", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const bomId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const bom = (await client.query("select * from bom_headers where id = $1", [bomId])).rows[0];
    if (!bom) throw new Error("BOM not found.");
    const lines = (await client.query(`
      select *
      from bom_lines
      where bom_id = $1 and planning_status = 'PLANNED'
      order by line_no, id
    `, [bomId])).rows;
    if (lines.length === 0) throw new Error("No BOM lines are available to move onto an RFQ.");
    const rfqNo = await getNextRfqNumber(client);
    const rfqInsert = await client.query(`
      insert into rfqs (rfq_no, project_name, due_date, status)
      values ($1, $2, $3, 'OPEN')
      returning id
    `, [rfqNo, req.body.project_name?.trim() || bom.description || bom.bom_no, req.body.due_date || null]);
    const newRfqId = rfqInsert.rows[0].id;
    for (const line of lines) {
      let materialItemId;
      const existingItem = await client.query("select id from material_items where item_code = $1", [line.item_code]);
      if (existingItem.rows[0]) {
        materialItemId = existingItem.rows[0].id;
        await client.query(
          "update material_items set description = $2, material_type = $3, uom = $4 where id = $1",
          [materialItemId, line.description, line.material_type || "misc", line.uom || "EA"]
        );
      } else {
        const inserted = await client.query(
          "insert into material_items (item_code, description, material_type, uom) values ($1, $2, $3, $4) returning id",
          [line.item_code, line.description, line.material_type || "misc", line.uom || "EA"]
        );
        materialItemId = inserted.rows[0].id;
      }
      await client.query(`
        insert into rfq_items (rfq_id, bom_line_id, material_item_id, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
      `, [newRfqId, line.id, materialItemId, line.spec || "", line.commodity_code || "", line.tag_number || "", line.size_1 || "", line.size_2 || "", line.thk_1 || "", line.thk_2 || "", line.qty_required, line.notes || ""]);
      await client.query(`
        update bom_lines
        set planning_status = 'ON_RFQ', qty_quoted = qty_required, updated_at = now()
        where id = $1
      `, [line.id]);
    }
    await client.query(`
      update bom_headers
      set status = case when status = 'DRAFT' then 'ISSUED_FOR_RFQ' else status end, updated_at = now()
      where id = $1
    `, [bomId]);
    await auditLog(client, req.user.id, "create", "rfq", newRfqId, rfqNo);
    await auditLog(client, req.user.id, "generate_rfq", "bom_header", bomId, rfqNo);
    return newRfqId;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/bom/:id/requisitions", requireAuth, asyncHandler(async (req, res) => {
  const bomId = Number(req.params.id);
  const selectedLineIds = []
    .concat(req.body.selected_line_ids || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (selectedLineIds.length === 0) throw new Error("Select at least one BOM line for the requisition.");
  const requisitionId = await withTransaction(async (client) => {
    const bom = (await client.query("select * from bom_headers where id = $1", [bomId])).rows[0];
    if (!bom) throw new Error("BOM not found.");
    const requisitionNo = await getNextRequisitionNumber(client);
      const insertReq = await client.query(`
        insert into material_requisitions (requisition_no, bom_id, requested_by_user_id, requested_by_name, iwp_no, iso_no, status, notes)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id
      `, [requisitionNo, bomId, req.user.id, String(req.body.requested_by_name || req.user.username).trim(), req.body.iwp_no || "", req.body.iso_no || "", "REQUESTED", req.body.notes || ""]);
      let createdLineCount = 0;
    for (const lineId of selectedLineIds) {
      const qtyRequested = num(req.body[`request_qty_${lineId}`]);
      const line = (await client.query(`
        select
          bl.id,
          bl.item_code,
          bl.qty_required,
          bl.qty_issued,
          greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0), 0) as qty_available
        from bom_lines bl
        left join (
          select
            mi.item_code,
            coalesce(pl.size_1, '') as size_1,
            coalesce(pl.size_2, '') as size_2,
            coalesce(pl.thk_1, '') as thk_1,
            coalesce(pl.thk_2, '') as thk_2,
            sum(r.qty_received) as qty_on_hand
          from receipts r
          join po_lines pl on pl.id = r.po_line_id
          join material_items mi on mi.id = pl.material_item_id
          where coalesce(r.osd_status, 'OK') = 'OK'
          group by mi.item_code, coalesce(pl.size_1, ''), coalesce(pl.size_2, ''), coalesce(pl.thk_1, ''), coalesce(pl.thk_2, '')
        ) inv
          on inv.item_code = bl.item_code
         and inv.size_1 = coalesce(bl.size_1, '')
         and inv.size_2 = coalesce(bl.size_2, '')
         and inv.thk_1 = coalesce(bl.thk_1, '')
         and inv.thk_2 = coalesce(bl.thk_2, '')
        left join (
          select
            item_code,
            coalesce(size_1, '') as size_1,
            coalesce(size_2, '') as size_2,
            coalesce(thk_1, '') as thk_1,
            coalesce(thk_2, '') as thk_2,
            sum(qty_issued) as qty_issued_total
          from bom_lines
          group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
        ) issued
          on issued.item_code = bl.item_code
         and issued.size_1 = coalesce(bl.size_1, '')
         and issued.size_2 = coalesce(bl.size_2, '')
         and issued.thk_1 = coalesce(bl.thk_1, '')
         and issued.thk_2 = coalesce(bl.thk_2, '')
        where bl.id = $1 and bl.bom_id = $2
      `, [lineId, bomId])).rows[0];
      if (!line) continue;
      const remaining = Math.max(num(line.qty_required) - num(line.qty_issued), 0);
      if (qtyRequested <= 0 || qtyRequested > remaining) {
        throw new Error(`Requested qty for ${line.item_code} must be greater than zero and cannot exceed the remaining BOM qty.`);
      }
      if (qtyRequested > num(line.qty_available)) {
        throw new Error(`Requested qty for ${line.item_code} exceeds available received stock.`);
      }
        await client.query(`
          insert into material_requisition_lines (requisition_id, bom_line_id, qty_requested)
          values ($1, $2, $3)
        `, [insertReq.rows[0].id, lineId, qtyRequested]);
        createdLineCount += 1;
      }
    if (createdLineCount === 0) throw new Error("No valid requisition lines were created.");
    await auditLog(client, req.user.id, "create", "material_requisition", insertReq.rows[0].id, requisitionNo);
    return insertReq.rows[0].id;
  });
  res.redirect(`/requisitions/${requisitionId}`);
}));

app.post("/bom/:id/lines/import", requireAuth, requireRole(["admin", "buyer"]), upload.single("sheet"), async (req, res) => {
  const bomId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "bom_lines",
      rfqId: bomId,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const lineNo = String(row.line_no || "").trim();
      const itemCode = String(row.item_code || "").trim();
      const qtyRequired = num(row.qty_required);
      if (!lineNo || !itemCode || qtyRequired <= 0) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "invalid_bom_line", "Line no, item code, and qty_required are required.", row);
        continue;
      }
      const existingLine = await client.query(
        "select id from bom_lines where bom_id = $1 and source_uid = ($2 || '|' || $3)",
        [bomId, lineNo, itemCode]
      );
      if (existingLine.rows[0]) {
        await client.query(`
          update bom_lines
          set item_code = $2, description = $3, material_type = $4, uom = $5, spec = $6, commodity_code = $7, tag_number = $8,
              iwp_no = $9, iso_no = $10, size_1 = $11, size_2 = $12, thk_1 = $13, thk_2 = $14, qty_required = $15, notes = $16, updated_at = now()
          where id = $1
        `, [existingLine.rows[0].id, itemCode, row.description || itemCode, row.material_type || "misc", row.uom || "EA", row.spec || "", row.commodity_code || "", row.tag_number || "", row.iwp_no || row.iwp || "", row.iso_no || row.iso || "", row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qtyRequired, row.notes || ""]);
        updatedCount += 1;
      } else {
        await client.query(`
          insert into bom_lines (bom_id, line_no, item_code, description, material_type, uom, spec, commodity_code, tag_number, iwp_no, iso_no, size_1, size_2, thk_1, thk_2, qty_required, notes, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
        `, [bomId, lineNo, itemCode, row.description || itemCode, row.material_type || "misc", row.uom || "EA", row.spec || "", row.commodity_code || "", row.tag_number || "", row.iwp_no || row.iwp || "", row.iso_no || row.iso || "", row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qtyRequired, row.notes || ""]);
        insertedCount += 1;
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "bom_lines", bomId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.get("/bom-line/:id/edit", requireAuth, async (req, res) => {
  const line = (await query("select bl.*, bh.bom_no from bom_lines bl join bom_headers bh on bh.id = bl.bom_id where bl.id = $1", [req.params.id])).rows[0];
  if (!line) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>BOM line not found.</h3></div>`, req.user));
    return;
  }
  const statusOptions = bomLineStatuses.map((value) => `<option value="${esc(value)}" ${line.planning_status === value ? "selected" : ""}>${esc(value)}</option>`).join("");
  res.send(layout("Edit BOM Line", `
    <h1>Edit BOM Line</h1>
    <div class="card"><strong>BOM:</strong> ${esc(line.bom_no)} | <strong>Line:</strong> ${esc(line.line_no)}</div>
    <div class="card">
      <form method="post" action="/bom-line/${line.id}/edit" class="stack">
        <div class="grid">
          <div><label>Line No</label><input name="line_no" value="${esc(line.line_no)}" required /></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(line.item_code)}" required /></div>
          <div><label>Description</label><input name="description" value="${esc(line.description)}" required /></div>
          <div><label>Material Type</label><input name="material_type" value="${esc(line.material_type)}" /></div>
          <div><label>UOM</label><input name="uom" value="${esc(line.uom)}" required /></div>
          <div><label>Qty Required</label><input name="qty_required" value="${esc(line.qty_required)}" required /></div>
          <div><label>Spec</label><input name="spec" value="${esc(line.spec || "")}" /></div>
          <div><label>Commodity Code</label><input name="commodity_code" value="${esc(line.commodity_code || "")}" /></div>
          <div><label>Tag Number</label><input name="tag_number" value="${esc(line.tag_number || "")}" /></div>
          <div><label>IWP</label><input name="iwp_no" value="${esc(line.iwp_no || "")}" /></div>
          <div><label>ISO</label><input name="iso_no" value="${esc(line.iso_no || "")}" /></div>
          <div><label>Size 1</label><input name="size_1" value="${esc(line.size_1 || "")}" /></div>
          <div><label>Size 2</label><input name="size_2" value="${esc(line.size_2 || "")}" /></div>
          <div><label>Thk 1</label><input name="thk_1" value="${esc(line.thk_1 || "")}" /></div>
          <div><label>Thk 2</label><input name="thk_2" value="${esc(line.thk_2 || "")}" /></div>
          <div><label>Status</label><select name="planning_status">${statusOptions}</select></div>
        </div>
        <div><label>Notes</label><textarea name="notes">${esc(line.notes || "")}</textarea></div>
        <div class="actions"><button type="submit">Save BOM Line</button><a class="btn btn-secondary" href="/bom/${line.bom_id}">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/bom-line/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const lineId = Number(req.params.id);
  const bomId = await withTransaction(async (client) => {
    const current = (await client.query("select bom_id from bom_lines where id = $1", [lineId])).rows[0];
    if (!current) throw new Error("BOM line not found.");
    await client.query(`
      update bom_lines
      set line_no = $2, item_code = $3, description = $4, material_type = $5, uom = $6, qty_required = $7,
          spec = $8, commodity_code = $9, tag_number = $10, iwp_no = $11, iso_no = $12, size_1 = $13, size_2 = $14, thk_1 = $15, thk_2 = $16,
          planning_status = $17, notes = $18, updated_at = now()
      where id = $1
    `, [lineId, String(req.body.line_no || "").trim(), req.body.item_code || "", req.body.description || "", req.body.material_type || "misc", req.body.uom || "EA", num(req.body.qty_required), req.body.spec || "", req.body.commodity_code || "", req.body.tag_number || "", req.body.iwp_no || "", req.body.iso_no || "", req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", req.body.planning_status || "PLANNED", req.body.notes || ""]);
    await auditLog(client, req.user.id, "update", "bom_line", lineId, req.body.item_code || "");
    return current.bom_id;
  });
  res.redirect(`/bom/${bomId}`);
});

app.post("/bom-line/:id/delete", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const lineId = Number(req.params.id);
  const bomId = await withTransaction(async (client) => {
    const current = (await client.query("select bom_id from bom_lines where id = $1", [lineId])).rows[0];
    if (!current) throw new Error("BOM line not found.");
    await client.query("delete from bom_lines where id = $1", [lineId]);
    await auditLog(client, req.user.id, "delete", "bom_line", lineId, "");
    return current.bom_id;
  });
  res.redirect(`/bom/${bomId}`);
});

app.get("/requisitions/new", requireAuth, async (req, res) => {
  const availableBoms = (await query(`
    select id, bom_no, description, status
    from bom_headers
    where bom_type = 'pipe'
    order by id desc
  `)).rows;
  const selectedBomId = Number(req.query.bom_id || availableBoms[0]?.id || 0);
  const selectedBom = availableBoms.find((row) => Number(row.id) === selectedBomId) || null;
  const lineFilter = {
    iwp: String(req.query.iwp || "").trim(),
    iso: String(req.query.iso || "").trim(),
    itemCode: String(req.query.item_code || "").trim(),
    lineNo: String(req.query.line_no || "").trim(),
    limit: Math.min(Math.max(num(req.query.limit, 250), 50), 1000)
  };
  let filteredCount = 0;
  let lineRows = "";
  if (selectedBom) {
    const lineWhere = ["bom_id = $1"];
    const lineParams = [selectedBom.id];
    if (lineFilter.iwp) { lineParams.push(`%${lineFilter.iwp}%`); lineWhere.push(`coalesce(iwp_no, '') ilike $${lineParams.length}`); }
    if (lineFilter.iso) { lineParams.push(`%${lineFilter.iso}%`); lineWhere.push(`coalesce(iso_no, '') ilike $${lineParams.length}`); }
    if (lineFilter.itemCode) { lineParams.push(`%${lineFilter.itemCode}%`); lineWhere.push(`item_code ilike $${lineParams.length}`); }
    if (lineFilter.lineNo) { lineParams.push(`%${lineFilter.lineNo}%`); lineWhere.push(`line_no ilike $${lineParams.length}`); }
    const lineWhereSql = lineWhere.join(" and ");
    const [linesRes, filteredCountRes] = await Promise.all([
      query(`
        select
          bl.*,
          greatest(bl.qty_required - bl.qty_issued, 0) as qty_remaining,
          coalesce(inv.qty_on_hand, 0) as qty_on_hand,
          greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0), 0) as qty_available
        from bom_lines bl
        left join (
          select
            mi.item_code,
            coalesce(pl.size_1, '') as size_1,
            coalesce(pl.size_2, '') as size_2,
            coalesce(pl.thk_1, '') as thk_1,
            coalesce(pl.thk_2, '') as thk_2,
            sum(r.qty_received) as qty_on_hand
          from receipts r
          join po_lines pl on pl.id = r.po_line_id
          join material_items mi on mi.id = pl.material_item_id
          where coalesce(r.osd_status, 'OK') = 'OK'
          group by mi.item_code, coalesce(pl.size_1, ''), coalesce(pl.size_2, ''), coalesce(pl.thk_1, ''), coalesce(pl.thk_2, '')
        ) inv
          on inv.item_code = bl.item_code
         and inv.size_1 = coalesce(bl.size_1, '')
         and inv.size_2 = coalesce(bl.size_2, '')
         and inv.thk_1 = coalesce(bl.thk_1, '')
         and inv.thk_2 = coalesce(bl.thk_2, '')
        left join (
          select
            item_code,
            coalesce(size_1, '') as size_1,
            coalesce(size_2, '') as size_2,
            coalesce(thk_1, '') as thk_1,
            coalesce(thk_2, '') as thk_2,
            sum(qty_issued) as qty_issued_total
          from bom_lines
          group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
        ) issued
          on issued.item_code = bl.item_code
         and issued.size_1 = coalesce(bl.size_1, '')
         and issued.size_2 = coalesce(bl.size_2, '')
         and issued.thk_1 = coalesce(bl.thk_1, '')
         and issued.thk_2 = coalesce(bl.thk_2, '')
        where ${lineWhereSql.replace(/\bbom_id\b/g, "bl.bom_id").replace(/\bitem_code\b/g, "bl.item_code").replace(/\bline_no\b/g, "bl.line_no")}
        order by coalesce(bl.iwp_no, ''), coalesce(bl.iso_no, ''), bl.line_no, bl.id
        limit ${lineFilter.limit}
      `, lineParams),
      query(`select count(*) as filtered_count from bom_lines where ${lineWhereSql}`, lineParams)
    ]);
    filteredCount = Number(filteredCountRes.rows[0]?.filtered_count || 0);
    lineRows = linesRes.rows.map((line) => `<tr>
      <td><input type="checkbox" name="selected_line_ids" value="${line.id}" /></td>
      <td>${esc(line.line_no)}</td>
      <td>${esc(line.iwp_no || "")}</td>
      <td>${esc(line.iso_no || "")}</td>
      <td>${esc(line.item_code)}</td>
      <td>${esc(line.description)}</td>
      <td>${esc(line.material_type)}</td>
      <td>${esc(line.qty_required)}</td>
      <td>${esc(line.qty_issued)}</td>
      <td>${esc(line.qty_remaining)}</td>
      <td>${esc(line.qty_available)}</td>
      <td><input name="request_qty_${line.id}" value="${esc(Math.min(num(line.qty_remaining), num(line.qty_available)))}" /></td>
      <td>${esc(line.uom)}</td>
      <td>${esc(line.spec || "")}</td>
      <td>${esc(line.commodity_code || "")}</td>
      <td>${esc(line.tag_number || "")}</td>
      <td>${esc(line.size_1 || "")}</td>
      <td>${esc(line.size_2 || "")}</td>
      <td>${esc(line.thk_1 || "")}</td>
      <td>${esc(line.thk_2 || "")}</td>
      <td>${esc(line.notes || "")}</td>
      <td><span class="chip">${esc(line.planning_status)}</span></td>
      <td><div class="actions"><a class="btn btn-secondary" href="/bom-line/${line.id}/edit">Edit</a></div></td>
    </tr>`).join("");
  }
  const bomOptions = availableBoms.map((row) => `<option value="${row.id}" ${Number(row.id) === selectedBomId ? "selected" : ""}>${esc(row.bom_no)}${row.description ? ` | ${esc(row.description)}` : ""}</option>`).join("");
  res.send(layout("New Request", `
    <h1>New Material Request</h1>
    <div class="card">
      <form method="get" action="/requisitions/new" class="stack">
        <div class="grid">
          <div><label>Piping BOM</label><select name="bom_id">${bomOptions || `<option value="">No piping BOMs found</option>`}</select></div>
          <div><label>Max Rows</label><input name="limit" value="${esc(lineFilter.limit)}" /></div>
          <div><label>IWP</label><input name="iwp" value="${esc(lineFilter.iwp)}" /></div>
          <div><label>ISO</label><input name="iso" value="${esc(lineFilter.iso)}" /></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(lineFilter.itemCode)}" /></div>
          <div><label>Line No</label><input name="line_no" value="${esc(lineFilter.lineNo)}" /></div>
        </div>
        <div class="actions"><button type="submit">Load Lines</button><a class="btn btn-secondary" href="/requisitions">Back to Requisitions</a></div>
      </form>
    </div>
    ${selectedBom ? `
      <div class="card">
        <h3>Create Material Requisition</h3>
        <p class="muted">BOM: ${esc(selectedBom.bom_no)}${selectedBom.description ? ` | ${esc(selectedBom.description)}` : ""}. Showing up to ${esc(lineFilter.limit)} rows, ${filteredCount} matching the current filter.</p>
        <form method="post" action="/bom/${selectedBom.id}/requisitions" class="stack">
          <div class="grid">
            <div><label>Requested By</label><input name="requested_by_name" value="${esc(req.user.username)}" required /></div>
            <div><label>Status</label><select name="status">${requisitionStatuses.map((value) => `<option value="${esc(value)}" ${value === "REQUESTED" ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></div>
            <div><label>IWP</label><input name="iwp_no" value="${esc(lineFilter.iwp)}" /></div>
            <div><label>ISO</label><input name="iso_no" value="${esc(lineFilter.iso)}" /></div>
          </div>
          <div><label>Notes</label><textarea name="notes"></textarea></div>
          <div class="scroll">
            <table id="requisition-builder-table" class="data-grid">
              <colgroup>
                <col style="width:80px" />
                <col style="width:170px" />
                <col style="width:120px" />
                <col style="width:180px" />
                <col style="width:120px" />
                <col style="width:380px" />
                <col style="width:90px" />
                <col style="width:90px" />
                <col style="width:90px" />
                <col style="width:100px" />
                <col style="width:100px" />
                <col style="width:110px" />
                <col style="width:80px" />
                <col style="width:120px" />
                <col style="width:140px" />
                <col style="width:130px" />
                <col style="width:80px" />
                <col style="width:80px" />
                <col style="width:80px" />
                <col style="width:80px" />
                <col style="width:180px" />
                <col style="width:120px" />
                <col style="width:140px" />
              </colgroup>
              <tr>
                <th class="nowrap" data-resizable="true">Pick</th>
                <th class="wrap" data-resizable="true">Line</th>
                <th class="nowrap" data-resizable="true">IWP</th>
                <th class="nowrap" data-resizable="true">ISO</th>
                <th class="nowrap" data-resizable="true">Item</th>
                <th class="wrap" data-resizable="true">Description</th>
                <th class="nowrap" data-resizable="true">Type</th>
                <th class="nowrap" data-resizable="true">Req Qty</th>
                <th class="nowrap" data-resizable="true">Issued</th>
                <th class="nowrap" data-resizable="true">Remaining</th>
                <th class="nowrap" data-resizable="true">Available</th>
                <th class="nowrap" data-resizable="true">Request</th>
                <th class="nowrap" data-resizable="true">UOM</th>
                <th class="nowrap" data-resizable="true">Spec</th>
                <th class="wrap" data-resizable="true">Commodity Code</th>
                <th class="wrap" data-resizable="true">Tag Number</th>
                <th class="nowrap" data-resizable="true">Size 1</th>
                <th class="nowrap" data-resizable="true">Size 2</th>
                <th class="nowrap" data-resizable="true">Thk 1</th>
                <th class="nowrap" data-resizable="true">Thk 2</th>
                <th class="wrap" data-resizable="true">Notes</th>
                <th class="nowrap" data-resizable="true">Status</th>
                <th class="nowrap" data-resizable="true">Actions</th>
              </tr>
              ${lineRows || `<tr><td colspan="23" class="muted">No BOM lines match the current filter.</td></tr>`}
            </table>
          </div>
          <div class="actions"><button type="submit">Create Material Requisition</button></div>
        </form>
      </div>
      <script>enableResizableTable("requisition-builder-table");</script>
    ` : `<div class="card error"><h3>No Piping BOM Found</h3><p>Select or create a piping BOM first.</p></div>`}
  `, req.user));
});

app.get("/requisitions", requireAuth, async (req, res) => {
  const iwp = String(req.query.iwp || "").trim();
  const iso = String(req.query.iso || "").trim();
  const status = String(req.query.status || "").trim();
  const where = [];
  const params = [];
  if (iwp) { params.push(`%${iwp}%`); where.push(`coalesce(mr.iwp_no, '') ilike $${params.length}`); }
  if (iso) { params.push(`%${iso}%`); where.push(`coalesce(mr.iso_no, '') ilike $${params.length}`); }
  if (status) { params.push(status); where.push(`mr.status = $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const rows = (await query(`
    select mr.*, bh.bom_no, count(mrl.id) as line_count, coalesce(sum(mrl.qty_requested), 0) as qty_requested
    from material_requisitions mr
    join bom_headers bh on bh.id = mr.bom_id
    left join material_requisition_lines mrl on mrl.requisition_id = mr.id
    ${whereSql}
    group by mr.id, bh.bom_no
    order by mr.id desc
    limit 300
  `, params)).rows;
  const tableRows = rows.map((row) => `<tr>
    <td><a href="/requisitions/${row.id}">${esc(row.requisition_no)}</a></td>
    <td>${esc(row.bom_no)}</td>
    <td>${esc(row.requested_by_name)}</td>
    <td>${esc(row.iwp_no || "")}</td>
    <td>${esc(row.iso_no || "")}</td>
    <td>${row.line_count}</td>
    <td>${esc(row.qty_requested)}</td>
    <td><span class="chip">${esc(row.status)}</span></td>
    <td>${esc(row.created_at)}</td>
  </tr>`).join("");
  res.send(layout("Requisitions", `
    <h1>Material Requisitions</h1>
    <div class="card">
      <div class="actions"><a class="btn btn-primary" href="/requisitions/new">New Request</a></div>
    </div>
    <div class="card">
      <form method="get" action="/requisitions" class="stack">
        <div class="grid">
          <div><label>IWP</label><input name="iwp" value="${esc(iwp)}" /></div>
          <div><label>ISO</label><input name="iso" value="${esc(iso)}" /></div>
          <div><label>Status</label><select name="status"><option value="">All Statuses</option>${requisitionStatuses.map((value) => `<option value="${esc(value)}" ${status === value ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></div>
        </div>
        <div class="actions"><button type="submit">Filter Requisitions</button><a class="btn btn-secondary" href="/requisitions">Clear</a></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Req #</th><th>BOM</th><th>Requested By</th><th>IWP</th><th>ISO</th><th>Lines</th><th>Qty</th><th>Status</th><th>Created</th></tr>${tableRows || `<tr><td colspan="9" class="muted">No requisitions yet.</td></tr>`}</table></div>
  `, req.user));
});

app.get("/requisitions/:id", requireAuth, async (req, res) => {
  const header = (await query(`
    select mr.*, bh.bom_no, bh.description as bom_description
    from material_requisitions mr
    join bom_headers bh on bh.id = mr.bom_id
    where mr.id = $1
  `, [req.params.id])).rows[0];
  if (!header) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Requisition not found.</h3></div>`, req.user));
    return;
  }
  const lines = (await query(`
    select mrl.qty_requested, mrl.qty_issued, bl.line_no, bl.iwp_no, bl.iso_no, bl.item_code, bl.description, bl.uom, bl.spec, bl.size_1, bl.size_2, bl.thk_1, bl.thk_2
    from material_requisition_lines mrl
    join bom_lines bl on bl.id = mrl.bom_line_id
    where mrl.requisition_id = $1
    order by bl.line_no, bl.id
  `, [req.params.id])).rows;
  const lineRows = lines.map((line) => `<tr>
    <td>${esc(line.line_no)}</td>
    <td>${esc(line.iwp_no || "")}</td>
    <td>${esc(line.iso_no || "")}</td>
    <td>${esc(line.item_code)}</td>
    <td>${esc(line.description)}</td>
    <td>${esc(line.qty_requested)}</td>
    <td>${esc(line.qty_issued)}</td>
    <td>${esc(line.uom)}</td>
    <td>${esc(line.spec || "")}</td>
    <td>${esc(line.size_1 || "")}</td>
    <td>${esc(line.size_2 || "")}</td>
    <td>${esc(line.thk_1 || "")}</td>
    <td>${esc(line.thk_2 || "")}</td>
  </tr>`).join("");
  const headerActions = [];
  if (header.status === "REQUESTED") {
    headerActions.push(`<form method="post" action="/requisitions/${header.id}/verify"><button type="submit">Verify Request</button></form>`);
  }
  if (header.status === "VERIFIED") {
    headerActions.push(`<form method="post" action="/requisitions/${header.id}/issue"><button type="submit">Issue To Field</button></form>`);
  }
  res.send(layout(`Requisition ${header.requisition_no}`, `
    <h1>Requisition ${esc(header.requisition_no)}</h1>
    <div class="card">
      <p class="muted">BOM: <a href="/bom/${header.bom_id}">${esc(header.bom_no)}</a> | Requested By: ${esc(header.requested_by_name)} | Status: ${esc(header.status)} | Created: ${esc(header.created_at)}</p>
      <p class="muted">IWP: ${esc(header.iwp_no || "")} | ISO: ${esc(header.iso_no || "")}</p>
      ${header.notes ? `<p class="muted">${esc(header.notes)}</p>` : ""}
      ${headerActions.length ? `<div class="actions">${headerActions.join("")}</div>` : ""}
    </div>
    <div class="card scroll"><table><tr><th>Line</th><th>IWP</th><th>ISO</th><th>Item</th><th>Description</th><th>Qty Requested</th><th>Qty Issued</th><th>UOM</th><th>Spec</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th></tr>${lineRows || `<tr><td colspan="13" class="muted">No lines on this requisition.</td></tr>`}</table></div>
  `, req.user));
});

app.post("/requisitions/:id/verify", requireAuth, requireRole(["admin", "warehouse", "buyer"]), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (header.status !== "REQUESTED") throw new Error("Only requested requisitions can be verified.");
    await client.query(`
      update material_requisitions
      set status = 'VERIFIED',
          verified_at = now(),
          verified_by_user_id = $2
      where id = $1
    `, [req.params.id, req.user.id]);
    await auditLog(client, req.user.id, "verify", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.post("/requisitions/:id/issue", requireAuth, requireRole(["admin", "warehouse"]), asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const header = (await client.query("select * from material_requisitions where id = $1", [req.params.id])).rows[0];
    if (!header) throw new Error("Requisition not found.");
    if (header.status !== "VERIFIED") throw new Error("Requisition must be verified before issue.");
    const lines = (await client.query(`
      select
        mrl.id as requisition_line_id,
        mrl.qty_requested,
        bl.id as bom_line_id,
        bl.item_code,
        bl.qty_required,
        bl.qty_issued,
        greatest(coalesce(inv.qty_on_hand, 0) - coalesce(issued.qty_issued_total, 0), 0) as qty_available
      from material_requisition_lines mrl
      join bom_lines bl on bl.id = mrl.bom_line_id
      left join (
        select
          mi.item_code,
          coalesce(pl.size_1, '') as size_1,
          coalesce(pl.size_2, '') as size_2,
          coalesce(pl.thk_1, '') as thk_1,
          coalesce(pl.thk_2, '') as thk_2,
          sum(r.qty_received) as qty_on_hand
        from receipts r
        join po_lines pl on pl.id = r.po_line_id
        join material_items mi on mi.id = pl.material_item_id
        where coalesce(r.osd_status, 'OK') = 'OK'
        group by mi.item_code, coalesce(pl.size_1, ''), coalesce(pl.size_2, ''), coalesce(pl.thk_1, ''), coalesce(pl.thk_2, '')
      ) inv
        on inv.item_code = bl.item_code
       and inv.size_1 = coalesce(bl.size_1, '')
       and inv.size_2 = coalesce(bl.size_2, '')
       and inv.thk_1 = coalesce(bl.thk_1, '')
       and inv.thk_2 = coalesce(bl.thk_2, '')
      left join (
        select
          item_code,
          coalesce(size_1, '') as size_1,
          coalesce(size_2, '') as size_2,
          coalesce(thk_1, '') as thk_1,
          coalesce(thk_2, '') as thk_2,
          sum(qty_issued) as qty_issued_total
        from bom_lines
        group by item_code, coalesce(size_1, ''), coalesce(size_2, ''), coalesce(thk_1, ''), coalesce(thk_2, '')
      ) issued
        on issued.item_code = bl.item_code
       and issued.size_1 = coalesce(bl.size_1, '')
       and issued.size_2 = coalesce(bl.size_2, '')
       and issued.thk_1 = coalesce(bl.thk_1, '')
       and issued.thk_2 = coalesce(bl.thk_2, '')
      where mrl.requisition_id = $1
      order by bl.line_no, bl.id
    `, [req.params.id])).rows;
    if (lines.length === 0) throw new Error("No requisition lines found.");
    for (const line of lines) {
      if (num(line.qty_requested) > num(line.qty_available)) {
        throw new Error(`Cannot issue ${line.item_code}; requested qty exceeds available stock.`);
      }
    }
    for (const line of lines) {
      await client.query(`
        update bom_lines
        set qty_issued = qty_issued + $2,
            planning_status = case
              when qty_issued + $2 >= qty_required then 'ISSUED_TO_FIELD'
              else planning_status
            end,
            updated_at = now()
        where id = $1
      `, [line.bom_line_id, line.qty_requested]);
      await client.query(`
        update material_requisition_lines
        set qty_issued = qty_requested
        where id = $1
      `, [line.requisition_line_id]);
    }
    await client.query(`
      update material_requisitions
      set status = 'ISSUED',
          issued_at = now(),
          issued_by_user_id = $2
      where id = $1
    `, [req.params.id, req.user.id]);
    await auditLog(client, req.user.id, "issue", "material_requisition", req.params.id, header.requisition_no);
  });
  res.redirect(`/requisitions/${req.params.id}`);
}));

app.get("/vendors", requireAuth, async (req, res) => {
  const search = String(req.query.search || "").trim();
  const category = String(req.query.category || "").trim();
  const sort = String(req.query.sort || "name").trim().toLowerCase();
  const dir = String(req.query.dir || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
  const vendorSortColumns = {
    name: "name",
    contact_name: "contact_name",
    email: "email",
    phone: "phone",
    categories: "categories"
  };
  const sortColumn = vendorSortColumns[sort] || "name";
  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(name ilike $${params.length} or coalesce(contact_name, '') ilike $${params.length} or coalesce(email, '') ilike $${params.length} or coalesce(phone, '') ilike $${params.length})`);
  }
  if (category) {
    params.push(`%${category}%`);
    where.push(`coalesce(categories, '') ilike $${params.length}`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const vendors = (await query(`select * from vendors ${whereSql} order by coalesce(${sortColumn}, '') ${dir}, name asc`, params)).rows;
  const sortLink = (column) => `/vendors?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}&sort=${encodeURIComponent(column)}&dir=${encodeURIComponent(nextSortDir(sort, dir, column))}`;
  const rows = vendors.map((vendor) => `<tr>
        <td>${esc(vendor.name)}</td>
        <td>${esc(vendor.contact_name || "")}</td>
        <td>${esc(vendor.email || "")}</td>
        <td>${esc(normalizePhone(vendor.phone || ""))}</td>
        <td>${(vendor.categories || "").split(",").filter(Boolean).map((value) => `<span class="chip">${esc(value)}</span>`).join(" ") || `<span class="muted">None</span>`}</td>
        <td><a class="btn btn-secondary" href="/vendors/${vendor.id}/edit">Edit</a></td>
      </tr>`).join("");
  const categoryOptions = [`<option value="">All Categories</option>`]
    .concat(vendorCategories.map((value) => `<option value="${esc(value)}" ${category === value ? "selected" : ""}>${esc(value)}</option>`))
    .join("");
  res.send(layout("Vendors", `
        <h1>Vendors</h1>
        <div class="card">
          <div class="actions"><a class="btn btn-primary" href="/vendors/new">Add Vendor</a></div>
        </div>
        <div class="card">
          <form method="get" action="/vendors" class="stack">
            <div class="grid">
              <div><label>Search</label><input name="search" value="${esc(search)}" placeholder="Name, contact, email, or phone" /></div>
              <div><label>Category</label><select name="category">${categoryOptions}</select></div>
            </div>
            <div class="actions"><button type="submit">Filter Vendors</button><a class="btn btn-secondary" href="/vendors">Clear</a><span class="muted">${vendors.length} vendor(s)</span></div>
          </form>
        </div>
        <div class="card scroll"><table><tr><th><a href="${sortLink("name")}">Name</a></th><th><a href="${sortLink("contact_name")}">Contact</a></th><th><a href="${sortLink("email")}">Email</a></th><th><a href="${sortLink("phone")}">Phone</a></th><th><a href="${sortLink("categories")}">Categories</a></th><th>Action</th></tr>${rows}</table></div>
      `, req.user));
});

app.get("/vendors/new", requireAuth, async (req, res) => {
  const checks = vendorCategories.map((category) => `<label class="check-option"><input type="checkbox" name="categories" value="${esc(category)}" /><span>${esc(category)}</span></label>`).join("");
  res.send(layout("Add Vendor", `
    <h1>Add Vendor</h1>
    <div class="card">
      <form method="post" action="/vendors/add" class="stack">
        <div class="grid">
          <div><label>Name</label><input name="name" required /></div>
          <div><label>Contact Name</label><input name="contact_name" /></div>
          <div><label>Email</label><input name="email" /></div>
          <div><label>Phone</label><input name="phone" inputmode="tel" autocomplete="off" oninput="applyPhoneMask(this)" /><div class="muted">Format: 000-000-0000</div></div>
        </div>
        <div><label>Categories</label><div class="check-grid">${checks}</div></div>
        <div class="actions"><button type="submit">Add Vendor</button><a class="btn btn-secondary" href="/vendors">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/vendors/add", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
      const result = await client.query(
        "insert into vendors (name, contact_name, email, phone, categories) values ($1, $2, $3, $4, $5) returning id",
      [req.body.name?.trim(), req.body.contact_name?.trim(), normalizeEmail(req.body.email), normalizePhone(req.body.phone), normalizeCategories(req.body.categories)]
      );
    await auditLog(client, req.user.id, "create", "vendor", result.rows[0].id, req.body.name?.trim() || "");
  });
  res.redirect("/vendors");
});

app.get("/vendors/:id/edit", requireAuth, async (req, res) => {
  const vendor = (await query("select * from vendors where id = $1", [req.params.id])).rows[0];
  if (!vendor) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Vendor not found.</h3></div>`, req.user));
    return;
  }
  const selected = new Set((vendor.categories || "").split(",").filter(Boolean));
  const checks = vendorCategories.map((category) => `<label class="check-option"><input type="checkbox" name="categories" value="${esc(category)}" ${selected.has(category) ? "checked" : ""}/><span>${esc(category)}</span></label>`).join("");
  res.send(layout("Edit Vendor", `
      <h1>Edit Vendor</h1>
      <div class="card">
        <form method="post" action="/vendors/${vendor.id}/edit" class="stack">
          <div class="grid">
            <div><label>Name</label><input name="name" value="${esc(vendor.name)}" required /></div>
            <div><label>Contact Name</label><input name="contact_name" value="${esc(vendor.contact_name || "")}" /></div>
            <div><label>Email</label><input name="email" value="${esc(vendor.email || "")}" /></div>
            <div><label>Phone</label><input name="phone" value="${esc(normalizePhone(vendor.phone || ""))}" inputmode="tel" autocomplete="off" oninput="applyPhoneMask(this)" /><div class="muted">Format: 000-000-0000</div></div>
          </div>
          <div><label>Categories</label><div class="check-grid">${checks}</div></div>
          <div class="actions"><button type="submit">Save Vendor</button><a class="btn btn-secondary" href="/vendors">Back</a></div>
        </form>
      </div>
    `, req.user));
});

app.post("/vendors/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
      await client.query(
        "update vendors set name = $2, contact_name = $3, email = $4, phone = $5, categories = $6 where id = $1",
      [req.params.id, req.body.name?.trim(), req.body.contact_name?.trim(), normalizeEmail(req.body.email), normalizePhone(req.body.phone), normalizeCategories(req.body.categories)]
      );
    await auditLog(client, req.user.id, "update", "vendor", req.params.id, req.body.name?.trim() || "");
  });
  res.redirect("/vendors");
});

app.get("/rfq", requireAuth, async (req, res) => {
  const rfqNo = String(req.query.rfq_no || "").trim();
  const project = String(req.query.project || "").trim();
  const status = String(req.query.status || "").trim();
  const itemCode = String(req.query.item_code || "").trim();
  const vendorId = String(req.query.vendor_id || "").trim();
  const vendors = (await query("select id, name from vendors order by name")).rows;
  const where = [];
  const params = [];
  if (rfqNo) {
    params.push(`%${rfqNo}%`);
    where.push(`r.rfq_no ilike $${params.length}`);
  }
  if (project) {
    params.push(`%${project}%`);
    where.push(`r.project_name ilike $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (itemCode) {
    params.push(`%${itemCode}%`);
    where.push(`exists (
      select 1
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.rfq_id = r.id and mi.item_code ilike $${params.length}
    )`);
  }
  if (vendorId) {
    params.push(num(vendorId));
    where.push(`exists (
      select 1
      from rfq_items ri
      join quotes q on q.rfq_item_id = ri.id
      where ri.rfq_id = r.id and q.vendor_id = $${params.length}
    )`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const [rfqsRes, nextRfqNo, jobNumber] = await Promise.all([
    query(`
    select r.*
    from rfqs r
    ${whereSql}
    order by r.id desc
    limit 300
  `, params),
    getNextRfqNumber(),
    getJobNumber()
  ]);
  const rfqs = rfqsRes.rows;
  const vendorOptions = [`<option value="">All Vendors</option>`]
    .concat(vendors.map((vendor) => `<option value="${vendor.id}" ${String(vendor.id) === vendorId ? "selected" : ""}>${esc(vendor.name)}</option>`))
    .join("");
  const rows = rfqs.map((rfq) => `<tr>
    <td><a href="/rfq/${rfq.id}">${esc(rfq.rfq_no)}</a></td>
    <td>${esc(rfq.project_name)}</td>
    <td>${esc(rfq.due_date || "")}</td>
    <td><span class="chip">${esc(rfq.status)}</span></td>
  </tr>`).join("");
  res.send(layout("RFQs", `
    <h1>RFQs</h1>
    <div class="card">
      <form method="get" action="/rfq" class="stack">
        <div class="grid-4">
          <div><label>RFQ #</label><input name="rfq_no" value="${esc(rfqNo)}" /></div>
          <div><label>Project</label><input name="project" value="${esc(project)}" /></div>
          <div><label>Status</label><select name="status"><option value="">All Statuses</option><option value="OPEN" ${status === "OPEN" ? "selected" : ""}>OPEN</option><option value="CLOSED" ${status === "CLOSED" ? "selected" : ""}>CLOSED</option></select></div>
          <div><label>Item Code</label><input name="item_code" value="${esc(itemCode)}" /></div>
        </div>
        <div class="grid">
          <div><label>Quoted Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
        </div>
        <div class="actions"><button type="submit">Filter RFQs</button><a class="btn btn-secondary" href="/rfq">Clear</a><span class="muted">${rfqs.length} result(s), max 300 shown</span></div>
      </form>
    </div>
    <div class="card">
      <form method="post" action="/rfq" class="stack">
        <div class="grid">
          <div><label>Job Number</label><input value="${esc(jobNumber)}" readonly /></div>
          <div><label>Next RFQ Number</label><input value="${esc(nextRfqNo)}" readonly /></div>
        </div>
        <div class="grid">
          <div><label>Project</label><input name="project_name" required /></div>
          <div><label>Due Date</label><input type="date" name="due_date" /></div>
        </div>
        <div class="actions"><button type="submit">Create RFQ</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>RFQ</th><th>Project</th><th>Due</th><th>Status</th></tr>${rows || `<tr><td colspan="4" class="muted">No RFQs match the current filter.</td></tr>`}</table></div>
  `, req.user));
});

app.post("/rfq", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const id = await withTransaction(async (client) => {
    const rfqNo = await getNextRfqNumber(client);
    const insert = await client.query(
      "insert into rfqs (rfq_no, project_name, due_date, status) values ($1, $2, $3, 'OPEN') returning id",
      [rfqNo, req.body.project_name?.trim(), req.body.due_date || null]
    );
    await auditLog(client, req.user.id, "create", "rfq", insert.rows[0].id, rfqNo);
    return insert.rows[0].id;
  });
  res.redirect(`/rfq/${id}`);
});

app.get("/rfq/:id", requireAuth, async (req, res) => {
  const rfqId = Number(req.params.id);
  const rfq = (await query("select * from rfqs where id = $1", [rfqId])).rows[0];
  if (!rfq) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ not found.</h3></div>`, req.user));
    return;
  }
  const [itemsRes, vendorsRes, quoteVendorsRes, poCountRes, recentImportsRes, materialItemsRes] = await Promise.all([
    query(`
      select ri.id, ri.qty, ri.notes, ri.spec, ri.commodity_code, ri.tag_number, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.updated_at,
             ri.award_status, ri.awarded_vendor_id, ri.awarded_unit_price, ri.awarded_lead_days, ri.award_notes,
             mi.item_code, mi.description, mi.material_type, mi.uom
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.rfq_id = $1
      order by ri.id desc
    `, [rfqId]),
    query("select id, name from vendors order by name"),
    query(`
      select distinct v.id, v.name
      from quotes q
      join rfq_items ri on ri.id = q.rfq_item_id
      join vendors v on v.id = q.vendor_id
      where ri.rfq_id = $1
      order by v.name
    `, [rfqId]),
    query("select count(*) from purchase_orders where rfq_id = $1", [rfqId]),
    query(`
      select ib.id, ib.entity_type, ib.status, ib.inserted_count, ib.updated_count, ib.skipped_count, ib.created_at,
             coalesce((select count(*) from import_batch_errors ibe where ibe.batch_id = ib.id), 0) as error_count
      from import_batches ib
      where ib.rfq_id = $1
      order by ib.id desc
      limit 5
    `, [rfqId]),
    query("select item_code, description, material_type, uom from material_items order by item_code limit 500")
  ]);

  const items = itemsRes.rows;
  const vendors = vendorsRes.rows;
  const quoteVendors = quoteVendorsRes.rows;
  const poCount = Number(poCountRes.rows[0].count);
  const recentImports = recentImportsRes.rows;
  const materialItems = materialItemsRes.rows;
  const vendorNameMap = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const materialItemRows = materialItems
    .map((item) => `<tr>
      <td>${esc(item.item_code)}</td>
      <td>${esc(item.description)}</td>
      <td>${esc(item.material_type)}</td>
      <td>${esc(item.uom)}</td>
      <td>
        <form method="post" action="/rfq/${rfqId}/items/add">
          <input type="hidden" name="item_code" value="${esc(item.item_code)}" />
          <input type="hidden" name="description" value="${esc(item.description)}" />
          <input type="hidden" name="material_type" value="${esc(item.material_type)}" />
          <input type="hidden" name="uom" value="${esc(item.uom)}" />
          <input type="hidden" name="qty" value="1" />
          <button type="submit">Add</button>
        </form>
      </td>
    </tr>`)
    .join("");
  const newItemRows = Array.from({ length: 8 }, (_, index) => `
    <tr>
      <td><input name="item_code_${index}" /></td>
      <td><input name="description_${index}" /></td>
      <td><input name="material_type_${index}" /></td>
      <td><input name="uom_${index}" /></td>
      <td><input name="spec_${index}" /></td>
      <td><input name="commodity_code_${index}" /></td>
      <td><input name="tag_number_${index}" /></td>
      <td><input name="size_1_${index}" /></td>
      <td><input name="size_2_${index}" /></td>
      <td><input name="thk_1_${index}" /></td>
      <td><input name="thk_2_${index}" /></td>
      <td><input name="qty_${index}" /></td>
      <td><input name="notes_${index}" /></td>
    </tr>
  `).join("");

  const itemRows = [];
  for (const item of items) {
    const [quotesRes, poRefsRes] = await Promise.all([
      query("select vendor_id, unit_price, lead_days from quotes where rfq_item_id = $1", [item.id]),
      query(`
        select distinct po.po_no
        from purchase_orders po
        join po_lines pl on pl.po_id = po.id
        where pl.rfq_item_id = $1
        order by po.po_no
      `, [item.id])
    ]);
    const qMap = new Map(quotesRes.rows.map((row) => [row.vendor_id, quoteCell(row.unit_price, row.lead_days)]));
    const vendorCells = quoteVendors.map((vendor) => `<td>${esc(qMap.get(vendor.id) || "-")}</td>`).join("");
    const poRefs = poRefsRes.rows.map((row) => row.po_no).join(", ") || "Not Issued";
    const awardedVendor = item.awarded_vendor_id ? (vendorNameMap.get(item.awarded_vendor_id) || `Vendor ${item.awarded_vendor_id}`) : "";
    const awardSummary = item.award_status === "AWARDED"
      ? `${awardedVendor} | $${Number(item.awarded_unit_price || 0).toFixed(2)} | ${num(item.awarded_lead_days)}d`
      : "Open";
    itemRows.push(`<tr>
      <td>${esc(item.item_code)}</td>
      <td>${esc(item.description)}</td>
      <td>${esc(item.material_type)}</td>
      <td>${esc(item.qty)}</td>
      <td>${esc(item.uom)}</td>
      <td>${esc(item.spec || "")}</td>
      <td>${esc(item.commodity_code || "")}</td>
      <td>${esc(item.tag_number || "")}</td>
      <td>${esc(item.size_1 || "")}</td>
      <td>${esc(item.size_2 || "")}</td>
      <td>${esc(item.thk_1 || "")}</td>
      <td>${esc(item.thk_2 || "")}</td>
      <td>${esc(item.notes || "")}</td>
      <td>${esc(item.award_status)}</td>
      <td>${esc(awardSummary)}</td>
      ${vendorCells}
      <td>${esc(poRefs)}</td>
      <td><div class="actions">
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/award">${item.award_status === "AWARDED" ? "Change Award" : "Award"}</a>
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/quotes">Quotes</a>
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/edit">Edit</a>
        ${item.award_status === "AWARDED" ? `<form method="post" action="/rfq-item/${item.id}/award/clear"><button class="btn btn-secondary" type="submit">Clear Award</button></form>` : ""}
        <form method="post" action="/rfq-item/${item.id}/delete"><button class="btn btn-danger" type="submit">Delete</button></form>
      </div></td>
    </tr>`);
  }

  const awardedVendorCounts = (await query(`
    select awarded_vendor_id as vendor_id, count(*) as line_count
    from rfq_items
    where rfq_id = $1 and award_status = 'AWARDED' and awarded_vendor_id is not null
      and not exists (
        select 1
        from po_lines pl
        join purchase_orders po on po.id = pl.po_id
        where po.rfq_id = rfq_items.rfq_id and pl.rfq_item_id = rfq_items.id
      )
    group by awarded_vendor_id
    order by awarded_vendor_id
  `, [rfqId])).rows;
  const poVendorOptions = awardedVendorCounts
    .map((row) => `<option value="${row.vendor_id}">${esc(vendorNameMap.get(row.vendor_id) || `Vendor ${row.vendor_id}`)} (${row.line_count} awarded line(s))</option>`)
    .join("");
  const vendorHeaders = quoteVendors.map((vendor) => `<th>${esc(vendor.name)}</th>`).join("");
  const importRows = recentImports.length > 0
    ? recentImports.map((batch) => `<tr><td><a href="/imports/${batch.id}">${esc(batch.entity_type)}</a></td><td>${esc(batch.created_at)}</td><td>${esc(batch.status)}</td><td>${batch.inserted_count}</td><td>${batch.updated_count}</td><td>${batch.skipped_count}</td><td>${batch.error_count}</td></tr>`).join("")
    : `<tr><td colspan="7" class="muted">No imports logged yet.</td></tr>`;
  const addItemCard = `
    <div class="card">
      <h3>Existing Items</h3>
      <p class="muted">Filter the master item list like a spreadsheet, then add the line into this RFQ.</p>
      <div class="grid">
        <div><label>Filter Existing Items</label><input id="existing-items-filter-${rfqId}" oninput="filterTableRows('existing-items-filter-${rfqId}', 'existing-items-table-${rfqId}')" placeholder="Search item code, description, type, or UOM" /></div>
      </div>
      <div class="scroll">
        <table id="existing-items-table-${rfqId}">
          <thead><tr><th>Item Code</th><th>Description</th><th>Type</th><th>UOM</th><th>Add</th></tr></thead>
          <tbody>${materialItemRows || `<tr><td colspan="5" class="muted">No existing items found.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3>Add New RFQ Items</h3>
      <p class="muted">Use this like an Excel grid. Fill in the rows you want, leave the rest blank, and save. New item codes are also added to the master item table.</p>
      <form method="post" action="/rfq/${rfqId}/items/grid" class="stack">
        <div class="scroll">
          <table>
            <thead><tr><th>Item Code</th><th>Description</th><th>Type</th><th>UOM</th><th>Spec</th><th>Commodity Code</th><th>Tag Number</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty</th><th>Notes</th></tr></thead>
            <tbody>${newItemRows}</tbody>
          </table>
        </div>
        <div class="actions"><button type="submit">Save Grid Rows</button></div>
      </form>
    </div>`;
  const pasteTableCard = `
    <div class="card">
      <h3>Paste RFQ Table</h3>
      <p class="muted">Paste rows directly from Excel. Header row is optional. Expected column order: item_code, description, material_type, uom, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes</p>
      <div class="scroll">
        <table>
          <tr><th>Item Code</th><th>Description</th><th>Type</th><th>UOM</th><th>Spec</th><th>Commodity Code</th><th>Tag Number</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty</th><th>Notes</th></tr>
        </table>
      </div>
      <form method="post" action="/rfq/${rfqId}/items/paste" class="stack">
        <div><label>Paste Table</label><textarea name="table_text" style="min-height:220px;font-family:Consolas,monospace;" placeholder="item_code	description	material_type	uom	spec	commodity_code	tag_number	size_1	size_2	thk_1	thk_2	qty	notes&#10;P-1001	6&quot; CS Pipe	Pipe	LF	AS01CR			6		sch40		40"></textarea></div>
        <div class="actions"><button type="submit">Paste Into RFQ</button></div>
      </form>
    </div>`;
  const uploadItemsCard = `
    <div class="card">
      <h3>Import RFQ Items From File</h3>
      <p class="muted">CSV/XLSX columns: item_code, description, material_type, uom, spec, commodity_code, tag_number, size_1, size_2, thk_1, thk_2, qty, notes</p>
      <form method="post" enctype="multipart/form-data" action="/rfq/${rfqId}/items/import" class="stack">
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div class="actions"><button type="submit">Import File</button></div>
      </form>
    </div>`;
  const importQuotesCard = `
    <div class="card">
      <h3>Import Vendor Quotes</h3>
      <p class="muted">CSV/XLSX columns: vendor_name, item_code, unit_price, lead_days</p>
      <form method="post" enctype="multipart/form-data" action="/rfq/${rfqId}/quotes/import" class="stack">
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div><label>Or Paste Quote CSV</label><textarea name="csv_text"></textarea></div>
        <div class="actions"><button type="submit">Import Quotes</button></div>
      </form>
    </div>`;
  const issuePoCard = `
    <div class="card">
      <h3>Issue PO From Awarded Lines</h3>
      <form method="post" action="/po/create" class="stack">
        <input type="hidden" name="rfq_id" value="${rfqId}" />
        <div class="grid">
          <div><label>PO Number</label><input name="po_no" required /></div>
          <div><label>Vendor</label><select name="vendor_id" required><option value="">Select awarded vendor</option>${poVendorOptions}</select></div>
        </div>
        <div class="actions"><button type="submit">Create PO From Awarded Lines</button></div>
      </form>
    </div>`;
  const issuePoHelpCard = `
    <div class="card">
      <h3>Issue PO From Awarded Lines</h3>
      <p class="muted">Award at least one RFQ item line first. Once lines are awarded, they will appear here by vendor so you can create the PO.</p>
    </div>`;

  res.send(layout(`RFQ ${rfq.rfq_no}`, `
    <h1>RFQ ${esc(rfq.rfq_no)}</h1>
    ${poCount === 0 ? addItemCard : ""}
    ${poCount === 0 ? pasteTableCard : ""}
    ${poCount === 0 ? importQuotesCard : ""}
    ${awardedVendorCounts.length > 0 ? issuePoCard : issuePoHelpCard}
    <div class="card scroll">
      <h3>RFQ Items</h3>
      <table>
        <tr><th>Item</th><th>Description</th><th>Type</th><th>Qty</th><th>UOM</th><th>Spec</th><th>Commodity Code</th><th>Tag Number</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Notes</th><th>Award Status</th><th>Award Summary</th>${vendorHeaders}<th>Issued PO</th><th>Actions</th></tr>
        ${itemRows.join("") || `<tr><td colspan="${17 + quoteVendors.length}" class="muted">No RFQ items loaded yet.</td></tr>`}
      </table>
    </div>
    <div class="card scroll">
      <h3>Recent Imports</h3>
      <table>
        <tr><th>Type</th><th>Created</th><th>Status</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Errors</th></tr>
        ${importRows}
      </table>
    </div>
    ${poCount === 0 ? uploadItemsCard : ""}
  `, req.user));
});

app.post("/rfq/:id/items/import", requireAuth, requireRole(["admin", "buyer"]), upload.single("sheet"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "rfq_items",
      rfqId,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const result = await upsertRfqItemRow(client, rfqId, row);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, result.errorCode, result.message, row);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "rfq_items", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.post("/rfq/:id/items/add", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const rfqId = Number(req.params.id);
  await withTransaction(async (client) => {
    const result = await upsertRfqItemRow(client, rfqId, req.body);
    if (result.status === "skipped") throw new Error(result.message);
    await auditLog(client, req.user.id, "upsert", "rfq_item", rfqId, `item=${req.body.item_code || ""}`);
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq/:id/items/grid", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = Array.from({ length: 8 }, (_, index) => ({
    item_code: req.body[`item_code_${index}`],
    description: req.body[`description_${index}`],
    material_type: req.body[`material_type_${index}`],
    uom: req.body[`uom_${index}`],
    spec: req.body[`spec_${index}`],
    commodity_code: req.body[`commodity_code_${index}`],
    tag_number: req.body[`tag_number_${index}`],
    size_1: req.body[`size_1_${index}`],
    size_2: req.body[`size_2_${index}`],
    thk_1: req.body[`thk_1_${index}`],
    thk_2: req.body[`thk_2_${index}`],
    qty: req.body[`qty_${index}`],
    notes: req.body[`notes_${index}`]
  })).filter((row) => String(row.item_code || "").trim() || String(row.description || "").trim() || String(row.qty || "").trim());
  if (rows.length === 0) throw new Error("No grid rows were entered.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "rfq_items",
      rfqId,
      uploadedBy: req.user.id,
      filename: "manual-grid"
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const result = await upsertRfqItemRow(client, rfqId, rows[index]);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, index + 1, result.errorCode, result.message, rows[index]);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "grid_add", "rfq_items", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.post("/rfq/:id/items/paste", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseDelimitedRows(req.body.table_text);
  if (rows.length === 0) throw new Error("No pasted rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "rfq_items",
      rfqId,
      uploadedBy: req.user.id,
      filename: "pasted-table"
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 1;
      const result = await upsertRfqItemRow(client, rfqId, row);
      if (result.status === "inserted") insertedCount += 1;
      else if (result.status === "updated") updatedCount += 1;
      else {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, result.errorCode, result.message, row);
      }
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "paste", "rfq_items", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.post("/rfq/:id/quotes/import", requireAuth, requireRole(["admin", "buyer"]), upload.single("sheet"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  const batchId = await withTransaction(async (client) => {
    const batchId = await createImportBatch(client, {
      entityType: "quotes",
      rfqId,
      uploadedBy: req.user.id,
      filename: req.file?.originalname || ""
    });
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 2;
      const vendorName = String(row.vendor_name || "").trim();
      const itemCode = String(row.item_code || "").trim();
      const unitPrice = num(row.unit_price, NaN);
      const leadDays = num(row.lead_days);
      if (!vendorName || !itemCode || !Number.isFinite(unitPrice) || unitPrice <= 0) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "invalid_quote", "Vendor, item code, and unit price are required.", row);
        continue;
      }
      let vendorId;
      const vendorRes = await client.query("select id from vendors where name = $1", [vendorName]);
      if (vendorRes.rows[0]) {
        vendorId = vendorRes.rows[0].id;
      } else {
        const insertVendor = await client.query("insert into vendors (name, email, phone, categories) values ($1, '', '', '') returning id", [vendorName]);
        vendorId = insertVendor.rows[0].id;
      }
      const rfqItemRes = await client.query(`
        select ri.id
        from rfq_items ri
        join material_items mi on mi.id = ri.material_item_id
        where ri.rfq_id = $1 and mi.item_code = $2
      `, [rfqId, itemCode]);
      if (!rfqItemRes.rows[0]) {
        skippedCount += 1;
        await addImportBatchError(client, batchId, rowNumber, "rfq_item_not_found", "Item code does not exist on this RFQ.", row);
        continue;
      }
      const rfqItemId = rfqItemRes.rows[0].id;
      const existingQuote = await client.query(
        "select id from quotes where rfq_item_id = $1 and vendor_id = $2",
        [rfqItemId, vendorId]
      );
      await client.query(`
        insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
        values ($1, $2, $3, $4, now())
        on conflict (rfq_item_id, vendor_id)
        do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
      `, [rfqItemId, vendorId, unitPrice, leadDays]);
      await client.query(`
        update rfq_items
        set awarded_unit_price = $3, awarded_lead_days = $4, updated_at = now()
        where id = $1 and award_status = 'AWARDED' and awarded_vendor_id = $2
      `, [rfqItemId, vendorId, unitPrice, leadDays]);
      await writeQuoteRevision(client, {
        rfqItemId,
        vendorId,
        unitPrice,
        leadDays,
        sourceType: "import",
        sourceBatchId: batchId,
        createdBy: req.user.id
      });
      if (existingQuote.rows[0]) updatedCount += 1;
      else insertedCount += 1;
    }
    await updateImportBatch(client, batchId, { insertedCount, updatedCount, skippedCount });
    await auditLog(client, req.user.id, "import", "quotes", rfqId, `rows=${rows.length};batch=${batchId}`);
    return batchId;
  });
  res.redirect(`/imports/${batchId}`);
});

app.get("/imports/:id", requireAuth, async (req, res) => {
  const batch = (await query(`
    select ib.*, r.rfq_no
    from import_batches ib
    left join rfqs r on r.id = ib.rfq_id
    where ib.id = $1
  `, [req.params.id])).rows[0];
  if (!batch) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>Import batch not found.</h3></div>`, req.user));
    return;
  }
  const errors = (await query(`
    select row_number, error_code, message, raw_payload
    from import_batch_errors
    where batch_id = $1
    order by row_number, id
  `, [req.params.id])).rows;
  const errorRows = errors.length > 0
    ? errors.map((error) => `<tr><td>${error.row_number}</td><td>${esc(error.error_code)}</td><td>${esc(error.message)}</td><td><code>${esc(JSON.stringify(error.raw_payload))}</code></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">No row-level errors.</td></tr>`;
  res.send(layout("Import Results", `
    <h1>Import Results</h1>
    <div class="card">
      <div class="grid">
        <div><label>RFQ</label><div>${esc(batch.rfq_no || "N/A")}</div></div>
        <div><label>Import Type</label><div>${esc(batch.entity_type)}</div></div>
        <div><label>File</label><div>${esc(batch.filename || "Pasted data")}</div></div>
        <div><label>Status</label><div>${esc(batch.status)}</div></div>
      </div>
      <div class="stats" style="margin-top:18px;">
        <div class="stat"><div>Inserted</div><strong>${batch.inserted_count}</strong></div>
        <div class="stat"><div>Updated</div><strong>${batch.updated_count}</strong></div>
        <div class="stat"><div>Skipped</div><strong>${batch.skipped_count}</strong></div>
        <div class="stat"><div>Errors</div><strong>${errors.length}</strong></div>
      </div>
      <div class="actions" style="margin-top:18px;"><a class="btn btn-secondary" href="/rfq/${batch.rfq_id}">Back To RFQ</a></div>
    </div>
    <div class="card scroll">
      <h3>Row Results</h3>
      <table><tr><th>Row</th><th>Code</th><th>Message</th><th>Payload</th></tr>${errorRows}</table>
    </div>
  `, req.user));
});

app.post("/po/create", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const rfqId = Number(req.body.rfq_id);
  const vendorId = Number(req.body.vendor_id);
  const poNo = String(req.body.po_no || "").trim();
  if (!vendorId) throw new Error("Select a vendor with awarded RFQ lines.");
  await withTransaction(async (client) => {
    const poInsert = await client.query(
      "insert into purchase_orders (po_no, vendor_id, rfq_id, status, updated_at) values ($1, $2, $3, 'OPEN', now()) returning id",
      [poNo, vendorId, rfqId]
    );
    const poId = poInsert.rows[0].id;
    const lines = await client.query(`
      select ri.id as rfq_item_id, ri.material_item_id, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.qty,
             ri.awarded_unit_price as unit_price
      from rfq_items ri
      where ri.rfq_id = $1 and ri.award_status = 'AWARDED' and ri.awarded_vendor_id = $2
        and not exists (
          select 1
          from po_lines pl
          join purchase_orders po on po.id = pl.po_id
          where po.rfq_id = ri.rfq_id and pl.rfq_item_id = ri.id
        )
    `, [rfqId, vendorId]);
    if (lines.rows.length === 0) throw new Error("Selected vendor has no unissued awarded lines on this RFQ.");
    for (const line of lines.rows) {
      await client.query(`
        insert into po_lines (po_id, rfq_item_id, material_item_id, size_1, size_2, thk_1, thk_2, qty_ordered, unit_price, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      `, [poId, line.rfq_item_id, line.material_item_id, line.size_1 || "", line.size_2 || "", line.thk_1 || "", line.thk_2 || "", line.qty, line.unit_price]);
    }
    await recalcRfqStatus(client, rfqId);
    await auditLog(client, req.user.id, "create", "purchase_order", poId, poNo);
  });
  res.redirect("/po");
});

app.get("/rfq-item/:id/award", requireAuth, async (req, res) => {
  const [itemRes, quotesRes] = await Promise.all([
    query(`
      select ri.id, ri.rfq_id, ri.award_status, ri.awarded_vendor_id, ri.awarded_unit_price, ri.awarded_lead_days, ri.award_notes,
             mi.item_code, mi.description
      from rfq_items ri
      join material_items mi on mi.id = ri.material_item_id
      where ri.id = $1
    `, [req.params.id]),
    query(`
      select v.id as vendor_id, v.name as vendor_name, q.unit_price, q.lead_days, q.quoted_at
      from quotes q
      join vendors v on v.id = q.vendor_id
      where q.rfq_item_id = $1
      order by q.unit_price, q.lead_days, v.name
    `, [req.params.id])
  ]);
  const item = itemRes.rows[0];
  if (!item) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ item not found.</h3></div>`, req.user));
    return;
  }
  const quoteOptions = quotesRes.rows.map((quote) => `<option value="${quote.vendor_id}" ${quote.vendor_id === item.awarded_vendor_id ? "selected" : ""}>${esc(quote.vendor_name)} | ${quoteCell(quote.unit_price, quote.lead_days)}</option>`).join("");
  const quoteRows = quotesRes.rows.length > 0
    ? quotesRes.rows.map((quote) => `<tr><td>${esc(quote.vendor_name)}</td><td>$${Number(quote.unit_price).toFixed(2)}</td><td>${quote.lead_days} days</td><td>${esc(quote.quoted_at)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">Add quotes before awarding this line.</td></tr>`;
  res.send(layout("Award RFQ Item", `
    <h1>Award RFQ Item</h1>
    <div class="card"><strong>${esc(item.item_code)}</strong> | ${esc(item.description)}</div>
    <div class="card">
      <form method="post" action="/rfq-item/${item.id}/award" class="stack">
        <div class="grid">
          <div><label>Quoted Vendor</label><select name="vendor_id" ${quotesRes.rows.length === 0 ? "disabled" : ""}>${quoteOptions}</select></div>
          <div><label>Award Notes</label><input name="award_notes" value="${esc(item.award_notes || "")}" /></div>
        </div>
        <div class="actions"><button type="submit" ${quotesRes.rows.length === 0 ? "disabled" : ""}>Save Award</button><a class="btn btn-secondary" href="/rfq/${item.rfq_id}">Back</a></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Updated</th></tr>${quoteRows}</table></div>
  `, req.user));
});

app.post("/rfq-item/:id/award", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const quote = (await client.query(`
      select ri.rfq_id, q.vendor_id, q.unit_price, q.lead_days
      from rfq_items ri
      join quotes q on q.rfq_item_id = ri.id
      where ri.id = $1 and q.vendor_id = $2
    `, [itemId, Number(req.body.vendor_id)])).rows[0];
    if (!quote) throw new Error("Select a quoted vendor before awarding.");
    await client.query(`
      update rfq_items
      set award_status = 'AWARDED',
          awarded_vendor_id = $2,
          awarded_unit_price = $3,
          awarded_lead_days = $4,
          awarded_at = now(),
          awarded_by = $5,
          award_notes = $6,
          updated_at = now()
      where id = $1
    `, [itemId, quote.vendor_id, quote.unit_price, quote.lead_days, req.user.id, req.body.award_notes || ""]);
    await auditLog(client, req.user.id, "award", "rfq_item", itemId, `vendor=${quote.vendor_id}`);
    return quote.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq-item/:id/award/clear", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const current = (await client.query("select rfq_id from rfq_items where id = $1", [itemId])).rows[0];
    if (!current) throw new Error("RFQ item not found.");
    const issued = await client.query(`
      select 1
      from po_lines pl
      join purchase_orders po on po.id = pl.po_id
      where pl.rfq_item_id = $1
      limit 1
    `, [itemId]);
    if (issued.rows[0]) throw new Error("Cannot clear an award after a PO line has been issued.");
    await client.query(`
      update rfq_items
      set award_status = 'OPEN',
          awarded_vendor_id = null,
          awarded_unit_price = null,
          awarded_lead_days = null,
          awarded_at = null,
          awarded_by = null,
          award_notes = null,
          updated_at = now()
      where id = $1
    `, [itemId]);
    await auditLog(client, req.user.id, "clear_award", "rfq_item", itemId, "");
    return current.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.get("/rfq-item/:id/edit", requireAuth, async (req, res) => {
  const item = (await query(`
    select ri.id, ri.rfq_id, ri.qty, ri.notes, ri.spec, ri.commodity_code, ri.tag_number, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, extract(epoch from ri.updated_at)::text as updated_token,
           mi.item_code, mi.description, mi.material_type, mi.uom
    from rfq_items ri
    join material_items mi on mi.id = ri.material_item_id
    where ri.id = $1
  `, [req.params.id])).rows[0];
  if (!item) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ item not found.</h3></div>`, req.user));
    return;
  }
  res.send(layout("Edit RFQ Item", `
    <h1>Edit RFQ Item</h1>
    <div class="card">
      <form method="post" action="/rfq-item/${item.id}/edit" class="stack">
        <input type="hidden" name="updated_token" value="${esc(item.updated_token)}" />
        <div class="grid">
          <div><label>Item Code</label><input name="item_code" value="${esc(item.item_code)}" required /></div>
          <div><label>Description</label><input name="description" value="${esc(item.description)}" /></div>
          <div><label>Type</label><input name="material_type" value="${esc(item.material_type)}" /></div>
          <div><label>UOM</label><input name="uom" value="${esc(item.uom)}" /></div>
          <div><label>Qty</label><input name="qty" value="${esc(item.qty)}" required /></div>
          <div><label>Spec</label><input name="spec" value="${esc(item.spec || "")}" /></div>
          <div><label>Commodity Code</label><input name="commodity_code" value="${esc(item.commodity_code || "")}" /></div>
          <div><label>Tag Number</label><input name="tag_number" value="${esc(item.tag_number || "")}" /></div>
          <div><label>Size 1</label><input name="size_1" value="${esc(item.size_1 || "")}" /></div>
          <div><label>Size 2</label><input name="size_2" value="${esc(item.size_2 || "")}" /></div>
          <div><label>Thk 1</label><input name="thk_1" value="${esc(item.thk_1 || "")}" /></div>
          <div><label>Thk 2</label><input name="thk_2" value="${esc(item.thk_2 || "")}" /></div>
        </div>
        <div><label>Notes</label><textarea name="notes">${esc(item.notes || "")}</textarea></div>
        <div class="actions"><button type="submit">Save Item</button><a class="btn btn-secondary" href="/rfq/${item.rfq_id}">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/rfq-item/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const current = (await client.query("select rfq_id, material_item_id from rfq_items where id = $1", [itemId])).rows[0];
    if (!current) throw new Error("RFQ item not found.");
    await client.query(
      "update material_items set item_code = $2, description = $3, material_type = $4, uom = $5 where id = $1",
      [current.material_item_id, req.body.item_code?.trim(), req.body.description?.trim() || req.body.item_code?.trim(), req.body.material_type?.trim() || "misc", req.body.uom?.trim() || "EA"]
    );
    const update = await client.query(`
      update rfq_items
      set spec = $2, commodity_code = $3, tag_number = $4, size_1 = $5, size_2 = $6, thk_1 = $7, thk_2 = $8, qty = $9, notes = $10, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $11
    `, [itemId, req.body.spec || "", req.body.commodity_code || "", req.body.tag_number || "", req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", Number(req.body.qty || 0), req.body.notes || "", req.body.updated_token || ""]);
    if (update.rowCount === 0) throw new Error("This RFQ item was modified by another user. Refresh and try again.");
    await auditLog(client, req.user.id, "update", "rfq_item", itemId, req.body.item_code?.trim() || "");
    return current.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq-item/:id/delete", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const itemId = Number(req.params.id);
  const rfqId = await withTransaction(async (client) => {
    const current = (await client.query("select rfq_id from rfq_items where id = $1", [itemId])).rows[0];
    if (!current) throw new Error("RFQ item not found.");
    await client.query("delete from rfq_items where id = $1", [itemId]);
    await auditLog(client, req.user.id, "delete", "rfq_item", itemId, "");
    return current.rfq_id;
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.get("/rfq-item/:id/quotes", requireAuth, async (req, res) => {
  const item = (await query(`
    select ri.id, ri.rfq_id, ri.award_status, ri.awarded_vendor_id, ri.awarded_unit_price, ri.awarded_lead_days,
           mi.item_code, mi.description
    from rfq_items ri
    join material_items mi on mi.id = ri.material_item_id
    where ri.id = $1
  `, [req.params.id])).rows[0];
  if (!item) {
    res.status(404).send(layout("Not Found", `<div class="card error"><h3>RFQ item not found.</h3></div>`, req.user));
    return;
  }
  const vendors = (await query("select id, name from vendors order by name")).rows;
  const quotes = (await query(`
    select v.id as vendor_id, v.name as vendor_name, q.unit_price, q.lead_days, q.quoted_at
    from quotes q
    join vendors v on v.id = q.vendor_id
    where q.rfq_item_id = $1
    order by q.unit_price, q.lead_days
  `, [req.params.id])).rows;
  const revisions = (await query(`
    select v.name as vendor_name, qr.unit_price, qr.lead_days, qr.source_type, qr.created_at
    from quote_revisions qr
    join vendors v on v.id = qr.vendor_id
    where qr.rfq_item_id = $1
    order by qr.id desc
    limit 20
  `, [req.params.id])).rows;
  const vendorOptions = vendors.map((vendor) => `<option value="${vendor.id}">${esc(vendor.name)}</option>`).join("");
  const quoteRows = quotes.length > 0
    ? quotes.map((quote) => `<tr><td>${esc(quote.vendor_name)}</td><td>$${Number(quote.unit_price).toFixed(2)}</td><td>${quote.lead_days} days</td><td>${esc(quote.quoted_at)}</td>${item.awarded_vendor_id === quote.vendor_id ? `<td><span class="chip">Awarded</span></td>` : `<td></td>`}</tr>`).join("")
    : `<tr><td colspan="5" class="muted">No quotes yet</td></tr>`;
  const revisionRows = revisions.length > 0
    ? revisions.map((revision) => `<tr><td>${esc(revision.vendor_name)}</td><td>$${Number(revision.unit_price).toFixed(2)}</td><td>${revision.lead_days} days</td><td>${esc(revision.source_type)}</td><td>${esc(revision.created_at)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">No quote revisions yet</td></tr>`;
  res.send(layout("Manage Quotes", `
    <h1>Manage Quotes</h1>
    <div class="card"><strong>${esc(item.item_code)}</strong> | ${esc(item.description)} | <strong>Award:</strong> ${item.award_status === "AWARDED" ? `${esc(quotes.find((quote) => quote.vendor_id === item.awarded_vendor_id)?.vendor_name || "Awarded")} @ $${Number(item.awarded_unit_price || 0).toFixed(2)} | ${num(item.awarded_lead_days)}d` : "Open"}</div>
    <div class="card">
      <form method="post" action="/quotes" class="stack">
        <input type="hidden" name="rfq_item_id" value="${item.id}" />
        <input type="hidden" name="rfq_id" value="${item.rfq_id}" />
        <div class="grid">
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
          <div><label>Unit Price</label><input name="unit_price" required /></div>
          <div><label>Lead Days</label><input name="lead_days" /></div>
        </div>
        <div class="actions"><button type="submit">Save Quote</button><a class="btn btn-secondary" href="/rfq/${item.rfq_id}">Back</a></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Updated</th><th>Award</th></tr>${quoteRows}</table></div>
    <div class="card scroll"><h3>Quote Revision History</h3><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Source</th><th>Logged</th></tr>${revisionRows}</table></div>
  `, req.user));
});

app.post("/quotes", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    const rfqItemId = Number(req.body.rfq_item_id);
    const vendorId = Number(req.body.vendor_id);
    const unitPrice = num(req.body.unit_price, NaN);
    const leadDays = num(req.body.lead_days);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error("Unit price must be greater than zero.");
    await client.query(`
      insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
      values ($1, $2, $3, $4, now())
      on conflict (rfq_item_id, vendor_id)
      do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
    `, [rfqItemId, vendorId, unitPrice, leadDays]);
    await client.query(`
      update rfq_items
      set awarded_unit_price = $3, awarded_lead_days = $4, updated_at = now()
      where id = $1 and award_status = 'AWARDED' and awarded_vendor_id = $2
    `, [rfqItemId, vendorId, unitPrice, leadDays]);
    await writeQuoteRevision(client, {
      rfqItemId,
      vendorId,
      unitPrice,
      leadDays,
      sourceType: "manual",
      createdBy: req.user.id
    });
    await auditLog(client, req.user.id, "upsert", "quote", req.body.rfq_item_id, `vendor=${req.body.vendor_id}`);
  });
  res.redirect(`/rfq/${req.body.rfq_id}`);
});

app.get("/po", requireAuth, async (req, res) => {
  const poNo = String(req.query.po_no || "").trim();
  const rfqNo = String(req.query.rfq_no || "").trim();
  const vendorId = String(req.query.vendor_id || "").trim();
  const status = String(req.query.status || "").trim();
  const where = [];
  const params = [];
  if (poNo) { params.push(`%${poNo}%`); where.push(`po.po_no ilike $${params.length}`); }
  if (rfqNo) { params.push(`%${rfqNo}%`); where.push(`r.rfq_no ilike $${params.length}`); }
  if (vendorId) { params.push(Number(vendorId)); where.push(`po.vendor_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`po.status = $${params.length}`); }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const pos = (await query(`
        select po.id, po.po_no, po.vendor_id, po.status, po.created_at, extract(epoch from po.updated_at)::text as updated_token, v.name as vendor, coalesce(r.rfq_no, '') as rfq_no
    from purchase_orders po
    join vendors v on v.id = po.vendor_id
    left join rfqs r on r.id = po.rfq_id
    ${whereSql}
    order by po.id desc
    limit 300
  `, params)).rows;
  const vendors = (await query("select id, name from vendors order by name")).rows;
  const blocks = [];
  for (const po of pos) {
    const lines = (await query(`
      select pl.id, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2, pl.qty_ordered, pl.unit_price, pl.updated_at,
             mi.item_code, mi.description,
             coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) as qty_received
      from po_lines pl
      join material_items mi on mi.id = pl.material_item_id
      where pl.po_id = $1
      order by pl.id
    `, [po.id])).rows;
    const lineRows = lines.map((line) => `<tr>
      <td>${esc(line.item_code)}</td><td>${esc(line.description)}</td><td>${esc(line.size_1 || "")}</td><td>${esc(line.size_2 || "")}</td>
      <td>${esc(line.thk_1 || "")}</td><td>${esc(line.thk_2 || "")}</td><td>${esc(line.qty_ordered)}</td><td>$${Number(line.unit_price).toFixed(2)}</td>
      <td>${esc(line.qty_received)}</td><td><a class="btn btn-secondary" href="/po-line/${line.id}/edit">Edit</a></td>
    </tr>`).join("");
    blocks.push(`
      <div class="card">
        <h3>${esc(po.po_no)} - ${esc(po.vendor)}</h3>
        <p class="muted">RFQ: ${esc(po.rfq_no || "N/A")} | Status: ${esc(po.status)} | Created: ${esc(po.created_at)}</p>
        <div class="actions" style="margin-bottom:12px;">
          <a class="btn btn-secondary" href="/po/${po.id}/edit">Edit PO</a>
          <form method="post" action="/po/${po.id}/delete"><button class="btn btn-danger" type="submit">Delete PO</button></form>
        </div>
        <div class="scroll"><table><tr><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty Ordered</th><th>Unit Price</th><th>Qty Received</th><th>Action</th></tr>${lineRows}</table></div>
      </div>
    `);
  }
  const vendorOptions = [`<option value="">All Vendors</option>`]
    .concat(vendors.map((vendor) => `<option value="${vendor.id}" ${String(vendor.id) === vendorId ? "selected" : ""}>${esc(vendor.name)}</option>`)).join("");
  res.send(layout("POs", `
    <h1>Purchase Orders</h1>
    <div class="card">
      <form method="get" action="/po" class="stack">
        <div class="grid-4">
          <div><label>PO #</label><input name="po_no" value="${esc(poNo)}" /></div>
          <div><label>RFQ #</label><input name="rfq_no" value="${esc(rfqNo)}" /></div>
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
          <div><label>Status</label><select name="status"><option value="">All Statuses</option><option value="OPEN" ${status === "OPEN" ? "selected" : ""}>OPEN</option><option value="CLOSED" ${status === "CLOSED" ? "selected" : ""}>CLOSED</option></select></div>
        </div>
        <div class="actions"><button type="submit">Filter POs</button><a class="btn btn-secondary" href="/po">Clear</a><span class="muted">${pos.length} result(s), max 300 shown</span></div>
      </form>
    </div>
    ${blocks.join("") || `<div class="card"><p class="muted">No POs match the current filter.</p></div>`}
  `, req.user));
});

app.get("/po/:id/edit", requireAuth, async (req, res) => {
  const [po, vendors] = await Promise.all([
    query(`
      select po.id, po.po_no, po.vendor_id, po.status, po.created_at, extract(epoch from po.updated_at)::text as updated_token, coalesce(r.rfq_no, '') as rfq_no
      from purchase_orders po
      left join rfqs r on r.id = po.rfq_id
      where po.id = $1
    `, [req.params.id]),
    query("select id, name from vendors order by name")
  ]);
  const record = po.rows[0];
  const vendorOptions = vendors.rows.map((vendor) => `<option value="${vendor.id}" ${vendor.id === record.vendor_id ? "selected" : ""}>${esc(vendor.name)}</option>`).join("");
  res.send(layout("Edit PO", `
    <h1>Edit PO</h1>
    <div class="card">
      <p class="muted">RFQ: ${esc(record.rfq_no || "N/A")} | Created: ${esc(record.created_at)}</p>
      <form method="post" action="/po/${record.id}/edit" class="stack">
        <input type="hidden" name="updated_token" value="${esc(record.updated_token)}" />
        <div class="grid">
          <div><label>PO Number</label><input name="po_no" value="${esc(record.po_no)}" required /></div>
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
          <div><label>Status</label><select name="status"><option value="OPEN" ${record.status === "OPEN" ? "selected" : ""}>OPEN</option><option value="CLOSED" ${record.status === "CLOSED" ? "selected" : ""}>CLOSED</option></select></div>
        </div>
        <div class="actions"><button type="submit">Save PO</button><a class="btn btn-secondary" href="/po">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/po/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    const update = await client.query(`
      update purchase_orders
      set po_no = $2, vendor_id = $3, status = $4, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $5
    `, [req.params.id, req.body.po_no?.trim(), Number(req.body.vendor_id), req.body.status || "OPEN", req.body.updated_token || ""]);
    if (update.rowCount === 0) throw new Error("This PO was modified by another user. Refresh and try again.");
    await auditLog(client, req.user.id, "update", "purchase_order", req.params.id, req.body.po_no?.trim() || "");
  });
  res.redirect("/po");
});

app.post("/po/:id/delete", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    const po = (await client.query("select rfq_id from purchase_orders where id = $1", [req.params.id])).rows[0];
    await client.query("delete from purchase_orders where id = $1", [req.params.id]);
    if (po?.rfq_id) await recalcRfqStatus(client, po.rfq_id);
    await auditLog(client, req.user.id, "delete", "purchase_order", req.params.id, "");
  });
  res.redirect("/po");
});

app.get("/po-line/:id/edit", requireAuth, async (req, res) => {
  const line = (await query(`
    select pl.id, pl.qty_ordered, pl.unit_price, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2, extract(epoch from pl.updated_at)::text as updated_token,
           mi.item_code, mi.description, po.po_no
    from po_lines pl
    join material_items mi on mi.id = pl.material_item_id
    join purchase_orders po on po.id = pl.po_id
    where pl.id = $1
  `, [req.params.id])).rows[0];
  res.send(layout("Edit PO Line", `
    <h1>Edit PO Line</h1>
    <div class="card"><strong>PO:</strong> ${esc(line.po_no)} | <strong>Item:</strong> ${esc(line.item_code)} - ${esc(line.description)}</div>
    <div class="card">
      <form method="post" action="/po-line/${line.id}/edit" class="stack">
        <input type="hidden" name="updated_token" value="${esc(line.updated_token)}" />
        <div class="grid">
          <div><label>Qty Ordered</label><input name="qty_ordered" value="${esc(line.qty_ordered)}" required /></div>
          <div><label>Unit Price</label><input name="unit_price" value="${esc(line.unit_price)}" required /></div>
          <div><label>Size 1</label><input name="size_1" value="${esc(line.size_1 || "")}" /></div>
          <div><label>Size 2</label><input name="size_2" value="${esc(line.size_2 || "")}" /></div>
          <div><label>Thk 1</label><input name="thk_1" value="${esc(line.thk_1 || "")}" /></div>
          <div><label>Thk 2</label><input name="thk_2" value="${esc(line.thk_2 || "")}" /></div>
        </div>
        <div class="actions"><button type="submit">Save PO Line</button><a class="btn btn-secondary" href="/po">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/po-line/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    const update = await client.query(`
      update po_lines
      set qty_ordered = $2, unit_price = $3, size_1 = $4, size_2 = $5, thk_1 = $6, thk_2 = $7, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $8
    `, [req.params.id, Number(req.body.qty_ordered), Number(req.body.unit_price), req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", req.body.updated_token || ""]);
    if (update.rowCount === 0) throw new Error("This PO line was modified by another user. Refresh and try again.");
    await auditLog(client, req.user.id, "update", "po_line", req.params.id, "");
  });
  res.redirect("/po");
});

app.get("/receive", requireAuth, async (req, res) => {
  const poId = String(req.query.po_id || "").trim();
  const poOptionsRows = (await query("select id, po_no from purchase_orders order by id desc")).rows;
  const poOptions = [`<option value="">All POs</option>`]
    .concat(poOptionsRows.map((row) => `<option value="${row.id}" ${String(row.id) === poId ? "selected" : ""}>${esc(row.po_no)}</option>`))
    .join("");
  const params = [];
  const poFilterSql = poId ? (() => { params.push(Number(poId)); return `and po.id = $${params.length}`; })() : "";
  const openLines = (await query(`
    select pl.id, po.po_no, mi.item_code, mi.description, pl.qty_ordered, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2,
           coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) as qty_received
    from po_lines pl
    join purchase_orders po on po.id = pl.po_id
    join material_items mi on mi.id = pl.material_item_id
    where coalesce((select sum(r.qty_received) from receipts r where r.po_line_id = pl.id), 0) < pl.qty_ordered
    ${poFilterSql}
    order by po.id desc
  `, params)).rows;
  const receiptParams = poId ? [Number(poId)] : [];
  const receiptFilterSql = poId ? "where po.id = $1" : "";
  const receipts = (await query(`
    select r.received_at, po.po_no, mi.item_code, r.qty_received, r.warehouse, r.location, r.osd_status, r.osd_notes,
           pl.size_1, pl.size_2, pl.thk_1, pl.thk_2
    from receipts r
    join po_lines pl on pl.id = r.po_line_id
    join purchase_orders po on po.id = pl.po_id
    join material_items mi on mi.id = pl.material_item_id
    ${receiptFilterSql}
    order by r.id desc
    limit 30
  `, receiptParams)).rows;
  const lineOptions = openLines.map((line) => `<option value="${line.id}">${esc(line.po_no)} | ${esc(line.item_code)} | ${esc(line.size_1 || "")}/${esc(line.size_2 || "")} | ${esc(line.thk_1 || "")}/${esc(line.thk_2 || "")} | Ordered ${esc(line.qty_ordered)} | Rec ${esc(line.qty_received)}</option>`).join("");
  const receiptRows = receipts.map((receipt) => `<tr>
    <td>${esc(receipt.received_at)}</td><td>${esc(receipt.po_no)}</td><td>${esc(receipt.item_code)}</td><td>${esc(receipt.size_1 || "")}</td>
    <td>${esc(receipt.size_2 || "")}</td><td>${esc(receipt.thk_1 || "")}</td><td>${esc(receipt.thk_2 || "")}</td><td>${esc(receipt.qty_received)}</td>
    <td>${esc(receipt.warehouse)}</td><td>${esc(receipt.location)}</td><td>${esc(receipt.osd_status)}</td><td>${esc(receipt.osd_notes || "")}</td>
  </tr>`).join("");
  res.send(layout("Receiving", `
    <h1>Receiving</h1>
    <div class="card">
      <form method="get" action="/receive" class="stack">
        <div class="grid"><div><label>Filter By PO</label><select name="po_id">${poOptions}</select></div></div>
        <div class="actions"><button type="submit">Apply Filter</button><a class="btn btn-secondary" href="/receive">Clear</a></div>
      </form>
    </div>
    <div class="card">
      <form method="post" action="/receive" class="stack">
        <input type="hidden" name="po_id" value="${esc(poId)}" />
        <div><label>PO Line</label><select name="po_line_id">${lineOptions}</select></div>
        <div class="grid">
          <div><label>Qty Received</label><input name="qty_received" required /></div>
          <div><label>Warehouse</label><input name="warehouse" required /></div>
          <div><label>Location</label><input name="location" required /></div>
          <div><label>OS&D Status</label><select name="osd_status"><option>OK</option><option>OVERAGE</option><option>SHORTAGE</option><option>DAMAGE</option></select></div>
        </div>
        <div><label>OS&D Notes</label><textarea name="osd_notes"></textarea></div>
        <div class="actions"><button type="submit">Receive Material</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Received</th><th>PO</th><th>Item</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Qty</th><th>Warehouse</th><th>Location</th><th>OS&D</th><th>Notes</th></tr>${receiptRows}</table></div>
  `, req.user));
});

app.post("/receive", requireAuth, requireRole(["admin", "warehouse"]), async (req, res) => {
  await withTransaction(async (client) => {
    const insert = await client.query(`
      insert into receipts (po_line_id, qty_received, warehouse, location, osd_status, osd_notes)
      values ($1, $2, $3, $4, $5, $6)
      returning id
    `, [Number(req.body.po_line_id), Number(req.body.qty_received), req.body.warehouse?.trim(), req.body.location?.trim(), req.body.osd_status || "OK", req.body.osd_notes || ""]);
    await auditLog(client, req.user.id, "create", "receipt", insert.rows[0].id, `po_line=${req.body.po_line_id}`);
  });
  res.redirect(req.body.po_id ? `/receive?po_id=${encodeURIComponent(req.body.po_id)}` : "/receive");
});

app.get("/inventory", requireAuth, async (req, res) => {
  const rows = (await query(`
    select mi.item_code, mi.description, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2,
           r.warehouse, r.location,
           sum(r.qty_received) as qty_on_hand,
           sum(case when r.osd_status = 'OK' then 0 else r.qty_received end) as qty_osd
    from receipts r
    join po_lines pl on pl.id = r.po_line_id
    join material_items mi on mi.id = pl.material_item_id
    group by mi.item_code, mi.description, pl.size_1, pl.size_2, pl.thk_1, pl.thk_2, r.warehouse, r.location
    order by mi.item_code
  `)).rows;
  const tableRows = rows.map((row) => `<tr>
    <td>${esc(row.item_code)}</td><td>${esc(row.description)}</td><td>${esc(row.size_1 || "")}</td><td>${esc(row.size_2 || "")}</td>
    <td>${esc(row.thk_1 || "")}</td><td>${esc(row.thk_2 || "")}</td><td>${esc(row.warehouse)}</td><td>${esc(row.location)}</td>
    <td>${esc(row.qty_on_hand)}</td><td>${esc(row.qty_osd)}</td>
  </tr>`).join("");
  res.send(layout("Inventory", `
    <h1>Inventory by Location</h1>
    <div class="card scroll"><table><tr><th>Item</th><th>Description</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Warehouse</th><th>Location</th><th>Qty On Hand</th><th>Qty OS&D</th></tr>${tableRows}</table></div>
  `, req.user));
});

app.use((error, req, res, _next) => {
  const user = currentUser(req);
  res.status(400).send(layout("Error", `<div class="card error"><h3>Error</h3><pre>${esc(error.message)}</pre></div>`, user));
});

await initDb();

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Running on http://127.0.0.1:${PORT}`);
  });
}

export default app;
