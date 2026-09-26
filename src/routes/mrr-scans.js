import { Readable } from "node:stream";
import express from "express";
import {
  isMrrScanPath,
  mrrScanFilename,
  mrrScanMaxBytes,
  mrrScanPrefix,
  verifyMrrScan
} from "../mrr-scans.js";

export function registerMrrScanRoutes(app, dependencies) {
  const {
    asyncHandler,
    auditLog,
    canAccess,
    contentDispositionFilename,
    currentJobId,
    del,
    esc,
    escAttr,
    formatShortDateTime,
    get,
    getRequestAuthContext,
    handleUpload,
    layout,
    query,
    requireAuth,
    requireJobContext,
    requirePermission,
    vercelBlobClientModuleUrl,
    withTransaction
  } = dependencies;

  app.post("/material-logs/mrr/:id/scanned-pdf/client-upload", express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
    try {
      const response = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          const user = await getRequestAuthContext(req);
          if (!user?.activeJob || !canAccess(user, "material_logs", "edit")) {
            throw new Error("Sign in to the job with permission to edit MRRs before uploading.");
          }
          const mrrId = Number(req.params.id);
          const row = (await query("select mrr_number from mrr_logs where id = $1 and job_id = $2", [mrrId, user.job_id])).rows[0];
          if (!row || !isMrrScanPath(pathname, user.job_id, mrrId, row.mrr_number)) {
            throw new Error("Invalid MRR upload target. Refresh the log and try again.");
          }
          return {
            allowedContentTypes: ["application/pdf"],
            maximumSizeInBytes: mrrScanMaxBytes,
            addRandomSuffix: false,
            allowOverwrite: false
          };
        }
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error.message || "Unable to upload MRR scan." });
    }
  }));

  app.post("/material-logs/mrr/:id/scanned-pdf/complete", requireAuth, requireJobContext, requirePermission("material_logs", "edit"), express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
    try {
      const mrrId = Number(req.params.id);
      const jobId = currentJobId(req);
      const pathname = req.body.pathname;
      const oldPathname = await withTransaction(async (client) => {
        const row = (await client.query("select mrr_number, scanned_pdf_pathname from mrr_logs where id = $1 and job_id = $2 for update", [mrrId, jobId])).rows[0];
        if (!row || !isMrrScanPath(pathname, jobId, mrrId, row.mrr_number)) throw new Error("Invalid MRR scan. Refresh the log and try again.");
        if (pathname === row.scanned_pdf_pathname) return "";
        const blob = await get(pathname, { access: "private", useCache: false });
        await verifyMrrScan(blob);
        await client.query(`
          update mrr_logs set scanned_pdf_pathname = $1, scanned_pdf_size_bytes = $2,
            scanned_pdf_uploaded_at = now(), scanned_pdf_uploaded_by = $3
          where id = $4 and job_id = $5
        `, [pathname, blob.blob.size, req.user.id, mrrId, jobId]);
        await auditLog(client, req.user.id, "upload", "mrr_scan", mrrId, mrrScanFilename(row.mrr_number));
        return row.scanned_pdf_pathname;
      });
      if (oldPathname) {
        try { await del(oldPathname); } catch (error) { console.error("Unable to delete replaced MRR scan", error); }
      }
      res.json({ openUrl: `/material-logs/mrr/${mrrId}/scanned-pdf/open` });
    } catch (error) {
      res.status(400).json({ error: error.message || "Unable to save MRR scan." });
    }
  }));

  app.get("/material-logs/mrr/:id/scanned-pdf/open", requireAuth, requireJobContext, requirePermission("material_logs", "view"), asyncHandler(async (req, res) => {
    const row = (await query("select mrr_number, scanned_pdf_pathname from mrr_logs where id = $1 and job_id = $2", [Number(req.params.id), currentJobId(req)])).rows[0];
    if (!row?.scanned_pdf_pathname) return res.status(404).send("No scanned PDF has been uploaded for this MRR.");
    const blob = await get(row.scanned_pdf_pathname, { access: "private" });
    if (!blob?.stream) return res.status(404).send("The scanned PDF is not available.");
    const filename = mrrScanFilename(row.mrr_number);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${contentDispositionFilename(filename).replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    Readable.fromWeb(blob.stream).on("error", (error) => res.destroy(error)).pipe(res);
  }));

  app.get("/material-logs/mrr", requireAuth, requireJobContext, requirePermission("material_logs", "view"), async (req, res) => {
    const jobId = currentJobId(req);
    const q = String(req.query.q || "").trim();
    const imported = Number.parseInt(String(req.query.imported || ""), 10);
    const skipped = Number.parseInt(String(req.query.skipped || ""), 10);
    const rows = (await query(`
      select m.id, m.discipline, m.mrr_number, m.vendor_name, coalesce(po.po_no, m.po_number) as po_number,
             coalesce(m.status, 'ACTIVE') as status,
             m.pick_ticket, m.material_description, m.received_date, m.received_by, m.load_number, m.opi_number,
             m.scanned_pdf_pathname
      from mrr_logs m
      left join purchase_orders po on po.id = m.app_po_id
      where m.job_id = $1
        ${q ? "and (coalesce(m.mrr_number, '') ilike $2 or coalesce(m.vendor_name, '') ilike $2 or coalesce(po.po_no, m.po_number, '') ilike $2 or coalesce(m.material_description, '') ilike $2 or coalesce(m.received_by, '') ilike $2)" : ""}
      order by nullif(substring(coalesce(m.mrr_number, '') from '([0-9]+)$'), '')::bigint desc nulls last, m.id desc
      limit 200
    `, q ? [jobId, `%${q}%`] : [jobId])).rows;
    const tableRows = rows.map((row) => {
      const isReversed = String(row.status || "").toUpperCase() === "REVERSED";
      const canUpload = canAccess(req.user, "material_logs", "edit");
      const hasScan = Boolean(row.scanned_pdf_pathname);
      return `<tr data-mrr-scan-row data-mrr-id="${row.id}" data-has-scan="${hasScan}" data-upload-prefix="${escAttr(mrrScanPrefix(jobId, row.id))}" data-filename="${escAttr(mrrScanFilename(row.mrr_number))}">
      <td style="min-width:120px;white-space:nowrap;">${esc(row.mrr_number)}${isReversed ? `<div style="margin-top:4px;"><span class="chip">Reversed</span></div>` : ""}</td>
      <td>${esc(row.discipline)}</td>
      <td>${esc(row.vendor_name)}</td>
      <td>${esc(row.po_number)}</td>
      <td>${esc(row.pick_ticket)}</td>
      <td>${esc(row.material_description)}</td>
      <td>${esc(formatShortDateTime(row.received_date))}</td>
      <td>${esc(row.received_by)}</td>
      <td>${esc(row.load_number)}</td>
      <td>${esc(row.opi_number)}</td>
      <td style="min-width:190px;"><div class="actions" style="flex-wrap:nowrap;"><a class="btn btn-secondary" href="/material-logs/mrr/${row.id}/edit">Edit</a><a class="btn btn-secondary" target="_blank" href="/material-logs/mrr/${row.id}/form.pdf">MRR Form</a></div></td>
      <td style="min-width:145px;">
        <div class="actions" style="flex-wrap:nowrap;">
          ${canUpload ? `<button type="button" class="btn btn-secondary" data-scan-upload title="Upload scanned PDF" aria-label="Upload scanned PDF for ${escAttr(row.mrr_number)}">&#8593;</button><input type="file" accept=".pdf,application/pdf" data-scan-input hidden />` : ""}
          <a class="btn btn-secondary mrr-scan-open" data-scan-open target="_blank" rel="noopener" ${hasScan ? `href="/material-logs/mrr/${row.id}/scanned-pdf/open"` : 'aria-disabled="true" tabindex="-1"'}>Open Scan</a>
        </div>
        <div data-scan-status role="status" aria-live="polite" class="muted"></div>
      </td>
    </tr>`;
    }).join("");
    res.send(layout("MRR Log", `
      <h1>MRR Log</h1>
      ${Number.isFinite(imported) && imported >= 0 ? `
        <div class="card success">
          Imported ${esc(imported)} MRR row${imported === 1 ? "" : "s"}${Number.isFinite(skipped) && skipped > 0 ? ` and skipped ${esc(skipped)} row${skipped === 1 ? "" : "s"} with no MRR number.` : ""}.
        </div>
      ` : ""}
      <div class="card">
        <form method="get" action="/material-logs/mrr" class="stack">
          <div class="grid" style="grid-template-columns: 1fr auto auto;">
            <div><label>Filter MRR Log</label><input name="q" value="${esc(q)}" placeholder="MRR, vendor, PO, description, received by" /></div>
            <div style="align-self:end;"><button type="submit">Apply Filter</button></div>
            <div style="align-self:end;"><a class="btn btn-primary" href="/material-logs/mrr/new">Add New MRR</a></div>
          </div>
        </form>
      </div>
      <div class="card scroll">
        <table><tr><th>MRR #</th><th>Disc.</th><th>Vendor</th><th>PO</th><th>Pick Ticket</th><th>Description</th><th>Recv Date</th><th>Recv By</th><th>Load #</th><th>OPI #</th><th>Action</th><th>Scan</th></tr>${tableRows || `<tr><td colspan="12" class="muted">No MRR rows found.</td></tr>`}</table>
      </div>
      <style>
        [data-scan-upload] { width:32px; min-width:32px; flex:0 0 32px; padding:0; }
        .mrr-scan-open[aria-disabled="true"] { background:#e5e7eb; color:#6b7280; cursor:not-allowed; pointer-events:none; }
        [data-mrr-scan-row].scan-drag-over > td { background:#e6f4ef; box-shadow:inset 0 2px #22785b,inset 0 -2px #22785b; }
        [data-scan-status] { max-width:230px; white-space:normal; overflow-wrap:anywhere; }
      </style>
      <script type="module" src="/public/mrr-scans.js" data-client-module-url="${escAttr(vercelBlobClientModuleUrl)}"></script>
    `, req.user));
  });
}
