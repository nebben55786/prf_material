// Original request lines own demand; only posted issue transactions reduce reservations.
function loadError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
const outstandingReservationSql = `greatest(mrl.qty_requested - coalesce((select sum(reserved_issue.qty_issued) from material_issue_transactions reserved_issue where reserved_issue.requisition_line_id=mrl.id),0),0)`;
async function hasRequisitionLoads(db, id, jobId) {
  return (await db.query("select 1 from material_requisition_loads where requisition_id=$1 and job_id=$2 limit 1", [id, jobId])).rows.length > 0;
}
async function assertNoRequisitionLoads(db, id, jobId) {
  if (await hasRequisitionLoads(db, id, jobId)) throw loadError("This request has split loads. Use the individual loads for loading, pick tickets, issuing and sign-off.");
}
async function getLoadLines(db, id) {
  return (await db.query(`select ll.*, coalesce((select sum(t.qty_issued) from material_issue_transactions t where t.load_id=ll.load_id and t.requisition_line_id=ll.requisition_line_id),0) as issued_qty, mrl.bom_line_id, bl.line_no, bl.item_code, bl.description, bl.uom, bl.size_1, bl.size_2, bl.thk_1, bl.thk_2, coalesce(bh.system_key,'') as system_key
    from material_requisition_load_lines ll join material_requisition_lines mrl on mrl.id=ll.requisition_line_id join bom_lines bl on bl.id=mrl.bom_line_id join bom_headers bh on bh.id=bl.bom_id where ll.load_id=$1 order by bl.line_no,bl.id`, [id])).rows;
}
async function createRequisitionLoad(db, { id, jobId, userId, trailer, body }) {
  const header = (await db.query("select * from material_requisitions where id=$1 and job_id=$2 for update", [id, jobId])).rows[0];
  if (!header || !["ACCEPTED", "VERIFIED", "FLAGGED", "LOADED"].includes(header.status)) throw loadError("Accept this request before creating loads.");
  trailer = String(trailer || "").trim();
  if (!trailer || trailer.length > 120) throw loadError("Enter a trailer number (maximum 120 characters).");
  if ((await db.query("select 1 from material_issue_transactions where requisition_id=$1 and job_id=$2 and load_id is null limit 1", [id, jobId])).rows.length) throw loadError("This request already has an issue outside split loads.");
  const lines = (await db.query(`select mrl.*,coalesce((select sum(ll.qty) from material_requisition_load_lines ll join material_requisition_loads l on l.id=ll.load_id where ll.requisition_line_id=mrl.id and l.status<>'CANCELLED'),0) as assigned from material_requisition_lines mrl where requisition_id=$1 and job_id=$2 order by id`, [id, jobId])).rows;
  const selected = [];
  for (const line of lines) {
    const raw = String(body["qty_" + line.id] ?? "").trim();
    const qty = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(qty) || qty < 0 || Math.abs(qty * 1e4 - Math.round(qty * 1e4)) > 1e-5 || qty > Number(line.qty_requested) - Number(line.assigned) + 1e-7) throw loadError("Load quantities must be positive, have at most four decimals, and cannot exceed unassigned quantities.");
    if (qty > 0) selected.push([line.id, qty]);
  }
  if (!selected.length) throw loadError("Enter at least one load quantity.");
  const seq = Number((await db.query("select coalesce(max(load_sequence),0)+1 as n from material_requisition_loads where requisition_id=$1", [id])).rows[0].n);
  if (seq === 1) await db.query("update material_requisitions set status='ACCEPTED',trailer_number=null,loaded_at=null,loaded_by_user_id=null where id=$1", [id]);
  const loadNo = header.requisition_no + "-" + String(seq).padStart(3, "0");
  const load = (await db.query(`insert into material_requisition_loads(job_id,requisition_id,load_sequence,load_no,trailer_number,created_by) values($1,$2,$3,$4,$5,$6) returning *`, [jobId, id, seq, loadNo, trailer, userId])).rows[0];
  for (const [lineId, qty] of selected) await db.query("insert into material_requisition_load_lines(load_id,requisition_line_id,qty) values($1,$2,$3)", [load.id, lineId, qty]);
  await db.query(`update material_requisition_lines mrl set qty_issued=coalesce((select sum(t.qty_issued) from material_issue_transactions t where t.requisition_line_id=mrl.id),0) where requisition_id=$1 and job_id=$2`, [id, jobId]);
  return load;
}
async function getEditableLoadLines(db, h, l) {
  return (await db.query(`select mrl.id, mrl.qty_requested, bl.item_code, bl.description, bl.uom,
    coalesce((select qty from material_requisition_load_lines where load_id=$2 and requisition_line_id=mrl.id),0) as qty,
    mrl.qty_requested-coalesce((select sum(ll.qty) from material_requisition_load_lines ll
      join material_requisition_loads other on other.id=ll.load_id
      where ll.requisition_line_id=mrl.id and other.id<>$2 and other.status<>'CANCELLED'),0) as max_qty
    from material_requisition_lines mrl join bom_lines bl on bl.id=mrl.bom_line_id
    where mrl.requisition_id=$1 order by bl.item_code, mrl.id`, [h.id,l.id])).rows;
}
function assertEditableLoad(h, l) {
  if (!["PLANNED", "LOADED"].includes(l.status) || !["ACCEPTED", "VERIFIED", "FLAGGED", "LOADED"].includes(h.status) || l.signed_at)
    throw loadError("Only unissued, unsigned loads can be edited.");
}
function registerRequisitionLoadRoutes(app, d) {
  const { query, withTransaction, requireAuth, requireJobContext, requirePermission, asyncHandler, currentJobId, layout, esc, canAccess, auditLog, upload, buildPickTicketPdf, renderRequisitionSignPage, canSignRequisition, signedCopyFilenameForRequisition, getCurrentOnHandRows, buildInventoryItemKey, buildPickLocationAllocations, recomputeBomIssuedSummaries, rebuildUnallocatedBom, getAvailableInventoryByItemMap } = d;
  const base = "/requisitions/:id/loads", url = (req) => `/requisitions/${req.params.id}/loads/${req.params.loadId}`;
  const get = (suffix, fn) => app.get(base + suffix, requireAuth, requireJobContext, requirePermission("requisitions", "view"), asyncHandler(fn));
  const post = (suffix, fn, extra = []) => app.post(base + suffix, requireAuth, requireJobContext, requirePermission("requisitions", "issue"), ...extra, asyncHandler(fn));
  async function parent(db, req, lock = false) {
    const h = (await db.query(`select mr.*,bh.bom_no,bh.bom_name,bh.description as bom_description from material_requisitions mr join bom_headers bh on bh.id=mr.bom_id where mr.id=$1 and mr.job_id=$2 ${lock ? "for update of mr" : ""}`, [req.params.id, currentJobId(req)])).rows[0];
    if (!h) throw loadError("Request not found.");
    return h;
  }
  async function load(db, req, lock = false) {
    const h = await parent(db, req, lock);
    const l = (await db.query(`select * from material_requisition_loads where id=$1 and requisition_id=$2 and job_id=$3 ${lock ? "for update" : ""}`, [req.params.loadId, h.id, currentJobId(req)])).rows[0];
    if (!l) throw loadError("Load not found.");
    return { h, l };
  }
  async function issue(db, h, l, req) {
    // A retry or a second sign-off must never post the same load twice.
    if (l.status === "ISSUED") return;
    if (l.status === "CANCELLED" || !["ACCEPTED", "VERIFIED", "FLAGGED", "LOADED"].includes(h.status)) throw loadError("This load cannot be issued.");
    // Match the legacy issue path: lock parent first, then serialize stock issues per job.
    await db.query("select id from jobs where id=$1 for update", [currentJobId(req)]);
    const lines = await getLoadLines(db, l.id);
    const remaining = (await db.query(`select mrl.*,bl.item_code,bl.size_1,bl.size_2,bl.thk_1,bl.thk_2, ${outstandingReservationSql} as reserved from material_requisition_lines mrl join bom_lines bl on bl.id=mrl.bom_line_id where mrl.requisition_id=$1`, [h.id])).rows;
    const offset = new Map();
    for (const row of remaining) {
      const k = buildInventoryItemKey(row);
      offset.set(k, (offset.get(k) || 0) + Number(row.reserved));
    }
    const available = await getAvailableInventoryByItemMap(db, currentJobId(req), { allocatedOffsetMap: offset });
    const stock = new Map();
    for (const row of await getCurrentOnHandRows(db, { jobId: currentJobId(req) })) {
      const k = buildInventoryItemKey(row);
      if (!stock.has(k)) stock.set(k, []);
      stock.get(k).push({ warehouse: row.warehouse, location: row.location, qty_available: Number(row.qty_on_hand) });
    }
    for (const line of lines) {
      const key = buildInventoryItemKey(line), qty = Number(line.qty), locations = stock.get(key) || [];
      if (qty > (available.get(key) || 0) + 1e-7) throw loadError("Not enough available inventory for " + line.item_code);
      const allocations = buildPickLocationAllocations(locations, qty);
      if (allocations.reduce((n, a) => n + Number(a.qty_issued), 0) + 1e-7 < qty) throw loadError("Not enough warehouse inventory for " + line.item_code);
      for (const a of allocations) {
        await db.query(`insert into material_issue_transactions(job_id,requisition_id,requisition_line_id,source_bom_line_id,issue_source,warehouse,location,qty_issued,created_by,load_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [currentJobId(req), h.id, line.requisition_line_id, line.bom_line_id, line.system_key === "UNALLOCATED" ? "UNALLOCATED" : "BOM", a.warehouse, a.location, a.qty_issued, req.user.id, l.id]);
        const loc = locations.find((r) => r.warehouse === a.warehouse && r.location === a.location);
        loc.qty_available -= Number(a.qty_issued);
      }
      available.set(key, (available.get(key) || 0) - qty);
    }
    await db.query("update material_requisition_loads set status='ISSUED',issued_at=now() where id=$1", [l.id]);
    await db.query(`update material_requisition_lines mrl set qty_issued=coalesce((select sum(t.qty_issued) from material_issue_transactions t where t.requisition_line_id=mrl.id),0) where requisition_id=$1`, [h.id]);
    await db.query(`update material_requisitions set status=case when not exists(select 1 from material_requisition_lines where requisition_id=$1 and qty_issued<qty_requested) then 'ISSUED' else 'ACCEPTED' end,issued_at=now(),issued_by_user_id=$2 where id=$1`, [h.id, req.user.id]);
    await recomputeBomIssuedSummaries(db, currentJobId(req));
    await rebuildUnallocatedBom(db, currentJobId(req));
    await auditLog(db, req.user.id, "issue", "material_requisition_load", l.id, l.load_no);
  }
  post("", async (req, res) => {
    const l = await withTransaction(async (db) => {
      const l2 = await createRequisitionLoad(db, { id: req.params.id, jobId: currentJobId(req), userId: req.user.id, trailer: req.body.trailer_number, body: req.body });
      await auditLog(db, req.user.id, "create", "material_requisition_load", l2.id, l2.load_no);
      return l2;
    });
    res.redirect(`/requisitions/${req.params.id}/loads/${l.id}`);
  });
  get("/:loadId", async (req, res) => {
    const { h, l } = await load({ query }, req), lines = await getLoadLines({ query }, l.id), path = url(req), active = !["ISSUED", "CANCELLED"].includes(l.status) && !["CANCELLED", "CLOSED"].includes(h.status), edit = canAccess(req.user, "requisitions", "issue");
    res.send(layout(l.load_no, `<h1>Load ${esc(l.load_no)}</h1><p><a href="/requisitions/${h.id}">Original request ${esc(h.requisition_no)}</a> | Trailer: ${esc(l.trailer_number)} | Status: ${esc(l.status)}</p><div class="card"><div class="actions">${edit && active ? `<a class="btn btn-primary" href="${path}/edit">Edit Load</a>` : ""}<a class="btn btn-secondary" href="${path}/pick-ticket.pdf" target="_blank">Pick Ticket PDF</a>${edit && l.status !== "CANCELLED" && h.status !== "CANCELLED" ? `<a class="btn" href="${path}/sign">Sign-Off</a>` : ""}</div>${edit && active ? `<form method="post" action="${path}/load"><label>Trailer Number</label><input name="trailer_number" maxlength="120" value="${esc(l.trailer_number)}" required><button>Save Loaded</button></form><form method="post" action="${path}/issue"><button>Issue Load To Field</button></form><form method="post" action="${path}/cancel" onsubmit="return confirm('Cancel this load and release its quantities for another load?')"><button class="btn btn-secondary">Cancel Load</button></form>` : ""}</div><div class="card scroll"><table><tr><th>Item</th><th>Description</th><th>Load Qty</th><th>Loaded</th><th>Issued</th><th>Remaining to Issue</th><th>UOM</th></tr>${lines.map((r) => `<tr><td>${esc(r.item_code)}</td><td>${esc(r.description)}</td><td>${esc(r.qty)}</td><td>${esc(l.status==='LOADED'?Math.max(Number(r.qty)-Number(r.issued_qty),0):0)}</td><td>${esc(r.issued_qty)}</td><td>${esc(l.status==='CANCELLED'?0:Math.max(Number(r.qty)-Number(r.issued_qty),0))}</td><td>${esc(r.uom)}</td></tr>`).join("")}</table></div><div class="card"><h3>Load Sign-Off</h3><p>Signed by: ${esc(l.signed_by_name || "Not signed")} ${esc(l.signed_at || "")}</p>${l.signed_signature_data ? `<img alt="Load signature" src="${esc(l.signed_signature_data)}" style="max-width:100%;max-height:180px">` : ""}${l.signed_copy_filename ? `<a href="${path}/signed-copy" target="_blank">${esc(l.signed_copy_filename)}</a>` : ""}</div>`, req.user));
  });
  get("/:loadId/edit", async (req, res) => {
    if (!canAccess(req.user, "requisitions", "issue")) throw loadError("Load editing permission required.");
    const {h,l} = await load({query},req);
    assertEditableLoad(h,l);
    const lines = await getEditableLoadLines({query},h,l), path=url(req);
    res.send(layout("Edit Load", `<h1>Edit Load ${esc(l.load_no)}</h1><div class="card">
      <p>Add parts from the original request or change quantities. Available for this load includes its current quantity and excludes quantities assigned to other loads. Enter 0 to remove a part. Saving returns the load to Planned so loading can be confirmed again.</p>
      <form method="post" action="${path}/edit">
        <label>Trailer Number</label><input name="trailer_number" maxlength="120" value="${esc(l.trailer_number)}" required>
        <div class="scroll"><table><tr><th>Item</th><th>Description</th><th>Requested</th><th>Available for This Load</th><th>Load Qty</th><th>UOM</th></tr>
        ${lines.filter(r=>Number(r.max_qty)>0 || Number(r.qty)>0).map(r=>`<tr><td>${esc(r.item_code)}</td><td>${esc(r.description)}</td><td>${esc(r.qty_requested)}</td><td>${esc(r.max_qty)}</td><td><input type="number" name="qty_${r.id}" min="0" max="${esc(r.max_qty)}" step="0.0001" value="${esc(r.qty)}" aria-label="Load quantity for ${esc(r.item_code)}"></td><td>${esc(r.uom)}</td></tr>`).join("")}
        </table></div><div class="actions"><button>Save Load</button><a class="btn btn-secondary" href="${path}">Back</a></div>
      </form></div>`,req.user));
  });
  post("/:loadId/edit", async (req,res) => {
    await withTransaction(async db => {
      const {h,l}=await load(db,req,true);
      assertEditableLoad(h,l);
      if ((await db.query("select 1 from material_issue_transactions where load_id=$1 limit 1",[l.id])).rows.length) throw loadError("Issued loads cannot be edited.");
      const trailer=String(req.body.trailer_number || "").trim();
      if (!trailer || trailer.length>120) throw loadError("Enter a trailer number (maximum 120 characters).");
      const lines=await getEditableLoadLines(db,h,l), selected=[];
      for (const row of lines) {
        const qty=Number(String(req.body["qty_"+row.id] ?? "0").trim());
        if (!Number.isFinite(qty) || qty<0 || Math.abs(qty*1e4-Math.round(qty*1e4))>1e-5 || qty>Number(row.max_qty)+1e-7)
          throw loadError("Load quantities must be nonnegative, have at most four decimals, and cannot exceed the quantity available for this load.");
        if(qty>0) selected.push([row.id,qty]);
      }
      if(!selected.length) throw loadError("Keep at least one part on the load, or use Cancel Load.");
      await db.query("delete from material_requisition_load_lines where load_id=$1",[l.id]);
      for(const [id,qty] of selected) await db.query("insert into material_requisition_load_lines(load_id,requisition_line_id,qty) values($1,$2,$3)",[l.id,id,qty]);
      await db.query("update material_requisition_loads set trailer_number=$2,status='PLANNED',loaded_at=null where id=$1",[l.id,trailer]);
      await auditLog(db,req.user.id,"edit","material_requisition_load",l.id,l.load_no);
    });
    res.redirect(url(req));
  });
  post("/:loadId/load", async (req, res) => {
    await withTransaction(async (db) => {
      const { h, l } = await load(db, req, true);
      if (!["PLANNED", "LOADED"].includes(l.status) || !["ACCEPTED", "VERIFIED", "FLAGGED", "LOADED"].includes(h.status)) throw loadError("Only open loads can be changed.");
      const trailer = String(req.body.trailer_number || "").trim();
      if (!trailer || trailer.length > 120) throw loadError("Enter a trailer number.");
      await db.query("update material_requisition_loads set trailer_number=$2,status='LOADED',loaded_at=now() where id=$1", [l.id, trailer]);
      await auditLog(db, req.user.id, "load", "material_requisition_load", l.id, l.load_no + "|" + trailer);
    });
    res.redirect(url(req));
  });
  post("/:loadId/cancel", async (req, res) => {
    await withTransaction(async (db) => {
      const { l } = await load(db, req, true);
      if (l.status === "ISSUED") throw loadError("Issued loads cannot be cancelled.");
      await db.query("update material_requisition_loads set status='CANCELLED' where id=$1", [l.id]);
      await auditLog(db, req.user.id, "cancel", "material_requisition_load", l.id, l.load_no);
    });
    res.redirect(`/requisitions/${req.params.id}`);
  });
  post("/:loadId/issue", async (req, res) => {
    await withTransaction(async (db) => {
      const { h, l } = await load(db, req, true);
      await issue(db, h, l, req);
    });
    res.redirect(url(req));
  });
  get("/:loadId/pick-ticket.pdf", async (req, res) => {
    const { h, l } = await load({ query }, req);
    if (l.status === "CANCELLED" || h.status === "CANCELLED") throw loadError("Cancelled loads have no active pick ticket.");
    const lines = await getLoadLines({ query }, l.id), stock = await getCurrentOnHandRows({ query }, { jobId: currentJobId(req) });
    const printable = [];
    for (const line of lines) {
      let allocations;
      if (l.status === "ISSUED") allocations = (await query("select warehouse,location,qty_issued from material_issue_transactions where load_id=$1 and requisition_line_id=$2", [l.id, line.requisition_line_id])).rows;
      else {
        const rows = stock.filter((r) => buildInventoryItemKey(r) === buildInventoryItemKey(line));
        allocations = buildPickLocationAllocations(rows.map((r) => ({ ...r, qty_available: Number(r.qty_on_hand) })), Number(line.qty));
        for (const a of allocations) {
          const row = rows.find((r) => r.warehouse === a.warehouse && r.location === a.location);
          row.qty_on_hand -= Number(a.qty_issued);
        }
      }
      printable.push({ ...line, qty_requested: Number(line.qty), qty_issued: Number(line.qty), pick_location: allocations.map((a) => `${a.warehouse}/${a.location}: ${a.qty_issued}`).join(", ") || "No inventory location" });
    }
    const ticket = { ...h, requisition_no: l.load_no, trailer_number: l.trailer_number, notes: ["Trailer: " + l.trailer_number, h.notes].filter(Boolean).join(" | ") };
    res.type("application/pdf").set("Content-Disposition", `inline; filename="${l.load_no.replace(/[^A-Za-z0-9._-]/g, "_")}-pick-ticket.pdf"`).send(buildPickTicketPdf(ticket, printable));
  });
  get("/:loadId/sign", async (req, res) => {
    if (!canAccess(req.user, "requisitions", "issue")) throw loadError("Sign-off permission required.");
    const { h, l } = await load({ query }, req);
    if (h.status === "CANCELLED" || !canSignRequisition(req.user, { ...l, status: l.status === "PLANNED" ? "ACCEPTED" : l.status })) throw loadError("This load cannot be signed.");
    res.send(renderRequisitionSignPage({ ...h, ...l, id: h.id, requisition_no: l.load_no, status: l.status === "PLANNED" ? "ACCEPTED" : l.status }, [], req, url(req)));
  });
  async function sign(req, res, fileMode) {
    const name = String(req.body.signed_by_name || "").trim(), sig = String(req.body.signature_data || "");
    if (!name) throw loadError("Signer name is required.");
    if (fileMode) {
      if (!req.file?.buffer?.length || !["application/pdf", "image/png", "image/jpeg"].includes(req.file.mimetype)) throw loadError("Select a PDF, PNG or JPEG signed copy.");
    } else if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) throw loadError("A valid signature image is required.");
    await withTransaction(async (db) => {
      const { h, l } = await load(db, req, true);
      if (h.status === "CANCELLED" || !canSignRequisition(req.user, { ...l, status: l.status === "PLANNED" ? "ACCEPTED" : l.status })) throw loadError("This load cannot be signed.");
      await issue(db, h, l, req);
      if (fileMode) await db.query("update material_requisition_loads set signed_at=now(),signed_by_name=$2,signed_copy_filename=$3,signed_copy_mime=$4,signed_copy_data=$5 where id=$1", [l.id, name, signedCopyFilenameForRequisition(l.load_no, req.file.mimetype), req.file.mimetype, req.file.buffer]);
      else await db.query("update material_requisition_loads set signed_at=now(),signed_by_name=$2,signed_signature_data=$3 where id=$1", [l.id, name, sig]);
      await auditLog(db, req.user.id, "sign", "material_requisition_load", l.id, l.load_no + "|" + name);
    });
    res.redirect(url(req));
  }
  post("/:loadId/sign", (req, res) => sign(req, res, false));
  post("/:loadId/signed-copy", (req, res) => sign(req, res, true), [upload.single("signed_copy")]);
  get("/:loadId/signed-copy", async (req, res) => {
    const { l } = await load({ query }, req);
    if (!l.signed_copy_data) throw loadError("No signed copy saved.");
    res.type(l.signed_copy_mime).set("Content-Disposition", `inline; filename="${l.signed_copy_filename}"`).send(Buffer.from(l.signed_copy_data));
  });
}
export {
  assertNoRequisitionLoads,
  createRequisitionLoad,
  getLoadLines,
  hasRequisitionLoads,
  outstandingReservationSql,
  registerRequisitionLoadRoutes
};
