create index if not exists idx_receipts_job_po_line_id_desc
  on receipts(job_id, po_line_id, id desc);

create index if not exists idx_receipts_po_line_id_desc
  on receipts(po_line_id, id desc);

create index if not exists idx_osd_logs_job_po_line_status
  on osd_logs(job_id, po_line_id, osd_status);

create index if not exists idx_osd_logs_receipt_id
  on osd_logs(receipt_id);
