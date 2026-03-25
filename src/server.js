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
        --bg: #eef3f7;
        --panel: #ffffff;
        --ink: #17324d;
        --muted: #5d6f82;
        --line: #d9e2eb;
        --brand: #0e5a6d;
        --brand-2: #164e63;
        --warn: #b42318;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Georgia, "Palatino Linotype", serif; color: var(--ink); background: linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%); }
      .shell { max-width: 1400px; margin: 0 auto; padding: 24px; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 22px; padding: 14px 18px; background: rgba(255,255,255,.8); border: 1px solid rgba(23,50,77,.08); border-radius: 18px; }
      .brand { font-size: 28px; font-weight: 700; letter-spacing: .02em; }
      .userline { color: var(--muted); font-size: 14px; }
      nav { display: flex; gap: 10px; flex-wrap: wrap; }
      nav a { color: var(--brand); text-decoration: none; font-weight: 700; padding: 8px 10px; border-radius: 10px; }
      nav a:hover { background: rgba(14, 90, 109, .08); }
      .card { background: var(--panel); border: 1px solid rgba(23,50,77,.08); border-radius: 18px; box-shadow: 0 18px 40px rgba(23,50,77,.06); padding: 22px; margin-bottom: 18px; }
      h1, h2, h3 { margin: 0 0 12px; }
      h1 { font-size: 36px; }
      h2 { font-size: 30px; }
      h3 { font-size: 24px; }
      .muted { color: var(--muted); font-size: 14px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
      .stat { padding: 18px; border-radius: 16px; background: linear-gradient(135deg, rgba(14,90,109,.08), rgba(10,80,100,.14)); }
      .stat strong { display: block; font-size: 36px; margin-top: 8px; }
      label { display: block; font-size: 14px; font-weight: 700; margin-bottom: 4px; color: var(--muted); }
      input, select, textarea { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--ink); font: inherit; }
      textarea { min-height: 120px; resize: vertical; }
      button, .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 104px; height: 38px; padding: 0 14px; border-radius: 10px; border: 0; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
      button, .btn-primary { background: var(--brand); color: white; }
      .btn-secondary { background: var(--brand-2); color: white; }
      .btn-danger { background: var(--warn); color: white; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .scroll { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .04em; }
      .chip { display: inline-block; padding: 4px 10px; border-radius: 999px; background: rgba(14,90,109,.08); color: var(--brand); font-weight: 700; }
      .error { border-color: rgba(180,35,24,.22); background: rgba(180,35,24,.06); color: var(--warn); }
      .stack { display: grid; gap: 18px; }
      @media (max-width: 900px) { .grid, .grid-4, .stats { grid-template-columns: 1fr; } .topbar { flex-direction: column; align-items: flex-start; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="topbar">
        <div>
          <div class="brand">Material Control</div>
          ${user ? `<div class="userline">${esc(user.username)} | ${esc(user.role)}</div>` : ""}
        </div>
        ${user ? `<nav><a href="/">Dashboard</a><a href="/vendors">Vendors</a><a href="/rfq">RFQs</a><a href="/po">POs</a><a href="/receive">Receiving</a><a href="/inventory">Inventory</a><a href="/logout">Logout</a></nav>` : ""}
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

function parseUploadedRows(file, pastedText) {
  if (file?.buffer?.length) {
    if ((file.originalname || "").toLowerCase().endsWith(".xlsx")) {
      const workbook = XLSX.read(file.buffer, { type: "buffer" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase(), String(value ?? "").trim()])));
    }
    pastedText = file.buffer.toString("utf8");
  }
  if (!pastedText?.trim()) return [];
  const lines = pastedText.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((cell) => cell.trim().toLowerCase());
  return lines.filter((line) => line.trim()).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "").trim()]));
  });
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
    select count(distinct ri.id)
    from rfq_items ri
    join purchase_orders po on po.rfq_id = ri.rfq_id
    join po_lines pl on pl.po_id = po.id and pl.material_item_id = ri.material_item_id
    where ri.rfq_id = $1
  `, [rfqId])).rows[0].count);
  await client.query("update rfqs set status = $2 where id = $1", [rfqId, total > 0 && issued >= total ? "CLOSED" : "OPEN"]);
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
  const result = await query("select id, username, role, password_hash from users where username = $1", [username.trim()]);
  const user = result.rows[0];
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
  const [rfqs, pos, receipts, vendors, osd] = await Promise.all([
    query("select count(*) from rfqs"),
    query("select count(*) from purchase_orders"),
    query("select count(*) from receipts"),
    query("select count(*) from vendors"),
    query("select count(*) from receipts where osd_status <> 'OK'")
  ]);
  res.send(layout("Dashboard", `
    <h1>Operations Dashboard</h1>
    <div class="stats">
      <div class="stat"><div>RFQs</div><strong>${rfqs.rows[0].count}</strong></div>
      <div class="stat"><div>POs</div><strong>${pos.rows[0].count}</strong></div>
      <div class="stat"><div>Receipts</div><strong>${receipts.rows[0].count}</strong></div>
      <div class="stat"><div>OS&D Cases</div><strong>${osd.rows[0].count}</strong></div>
    </div>
  `, req.user));
});

app.get("/vendors", requireAuth, async (req, res) => {
  const vendors = (await query("select * from vendors order by name")).rows;
  const checks = vendorCategories.map((category) => `<label><input type="checkbox" name="categories" value="${esc(category)}" /> ${esc(category)}</label>`).join("");
  const rows = vendors.map((vendor) => `<tr>
    <td>${esc(vendor.name)}</td>
    <td>${esc(vendor.email || "")}</td>
    <td>${esc(vendor.phone || "")}</td>
    <td>${esc((vendor.categories || "").split(",").filter(Boolean).join(", "))}</td>
    <td><a class="btn btn-secondary" href="/vendors/${vendor.id}/edit">Edit</a></td>
  </tr>`).join("");
  res.send(layout("Vendors", `
    <h1>Vendors</h1>
    <div class="card">
      <form method="post" action="/vendors/add" class="stack">
        <div class="grid">
          <div><label>Name</label><input name="name" required /></div>
          <div><label>Email</label><input name="email" /></div>
          <div><label>Phone</label><input name="phone" /></div>
        </div>
        <div><label>Categories</label><div class="grid-4">${checks}</div></div>
        <div class="actions"><button type="submit">Add Vendor</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Categories</th><th>Action</th></tr>${rows}</table></div>
  `, req.user));
});

app.post("/vendors/add", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    const result = await client.query(
      "insert into vendors (name, email, phone, categories) values ($1, $2, $3, $4) returning id",
      [req.body.name?.trim(), req.body.email?.trim() || "", req.body.phone?.trim() || "", normalizeCategories(req.body.categories)]
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
  const checks = vendorCategories.map((category) => `<label><input type="checkbox" name="categories" value="${esc(category)}" ${selected.has(category) ? "checked" : ""}/> ${esc(category)}</label>`).join("");
  res.send(layout("Edit Vendor", `
    <h1>Edit Vendor</h1>
    <div class="card">
      <form method="post" action="/vendors/${vendor.id}/edit" class="stack">
        <div class="grid">
          <div><label>Name</label><input name="name" value="${esc(vendor.name)}" required /></div>
          <div><label>Email</label><input name="email" value="${esc(vendor.email || "")}" /></div>
          <div><label>Phone</label><input name="phone" value="${esc(vendor.phone || "")}" /></div>
        </div>
        <div><label>Categories</label><div class="grid-4">${checks}</div></div>
        <div class="actions"><button type="submit">Save Vendor</button><a class="btn btn-secondary" href="/vendors">Back</a></div>
      </form>
    </div>
  `, req.user));
});

app.post("/vendors/:id/edit", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    await client.query(
      "update vendors set name = $2, email = $3, phone = $4, categories = $5 where id = $1",
      [req.params.id, req.body.name?.trim(), req.body.email?.trim() || "", req.body.phone?.trim() || "", normalizeCategories(req.body.categories)]
    );
    await auditLog(client, req.user.id, "update", "vendor", req.params.id, req.body.name?.trim() || "");
  });
  res.redirect("/vendors");
});

app.get("/rfq", requireAuth, async (req, res) => {
  const rfqs = (await query("select * from rfqs order by id desc")).rows;
  const rows = rfqs.map((rfq) => `<tr>
    <td><a href="/rfq/${rfq.id}">${esc(rfq.rfq_no)}</a></td>
    <td>${esc(rfq.project_name)}</td>
    <td>${esc(rfq.due_date || "")}</td>
    <td><span class="chip">${esc(rfq.status)}</span></td>
  </tr>`).join("");
  res.send(layout("RFQs", `
    <h1>RFQs</h1>
    <div class="card">
      <form method="post" action="/rfq" class="stack">
        <div class="grid">
          <div><label>RFQ Number</label><input name="rfq_no" required /></div>
          <div><label>Project</label><input name="project_name" required /></div>
          <div><label>Due Date</label><input type="date" name="due_date" /></div>
        </div>
        <div class="actions"><button type="submit">Create RFQ</button></div>
      </form>
    </div>
    <div class="card scroll"><table><tr><th>RFQ</th><th>Project</th><th>Due</th><th>Status</th></tr>${rows}</table></div>
  `, req.user));
});

app.post("/rfq", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const id = await withTransaction(async (client) => {
    const insert = await client.query(
      "insert into rfqs (rfq_no, project_name, due_date, status) values ($1, $2, $3, 'OPEN') returning id",
      [req.body.rfq_no?.trim(), req.body.project_name?.trim(), req.body.due_date || null]
    );
    await auditLog(client, req.user.id, "create", "rfq", insert.rows[0].id, req.body.rfq_no?.trim() || "");
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
  const [itemsRes, vendorsRes, quoteVendorsRes, poCountRes] = await Promise.all([
    query(`
      select ri.id, ri.qty, ri.notes, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.updated_at,
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
    query("select count(*) from purchase_orders where rfq_id = $1", [rfqId])
  ]);

  const items = itemsRes.rows;
  const vendors = vendorsRes.rows;
  const quoteVendors = quoteVendorsRes.rows;
  const poCount = Number(poCountRes.rows[0].count);

  const itemRows = [];
  for (const item of items) {
    const [quotesRes, poRefsRes] = await Promise.all([
      query("select vendor_id, unit_price, lead_days from quotes where rfq_item_id = $1", [item.id]),
      query(`
        select distinct po.po_no
        from purchase_orders po
        join po_lines pl on pl.po_id = po.id
        join rfq_items ri on ri.rfq_id = po.rfq_id
        where ri.id = $1 and pl.material_item_id = ri.material_item_id
        order by po.po_no
      `, [item.id])
    ]);
    const qMap = new Map(quotesRes.rows.map((row) => [row.vendor_id, `$${Number(row.unit_price).toFixed(2)} | ${row.lead_days}d`]));
    const vendorCells = quoteVendors.map((vendor) => `<td>${esc(qMap.get(vendor.id) || "-")}</td>`).join("");
    const poRefs = poRefsRes.rows.map((row) => row.po_no).join(", ") || "Not Issued";
    itemRows.push(`<tr>
      <td>${esc(item.item_code)}</td>
      <td>${esc(item.description)}</td>
      <td>${esc(item.material_type)}</td>
      <td>${esc(item.qty)}</td>
      <td>${esc(item.uom)}</td>
      <td>${esc(item.size_1 || "")}</td>
      <td>${esc(item.size_2 || "")}</td>
      <td>${esc(item.thk_1 || "")}</td>
      <td>${esc(item.thk_2 || "")}</td>
      <td>${esc(item.notes || "")}</td>
      ${vendorCells}
      <td>${esc(poRefs)}</td>
      <td><div class="actions">
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/quotes">Quotes</a>
        <a class="btn btn-secondary" href="/rfq-item/${item.id}/edit">Edit</a>
        <form method="post" action="/rfq-item/${item.id}/delete"><button class="btn btn-danger" type="submit">Delete</button></form>
      </div></td>
    </tr>`);
  }

  const vendorOptions = vendors.map((vendor) => `<option value="${vendor.id}">${esc(vendor.name)}</option>`).join("");
  const vendorHeaders = quoteVendors.map((vendor) => `<th>${esc(vendor.name)}</th>`).join("");
  const uploadItemsCard = `
    <div class="card">
      <h3>Upload RFQ Items</h3>
      <p class="muted">CSV/XLSX columns: item_code, description, material_type, uom, size_1, size_2, thk_1, thk_2, qty, notes</p>
      <form method="post" enctype="multipart/form-data" action="/rfq/${rfqId}/items/import" class="stack">
        <div><label>CSV/XLSX File</label><input type="file" name="sheet" /></div>
        <div><label>Or Paste CSV</label><textarea name="csv_text"></textarea></div>
        <div class="actions"><button type="submit">Import Items</button></div>
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
      <h3>Issue PO From This RFQ</h3>
      <form method="post" action="/po/create" class="stack">
        <input type="hidden" name="rfq_id" value="${rfqId}" />
        <div class="grid">
          <div><label>PO Number</label><input name="po_no" required /></div>
          <div><label>Vendor</label><select name="vendor_id">${vendorOptions}</select></div>
        </div>
        <div class="actions"><button type="submit">Create PO Using Vendor Quotes</button></div>
      </form>
    </div>`;

  res.send(layout(`RFQ ${rfq.rfq_no}`, `
    <h1>RFQ ${esc(rfq.rfq_no)}</h1>
    ${items.length === 0 && poCount === 0 ? uploadItemsCard : ""}
    ${poCount === 0 ? importQuotesCard : ""}
    ${poCount === 0 ? issuePoCard : ""}
    <div class="card scroll">
      <h3>RFQ Items</h3>
      <table>
        <tr><th>Item</th><th>Description</th><th>Type</th><th>Qty</th><th>UOM</th><th>Size 1</th><th>Size 2</th><th>Thk 1</th><th>Thk 2</th><th>Notes</th>${vendorHeaders}<th>Issued PO</th><th>Actions</th></tr>
        ${itemRows.join("")}
      </table>
    </div>
    ${items.length > 0 && poCount === 0 ? uploadItemsCard : ""}
  `, req.user));
});

app.post("/rfq/:id/items/import", requireAuth, requireRole(["admin", "buyer"]), upload.single("sheet"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  await withTransaction(async (client) => {
    for (const row of rows) {
      const itemCode = String(row.item_code || "").trim();
      const qty = Number(row.qty || 0);
      if (!itemCode || qty <= 0) continue;
      let materialItemId;
      const existing = await client.query("select id from material_items where item_code = $1", [itemCode]);
      if (existing.rows[0]) {
        materialItemId = existing.rows[0].id;
      } else {
        const insert = await client.query(
          "insert into material_items (item_code, description, material_type, uom) values ($1, $2, $3, $4) returning id",
          [itemCode, row.description || itemCode, row.material_type || "misc", row.uom || "EA"]
        );
        materialItemId = insert.rows[0].id;
      }
      await client.query(`
        insert into rfq_items (rfq_id, material_item_id, size_1, size_2, thk_1, thk_2, qty, notes, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, now())
      `, [rfqId, materialItemId, row.size_1 || "", row.size_2 || "", row.thk_1 || "", row.thk_2 || "", qty, row.notes || ""]);
    }
    await auditLog(client, req.user.id, "import", "rfq_items", rfqId, `rows=${rows.length}`);
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/rfq/:id/quotes/import", requireAuth, requireRole(["admin", "buyer"]), upload.single("sheet"), async (req, res) => {
  const rfqId = Number(req.params.id);
  const rows = parseUploadedRows(req.file, req.body.csv_text);
  if (rows.length === 0) throw new Error("No rows found.");
  await withTransaction(async (client) => {
    for (const row of rows) {
      const vendorName = String(row.vendor_name || "").trim();
      const itemCode = String(row.item_code || "").trim();
      if (!vendorName || !itemCode || !row.unit_price) continue;
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
      if (!rfqItemRes.rows[0]) continue;
      await client.query(`
        insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
        values ($1, $2, $3, $4, now())
        on conflict (rfq_item_id, vendor_id)
        do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
      `, [rfqItemRes.rows[0].id, vendorId, Number(row.unit_price), Number(row.lead_days || 0)]);
    }
    await auditLog(client, req.user.id, "import", "quotes", rfqId, `rows=${rows.length}`);
  });
  res.redirect(`/rfq/${rfqId}`);
});

app.post("/po/create", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  const rfqId = Number(req.body.rfq_id);
  const vendorId = Number(req.body.vendor_id);
  const poNo = String(req.body.po_no || "").trim();
  await withTransaction(async (client) => {
    const poInsert = await client.query(
      "insert into purchase_orders (po_no, vendor_id, rfq_id, status, updated_at) values ($1, $2, $3, 'OPEN', now()) returning id",
      [poNo, vendorId, rfqId]
    );
    const poId = poInsert.rows[0].id;
    const lines = await client.query(`
      select ri.material_item_id, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, ri.qty, q.unit_price
      from rfq_items ri
      join quotes q on q.rfq_item_id = ri.id
      where ri.rfq_id = $1 and q.vendor_id = $2
    `, [rfqId, vendorId]);
    if (lines.rows.length === 0) throw new Error("Selected vendor has no quoted lines on this RFQ.");
    for (const line of lines.rows) {
      await client.query(`
        insert into po_lines (po_id, material_item_id, size_1, size_2, thk_1, thk_2, qty_ordered, unit_price, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, now())
      `, [poId, line.material_item_id, line.size_1 || "", line.size_2 || "", line.thk_1 || "", line.thk_2 || "", line.qty, line.unit_price]);
    }
    await recalcRfqStatus(client, rfqId);
    await auditLog(client, req.user.id, "create", "purchase_order", poId, poNo);
  });
  res.redirect("/po");
});

app.get("/rfq-item/:id/edit", requireAuth, async (req, res) => {
  const item = (await query(`
    select ri.id, ri.rfq_id, ri.qty, ri.notes, ri.size_1, ri.size_2, ri.thk_1, ri.thk_2, extract(epoch from ri.updated_at)::text as updated_token,
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
      set size_1 = $2, size_2 = $3, thk_1 = $4, thk_2 = $5, qty = $6, notes = $7, updated_at = now()
      where id = $1 and extract(epoch from updated_at)::text = $8
    `, [itemId, req.body.size_1 || "", req.body.size_2 || "", req.body.thk_1 || "", req.body.thk_2 || "", Number(req.body.qty || 0), req.body.notes || "", req.body.updated_token || ""]);
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
    select ri.id, ri.rfq_id, mi.item_code, mi.description
    from rfq_items ri
    join material_items mi on mi.id = ri.material_item_id
    where ri.id = $1
  `, [req.params.id])).rows[0];
  const vendors = (await query("select id, name from vendors order by name")).rows;
  const quotes = (await query(`
    select v.name as vendor_name, q.unit_price, q.lead_days, q.quoted_at
    from quotes q
    join vendors v on v.id = q.vendor_id
    where q.rfq_item_id = $1
    order by q.unit_price, q.lead_days
  `, [req.params.id])).rows;
  const vendorOptions = vendors.map((vendor) => `<option value="${vendor.id}">${esc(vendor.name)}</option>`).join("");
  const quoteRows = quotes.length > 0
    ? quotes.map((quote) => `<tr><td>${esc(quote.vendor_name)}</td><td>$${Number(quote.unit_price).toFixed(2)}</td><td>${quote.lead_days} days</td><td>${esc(quote.quoted_at)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">No quotes yet</td></tr>`;
  res.send(layout("Manage Quotes", `
    <h1>Manage Quotes</h1>
    <div class="card"><strong>${esc(item.item_code)}</strong> | ${esc(item.description)}</div>
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
    <div class="card scroll"><table><tr><th>Vendor</th><th>Unit Price</th><th>Lead</th><th>Updated</th></tr>${quoteRows}</table></div>
  `, req.user));
});

app.post("/quotes", requireAuth, requireRole(["admin", "buyer"]), async (req, res) => {
  await withTransaction(async (client) => {
    await client.query(`
      insert into quotes (rfq_item_id, vendor_id, unit_price, lead_days, quoted_at)
      values ($1, $2, $3, $4, now())
      on conflict (rfq_item_id, vendor_id)
      do update set unit_price = excluded.unit_price, lead_days = excluded.lead_days, quoted_at = now()
    `, [Number(req.body.rfq_item_id), Number(req.body.vendor_id), Number(req.body.unit_price), Number(req.body.lead_days || 0)]);
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
