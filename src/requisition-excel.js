import XLSX from "xlsx";

export const importHeaders = ["Request Group", "Ident", "Quantity", "Requested By", "Issued To", "IWP", "Notes"];
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

export function parseRequisitionWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets["Import"];
  if (!sheet) throw invalid('Use the blank template and keep the "Import" sheet.');
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const legacy = grid[0]?.[1] === "BOM Line ID";
  if (importHeaders.some((h, i) => grid[0]?.[i] !== h && !(i === 1 && legacy))) throw invalid("Import column headers must match the blank template.");
  const groups = new Map();
  for (let i = 1; i < grid.length; i++) {
    if (!grid[i].some(v => String(v).trim())) continue;
    const [key, line, quantity, requestedBy, issuedTo, iwp, notes] = grid[i].map(v => String(v).trim());
    const lineId = legacy && /^[1-9]\d*$/.test(line) ? Number(line) : null;
    const qty = Number(quantity);
    for (const [label, value] of [["Request Group", key], ["Ident", line], ["Requested By", requestedBy], ["Issued To", issuedTo]]) {
      if (!value) throw invalid(`Row ${i + 1}: ${label} is required.`);
    }
    if (!Number.isFinite(qty) || qty <= 0 || Math.abs(qty * 10000 - Math.round(qty * 10000)) > 0.00001) throw invalid(`Row ${i + 1}: Quantity must be positive with up to four decimals.`);
    const metadata = [requestedBy, issuedTo, iwp, notes];
    if (!groups.has(key)) groups.set(key, { key, metadata, lines: [] });
    const group = groups.get(key);
    if (JSON.stringify(group.metadata) !== JSON.stringify(metadata)) throw invalid(`Row ${i + 1}: request details must match other rows in group ${key}.`);
    if (group.lines.some(l => l.reference === line)) throw invalid(`Row ${i + 1}: duplicate ident or BOM line ${line} in group ${key}.`);
    group.lines.push({ lineId, reference: line, qty, rowNumber: i + 1 });
  }
  if (!groups.size) throw invalid("The Import sheet has no request lines.");
  return [...groups.values()];
}

function renderImportReview(review, buffer, bomId, esc) {
  return `
    <h1>Review Excel Import</h1>
    <div class="card"><p>BOM: ${esc(review.bom.bom_name || review.bom.bom_no)} | Delivery Location: ${esc(review.location.name)}</p>
      <p>Review all lines before saving. Overages appear in red. Reduce quantities or enter zero to omit a line. Availability is checked against the combined quantities across this import.</p>
      ${review.rows.some(row => row.overage > 0) ? '<p role="alert" style="color:#b42318;font-weight:bold;">Some quantities exceed available inventory. Adjust them and review again before saving.</p>' : ""}
      <form method="post" action="/requisitions/excel/import" enctype="multipart/form-data" class="stack">
        <input type="hidden" name="workbook" value="${esc(buffer.toString("base64"))}" />
        <input type="hidden" name="bom_id" value="${bomId}" />
        <input type="hidden" name="delivery_location_id" value="${review.location.id}" />
        ${parseRequisitionWorkbook(buffer).flatMap(group => group.lines).filter(line => !review.rows.some(row => row.rowNumber === line.rowNumber)).map(line => `<input type="hidden" name="qty_${line.rowNumber}" value="0" />`).join("")}
        <div class="scroll"><table><tr><th>Group</th><th>Ident</th><th>Description</th><th>Requested Qty</th><th>Available Qty</th><th>Overage Qty</th></tr>
          ${review.rows.map(row => `<tr><td>${esc(row.group)}</td><td>${esc(row.line.item_code)}</td><td>${esc(row.line.description || "")}</td><td><input aria-label="Quantity for ${esc(row.line.item_code)} in group ${esc(row.group)}" name="qty_${row.rowNumber}" type="number" min="0" step="0.0001" value="${row.qty}" required style="min-width:100px;${row.overage > 0 ? "color:#b42318;font-weight:bold;" : ""}" /></td><td>${row.availableQty}</td><td style="${row.overage > 0 ? "color:#b42318;font-weight:bold;" : ""}">${row.overage}</td></tr>`).join("")}
        </table></div>
        <div class="actions"><button type="submit" name="confirm" value="review">Update Review</button><button type="submit" name="confirm" value="save">Save Requests</button><a class="btn btn-secondary" href="/requisitions/excel">Cancel</a></div>
      </form>
    </div>`;
}

export function registerRequisitionExcelRoutes(app, d) {
  const { query, withTransaction, requireAuth, requireJobContext, requirePermission, asyncHandler, currentJobId, layout, esc, canAccess, upload } = d;
  const access = [requireAuth, requireJobContext, requirePermission("requisitions", "view")];
  function download(res, sheets, filename) {
    const book = XLSX.utils.book_new();
    for (const [name, rows] of sheets) {
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = rows[0].map(h => ({ wch: Math.max(16, String(h).length + 2) }));
      XLSX.utils.book_append_sheet(book, sheet, name);
    }
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(filename).send(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  }
  app.get("/requisitions/excel", ...access, asyncHandler(async (req, res) => {
    const jobId = currentJobId(req);
    const boms = (await query("select id,bom_no,bom_name from bom_headers where job_id=$1 and coalesce(system_key,'')='' order by bom_no", [jobId])).rows;
    const locations = (await query("select id,name from delivery_locations where job_id=$1 and is_active=true order by name", [jobId])).rows;
    const filters = new URLSearchParams({ description: String(req.query.description || ""), status: String(req.query.status || "") });
    res.send(layout("Requisition Excel Import / Export", `
      <h1>Requisition Excel Import / Export</h1>
      <div class="card"><div class="actions"><a class="btn btn-secondary" href="/requisitions?${esc(filters.toString())}">Back to Requisitions</a><a class="btn btn-primary" href="/requisitions/excel/export.xlsx?${esc(filters.toString())}">Export Table (.xlsx)</a><a class="btn btn-secondary" href="/requisitions/excel/template.xlsx">Download Blank Import (.xlsx)</a></div><p class="muted">Export uses the request table's current filters and includes all matching requests.</p></div>
      ${req.query.imported ? `<div class="card success">Imported ${esc(req.query.imported)} request(s).</div>` : ""}
      ${canAccess(req.user, "requisitions", "create") ? `<div class="card"><h3>Import Requests</h3><p>Choose a BOM and delivery location. Enter item idents (for example, 102B2) in the Ident column, with one row per item. Use the same Request Group for lines belonging to one request. The BOM Lines sheet lists idents for reference. Older templates with a BOM Line ID heading also accept idents; numeric values under that heading remain database line IDs. Each group creates a new request with an automatically assigned number; acceptance and issuing follow the normal workflow.</p>
      <form method="post" action="/requisitions/excel/import" enctype="multipart/form-data" class="stack">
        <div class="grid"><div><label>BOM</label><select name="bom_id" required><option value="">Choose BOM</option>${boms.map(b => `<option value="${b.id}">${esc(b.bom_name || b.bom_no)} (${esc(b.bom_no)})</option>`).join("")}</select></div><div><label>Delivery Location</label><select name="delivery_location_id" required><option value="">Choose location</option>${locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select></div></div>
        <div><label>Excel File</label><input type="file" name="sheet" accept=".xlsx" required /></div><p class="muted">Review quantities and availability before saving. Overages appear in red. Uploading the same file again creates additional requests.</p><div class="actions"><button type="submit">Review Import</button></div>
      </form></div>` : ""}
    `, req.user));
  }));
  app.get("/requisitions/excel/template.xlsx", ...access, asyncHandler(async (req, res) => {
    const rows = (await query(`select bl.id,bh.bom_no,bl.line_no,bl.item_code,bl.description,bl.uom from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=$1 and coalesce(bh.system_key,'')='' order by bh.bom_no,bl.id`, [currentJobId(req)])).rows;
    download(res, [["Import", [importHeaders]], ["BOM Lines", [["BOM Line ID", "BOM", "Line", "Ident", "Description", "UOM"], ...rows.map(r => [r.id,r.bom_no,r.line_no,r.item_code,r.description,r.uom])]]], "requisition-import-template.xlsx");
  }));
  app.post("/requisitions/excel/import", ...access, requirePermission("requisitions", "create"), upload.single("sheet"), asyncHandler(async (req, res) => {
    if (!req.file && !req.body.workbook) throw invalid("Choose an .xlsx import file.");
    if (req.file && !/\.xlsx$/i.test(req.file.originalname)) throw invalid("Choose an .xlsx import file.");
    const buffer = req.file ? req.file.buffer : Buffer.from(String(req.body.workbook), "base64");
    const groups = parseRequisitionWorkbook(buffer);
    if (!req.file) {
      for (const group of groups) {
        for (const line of group.lines) {
          const raw = String(req.body["qty_" + line.rowNumber] ?? "").trim();
          const qty = Number(raw);
          if (!raw || !Number.isFinite(qty) || qty < 0 || Math.abs(qty * 10000 - Math.round(qty * 10000)) > 0.00001) throw invalid("Enter quantities of zero or more, with up to four decimals.");
          line.qty = qty;
        }
        group.lines = group.lines.filter(line => line.qty > 0);
      }
    }
    const activeGroups = groups.filter(group => group.lines.length);
    if (!activeGroups.length) throw invalid("Keep at least one request line with a positive quantity.");
    const jobId = currentJobId(req), bomId = Number(req.body.bom_id);
    const review = await withTransaction(async client => {
      const bom = (await client.query("select * from bom_headers where id=$1 and job_id=$2 and coalesce(system_key,'')='' for share", [bomId, jobId])).rows[0];
      if (!bom) throw invalid("Choose a regular BOM in the current job.");
      const location = await d.getDeliveryLocation(client, jobId, req.body.delivery_location_id, { lock: true });
      const available = await d.getAvailableInventoryByItemMap(client, jobId);
      const reviewRows = [];
      const totals = new Map();
      for (const group of activeGroups) {
        const resolvedIds = new Set();
        for (const { lineId, reference, qty, rowNumber } of group.lines) {
          const matches = (await client.query(lineId !== null
            ? "select * from bom_lines where id=$1 and bom_id=$2"
            : "select * from bom_lines where item_code=$1 and bom_id=$2", [lineId ?? reference,bomId])).rows;
          if (!matches.length) throw invalid(`Row ${rowNumber}: ${lineId !== null ? "BOM Line ID" : "Ident"} ${reference} is not in the selected BOM.`);
          if (matches.length > 1) throw invalid(`Row ${rowNumber}: Ident ${reference} matches multiple lines in the selected BOM. Use the numeric BOM Line ID from the reference sheet under a BOM Line ID heading to select the exact line.`);
          const line = matches[0];
          if (resolvedIds.has(String(line.id))) throw invalid(`Row ${rowNumber}: duplicate BOM line for ${reference} in group ${group.key}.`);
          resolvedIds.add(String(line.id));
          const itemKey = d.buildInventoryItemKey(line);
          const total = (totals.get(itemKey) || 0) + qty;
          totals.set(itemKey, total);
          const availableQty = Math.max(0, Number(available.get(itemKey) || 0));
          const overage = Math.max(0, Math.round((total - availableQty) * 10000) / 10000);
          reviewRows.push({ group: group.key, rowNumber, line, qty, availableQty, overage });
        }
      }
      if (req.file || req.body.confirm !== "save" || reviewRows.some(row => row.overage > 0)) return { rows: reviewRows, bom, location };
      for (const group of activeGroups) {
        const number = await d.nextDeliveryRequestNumber(client, jobId, location);
        const [requestedBy, issuedTo, iwp, notes] = group.metadata;
        const header = (await client.query(`insert into material_requisitions(job_id,requisition_no,bom_id,requested_by_user_id,requested_by_name,issued_to,iwp_no,notes,status,delivery_location_id,delivery_location_name,request_prefix,created_by_user_id,created_by_name) values($1,$2,$3,$4,$5,$6,$7,$8,'REQUESTED',$9,$10,$11,$4,$12) returning id`, [jobId,number,bomId,req.user.id,requestedBy,issuedTo,iwp,notes,location.id,location.name,location.request_prefix,d.getUserDisplayName(req.user)])).rows[0];
        for (const row of reviewRows.filter(row => row.group === group.key)) {
          await client.query("insert into material_requisition_lines(job_id,requisition_id,bom_line_id,qty_requested) values($1,$2,$3,$4)", [jobId,header.id,row.line.id,row.qty]);
        }
        if ((await d.getRequisitionMaterialShortages(client, header.id, jobId)).length) await client.query("update material_requisitions set status='WAITING_ON_MATERIAL' where id=$1 and job_id=$2", [header.id,jobId]);
        await d.auditLog(client, req.user.id, "create", "material_requisition", header.id, `Excel import: ${number}`);
      }
    });
    if (review) return res.send(layout("Review Excel Import", renderImportReview(review, buffer, bomId, esc), req.user));
    res.redirect(`/requisitions/excel?imported=${activeGroups.length}`);
  }));
  return { download };
}
