import XLSX from "xlsx";

export function registerMrrDocumentRoutes(app, dependencies) {
  const {
    asyncHandler,
    auditLog,
    buildMrrFormPdf,
    buildRfqFlowWorkbook,
    currentJobId,
    formatQtyDisplay,
    pool,
    query,
    requireAuth,
    requireJobContext,
    requirePermission
  } = dependencies;

  app.get("/material-logs/mrr/:id/form.pdf", requireAuth, requireJobContext, requirePermission("material_logs", "view"), asyncHandler(async (req, res) => {
    const jobId = currentJobId(req);
    const [headerRes, poReceiptLines, manualLines, linkedFmrRes] = await Promise.all([
      query(`
        select
          m.*,
          coalesce(po.po_no, m.po_number) as effective_po_number
        from mrr_logs m
        left join purchase_orders po on po.id = m.app_po_id
        where m.id = $1
          and m.job_id = $2
      `, [req.params.id, jobId]),
      query(`
        select
          r.id,
          coalesce(pl.po_line, '') as po_line,
          coalesce(mi.item_code, '') as item_code,
          coalesce(mi.description, '') as description,
          coalesce(pl.qty_ordered, 0) as ordered_qty,
          coalesce(r.qty_received, 0) as received_qty,
          coalesce(r.warehouse, '') as warehouse,
          coalesce(r.location, '') as location,
          coalesce(r.osd_status, '') as osd_status,
          coalesce(r.osd_notes, '') as notes
        from receipts r
        join po_lines pl on pl.id = r.po_line_id
        join material_items mi on mi.id = pl.material_item_id
        where r.mrr_log_id = $1
          and r.job_id = $2
        order by r.id
      `, [req.params.id, jobId]),
      query(`
        select
          mrl.id,
          coalesce(mrl.po_position, '') as po_line,
          coalesce(mrl.item_code, '') as item_code,
          coalesce(mrl.description, '') as description,
          0 as ordered_qty,
          coalesce(mrl.received_qty, 0) as received_qty,
          coalesce(mrl.warehouse, '') as warehouse,
          coalesce(mrl.location, '') as location,
          coalesce(mrl.received_status, '') as osd_status,
          coalesce(mrl.comments, '') as notes
        from material_receiving_logs mrl
        where coalesce(mrl.mrr_number, '') = (
          select coalesce(mrr_number, '') from mrr_logs where id = $1 and job_id = $2
        )
          and mrl.job_id = $2
        order by coalesce(mrl.legacy_row_id, mrl.id)
      `, [req.params.id, jobId]),
      query(`
        select fmr_number, container_no
        from fmr_logs
        where job_id = $2
          and coalesce(mrr_number, '') = (
          select coalesce(mrr_number, '') from mrr_logs where id = $1 and job_id = $2
        )
        order by id
        limit 1
      `, [req.params.id, jobId])
    ]);
    const header = headerRes.rows[0];
    if (!header) throw new Error("MRR log row not found.");
    const linkedFmr = linkedFmrRes.rows[0] || {};
    const deliveryMatch = String(linkedFmr.fmr_number || "").match(/^FMR-([A-Z0-9]+)-/i);
    const printableLines = [...poReceiptLines.rows, ...manualLines.rows].map((row) => ({
      item_code: row.item_code || "",
      description: row.description || "",
      qty: formatQtyDisplay(row.received_qty),
      location: [row.warehouse, row.location].filter(Boolean).join(" / "),
      grid: "",
      status: row.osd_status || "",
      ordered: row.ordered_qty ? formatQtyDisplay(row.ordered_qty) : "",
      shipped: row.ordered_qty ? formatQtyDisplay(row.ordered_qty) : "",
      received: formatQtyDisplay(row.received_qty),
      discrepancy: [row.osd_status && row.osd_status !== "OK" ? row.osd_status : "", row.notes || ""].filter(Boolean).join(" | ")
    }));
    const pdfBuffer = buildMrrFormPdf({
      mrr_number: header.mrr_number || "",
      vendor_name: header.vendor_name || "",
      po_number: header.effective_po_number || "",
      pick_ticket: header.pick_ticket || "",
      received_date: header.received_date || "",
      received_by: header.received_by || "",
      load_number: header.load_number || "",
      notes: header.notes || "",
      container_type: "",
      material_description: header.material_description || ""
    }, printableLines, {
      jobNumber: req.user.activeJob?.performance_job_number || req.user.activeJob?.job_number || "",
      deliveryLocation: deliveryMatch?.[1] || "",
      fmrNumber: linkedFmr.fmr_number || ""
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(header.mrr_number || "MRR").replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`);
    res.send(pdfBuffer);
  }));

  app.get("/material-logs/mrr/:id/export-flow.xlsx", requireAuth, requireJobContext, requirePermission("material_logs", "view"), asyncHandler(async (req, res) => {
    const jobId = currentJobId(req);
    const [headerRes, poReceiptLines, manualLines] = await Promise.all([
      query("select id, mrr_number from mrr_logs where id = $1 and job_id = $2", [req.params.id, jobId]),
      query(`
        select
          r.id,
          coalesce(nullif(pl.item_code_snapshot, ''), mi.item_code) as item_code,
          coalesce(pl.size_1, '') as size_1,
          coalesce(pl.size_2, '') as size_2,
          coalesce(r.qty_received, 0) as qty,
          r.received_at::text as line_date
        from receipts r
        join po_lines pl on pl.id = r.po_line_id
        join material_items mi on mi.id = pl.material_item_id
        where r.mrr_log_id = $1
          and r.job_id = $2
        order by r.id
      `, [req.params.id, jobId]),
      query(`
        select
          mrl.id,
          coalesce(mrl.item_code, '') as item_code,
          coalesce(mi.size_1, '') as size_1,
          coalesce(mi.size_2, '') as size_2,
          coalesce(mrl.received_qty, 0) as qty,
          coalesce(mrl.recv_date, '') as line_date
        from material_receiving_logs mrl
        left join lateral (
          select size_1, size_2
          from material_items mi
          where mi.job_id = mrl.job_id
            and lower(trim(mi.item_code)) = lower(trim(mrl.item_code))
          order by mi.id
          limit 1
        ) mi on true
        where coalesce(mrl.mrr_number, '') = (
          select coalesce(mrr_number, '') from mrr_logs where id = $1 and job_id = $2
        )
          and mrl.job_id = $2
        order by coalesce(mrl.legacy_row_id, mrl.id)
      `, [req.params.id, jobId])
    ]);
    const header = headerRes.rows[0];
    if (!header) throw new Error("MRR log row not found.");
    const rows = [...poReceiptLines.rows, ...manualLines.rows]
      .sort((a, b) => String(b.line_date || "").localeCompare(String(a.line_date || "")) || Number(b.id || 0) - Number(a.id || 0));
    const workbook = buildRfqFlowWorkbook(rows);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true });
    await auditLog(pool, req.user.id, "export", "mrr_flow_workbook", header.id, `rows=${rows.length}|${header.mrr_number || ""}`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${String(header.mrr_number || "MRR").replace(/[^A-Za-z0-9._-]/g, "_")}-flow.xlsx"`);
    res.send(buffer);
  }));
}
