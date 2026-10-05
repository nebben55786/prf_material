import { Readable } from "node:stream";
import express from "express";
import {
  isRfqConfirmationPath,
  rfqConfirmationFilename,
  rfqConfirmationMaxBytes,
  verifyRfqConfirmation
} from "../rfq-confirmations.js";

const confirmationPoNumberSql = `coalesce(nullif(trim(r.po_number), ''), (
  select min(po.po_no)
  from po_lines pl
  join purchase_orders po on po.id = pl.po_id and po.job_id = pl.job_id
  join rfq_items ri on ri.id = pl.rfq_item_id and ri.job_id = pl.job_id
  where ri.rfq_id = r.id and ri.job_id = r.job_id
), '') as confirmation_po_number`;

export function registerRfqConfirmationRoutes(app, dependencies) {
  const {
    asyncHandler,
    auditLog,
    canAccess,
    contentDispositionFilename,
    currentJobId,
    del,
    get,
    getRequestAuthContext,
    handleUpload,
    query,
    requireAuth,
    requireJobContext,
    requirePermission,
    withTransaction
  } = dependencies;

  app.post("/rfq/:id/po-confirmation/client-upload", express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
    try {
      const response = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          const user = await getRequestAuthContext(req);
          if (!user?.activeJob || !canAccess(user, "rfqs", "edit")) {
            throw new Error("Sign in to the job with permission to edit RFQs before uploading.");
          }
          const rfqId = Number(req.params.id);
          const row = (await query(`select rfq_no, ${confirmationPoNumberSql} from rfqs r where r.id = $1 and r.job_id = $2`, [rfqId, user.job_id])).rows[0];
          if (!row || !isRfqConfirmationPath(pathname, user.job_id, rfqId, row.confirmation_po_number)) {
            throw new Error("Invalid RFQ upload target. Refresh the log and try again.");
          }
          return {
            allowedContentTypes: ["application/pdf"],
            maximumSizeInBytes: rfqConfirmationMaxBytes,
            addRandomSuffix: false,
            allowOverwrite: false
          };
        }
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error.message || "Unable to upload PO confirmation." });
    }
  }));

  app.post("/rfq/:id/po-confirmation/complete", requireAuth, requireJobContext, requirePermission("rfqs", "edit"), express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
    try {
      const rfqId = Number(req.params.id);
      const jobId = currentJobId(req);
      const pathname = req.body.pathname;
      const oldPathname = await withTransaction(async (client) => {
        const row = (await client.query(`select rfq_no, po_confirmation_pdf_pathname, ${confirmationPoNumberSql} from rfqs r where r.id = $1 and r.job_id = $2 for update of r`, [rfqId, jobId])).rows[0];
        if (!row || !isRfqConfirmationPath(pathname, jobId, rfqId, row.confirmation_po_number)) throw new Error("Invalid PO confirmation. Refresh the log and try again.");
        if (pathname === row.po_confirmation_pdf_pathname) return "";
        const blob = await get(pathname, { access: "private", useCache: false });
        await verifyRfqConfirmation(blob);
        await client.query(`
          update rfqs set po_confirmation_pdf_pathname = $1, po_confirmation_pdf_size_bytes = $2,
            po_confirmation_pdf_uploaded_at = now(), po_confirmation_pdf_uploaded_by = $3
          where id = $4 and job_id = $5
        `, [pathname, blob.blob.size, req.user.id, rfqId, jobId]);
        await auditLog(client, req.user.id, "upload", "rfq_confirmation", rfqId, rfqConfirmationFilename(row.confirmation_po_number));
        return row.po_confirmation_pdf_pathname;
      });
      if (oldPathname) {
        try { await del(oldPathname); } catch (error) { console.error("Unable to delete replaced PO confirmation", error); }
      }
      res.json({ openUrl: `/rfq/${rfqId}/po-confirmation/open` });
    } catch (error) {
      res.status(400).json({ error: error.message || "Unable to save PO confirmation." });
    }
  }));

  app.get("/rfq/:id/po-confirmation/open", requireAuth, requireJobContext, requirePermission("rfqs", "view"), asyncHandler(async (req, res) => {
    const row = (await query(`select rfq_no, po_confirmation_pdf_pathname, ${confirmationPoNumberSql} from rfqs r where r.id = $1 and r.job_id = $2`, [Number(req.params.id), currentJobId(req)])).rows[0];
    if (!row?.po_confirmation_pdf_pathname) return res.status(404).send("No PO confirmation PDF has been uploaded for this RFQ.");
    const blob = await get(row.po_confirmation_pdf_pathname, { access: "private" });
    if (!blob?.stream) return res.status(404).send("The PO confirmation PDF is not available.");
    const filename = rfqConfirmationFilename(row.confirmation_po_number);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${contentDispositionFilename(filename).replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    Readable.fromWeb(blob.stream).on("error", (error) => res.destroy(error)).pipe(res);
  }));

}
