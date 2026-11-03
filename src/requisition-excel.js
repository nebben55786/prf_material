import XLSX from "xlsx";

export const importHeaders = ["Request Group", "BOM Line ID", "Quantity", "Requested By", "Issued To", "IWP", "Notes"];
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

export function parseRequisitionWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets["Import"];
  if (!sheet) throw invalid('Use the blank template and keep the "Import" sheet.');
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (importHeaders.some((h, i) => grid[0]?.[i] !== h)) throw invalid("Import column headers must match the blank template.");
  const groups = new Map();
  for (let i = 1; i < grid.length; i++) {
    if (!grid[i].some(v => String(v).trim())) continue;
    const [key, line, quantity, requestedBy, issuedTo, iwp, notes] = grid[i].map(v => String(v).trim());
    const lineId = Number(line), qty = Number(quantity);
    if (!key || !requestedBy || !issuedTo || !Number.isSafeInteger(lineId) || lineId <= 0 || !Number.isFinite(qty) || qty <= 0 || Math.abs(qty * 10000 - Math.round(qty * 10000)) > 0.00001) throw invalid(`Row ${i + 1}: enter a request group, BOM Line ID, positive quantity (up to four decimals), Requested By and Issued To.`);
    const metadata = [requestedBy, issuedTo, iwp, notes];
    if (!groups.has(key)) groups.set(key, { key, metadata, lines: [] });
    const group = groups.get(key);
    if (JSON.stringify(group.metadata) !== JSON.stringify(metadata)) throw invalid(`Row ${i + 1}: request details must match other rows in group ${key}.`);
    if (group.lines.some(l => l.lineId === lineId)) throw invalid(`Row ${i + 1}: duplicate BOM line in group ${key}.`);
    group.lines.push({ lineId, qty });
  }
  if (!groups.size) throw invalid("The Import sheet has no request lines.");
  return [...groups.values()];
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
      ${canAccess(req.user, "requisitions", "create") ? `<div class="card"><h3>Import Requests</h3><p>Choose a BOM and delivery location. Fill the template with one row per BOM line. Use the same Request Group for lines belonging to one request. Find BOM Line IDs on the template's BOM Lines sheet. Each group creates a new request with an automatically assigned number; acceptance and issuing follow the normal workflow.</p>
      <form method="post" action="/requisitions/excel/import" enctype="multipart/form-data" class="stack">
        <div class="grid"><div><label>BOM</label><select name="bom_id" required><option value="">Choose BOM</option>${boms.map(b => `<option value="${b.id}">${esc(b.bom_name || b.bom_no)} (${esc(b.bom_no)})</option>`).join("")}</select></div><div><label>Delivery Location</label><select name="delivery_location_id" required><option value="">Choose location</option>${locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select></div></div>
        <div><label>Excel File</label><input type="file" name="sheet" accept=".xlsx" required /></div><p class="muted">All rows are validated together. If any row fails, no requests are saved. Uploading the same file again creates additional requests.</p><div class="actions"><button type="submit">Import Requests</button></div>
      </form></div>` : ""}
    `, req.user));
  }));
  app.get("/requisitions/excel/template.xlsx", ...access, asyncHandler(async (req, res) => {
    const rows = (await query(`select bl.id,bh.bom_no,bl.line_no,bl.item_code,bl.description,bl.uom from bom_lines bl join bom_headers bh on bh.id=bl.bom_id where bh.job_id=$1 and coalesce(bh.system_key,'')='' order by bh.bom_no,bl.id`, [currentJobId(req)])).rows;
    download(res, [["Import", [importHeaders]], ["BOM Lines", [["BOM Line ID", "BOM", "Line", "Ident", "Description", "UOM"], ...rows.map(r => [r.id,r.bom_no,r.line_no,r.item_code,r.description,r.uom])]]], "requisition-import-template.xlsx");
  }));
  app.post("/requisitions/excel/import", ...access, requirePermission("requisitions", "create"), upload.single("sheet"), asyncHandler(async (req, res) => {
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw invalid("Choose an .xlsx import file.");
    const groups = parseRequisitionWorkbook(req.file.buffer);
    const jobId = currentJobId(req), bomId = Number(req.body.bom_id);
    await withTransaction(async client => {
      const bom = (await client.query("select * from bom_headers where id=$1 and job_id=$2 and coalesce(system_key,'')='' for share", [bomId, jobId])).rows[0];
      if (!bom) throw invalid("Choose a regular BOM in the current job.");
      const location = await d.getDeliveryLocation(client, jobId, req.body.delivery_location_id, { lock: true });
      const available = await d.getAvailableInventoryByItemMap(client, jobId);
      for (const group of groups) {
        const number = await d.nextDeliveryRequestNumber(client, jobId, location);
        const [requestedBy, issuedTo, iwp, notes] = group.metadata;
        const header = (await client.query(`insert into material_requisitions(job_id,requisition_no,bom_id,requested_by_user_id,requested_by_name,issued_to,iwp_no,notes,status,delivery_location_id,delivery_location_name,request_prefix,created_by_user_id,created_by_name) values($1,$2,$3,$4,$5,$6,$7,$8,'REQUESTED',$9,$10,$11,$4,$12) returning id`, [jobId,number,bomId,req.user.id,requestedBy,issuedTo,iwp,notes,location.id,location.name,location.request_prefix,d.getUserDisplayName(req.user)])).rows[0];
        for (const { lineId, qty } of group.lines) {
          const line = (await client.query("select * from bom_lines where id=$1 and bom_id=$2", [lineId,bomId])).rows[0];
          if (!line) throw invalid(`Group ${group.key}: BOM Line ID ${lineId} is not in the selected BOM.`);
          if (qty > Number(available.get(d.buildInventoryItemKey(line)) || 0)) throw invalid(`Group ${group.key}: quantity for ${line.item_code} exceeds available inventory.`);
          await client.query("insert into material_requisition_lines(job_id,requisition_id,bom_line_id,qty_requested) values($1,$2,$3,$4)", [jobId,header.id,lineId,qty]);
        }
        if ((await d.getRequisitionMaterialShortages(client, header.id, jobId)).length) await client.query("update material_requisitions set status='WAITING_ON_MATERIAL' where id=$1 and job_id=$2", [header.id,jobId]);
        await d.auditLog(client, req.user.id, "create", "material_requisition", header.id, `Excel import: ${number}`);
      }
    });
    res.redirect(`/requisitions/excel?imported=${groups.length}`);
  }));
  return { download };
}
