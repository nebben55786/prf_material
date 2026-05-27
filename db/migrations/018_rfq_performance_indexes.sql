create index if not exists idx_rfqs_job_id_desc on rfqs(job_id, id desc);
create index if not exists idx_rfqs_job_status_id_desc on rfqs(job_id, status, id desc);
create index if not exists idx_rfqs_job_requestor_name on rfqs(job_id, trim(coalesce(requestor_name, '')));

create index if not exists idx_rfq_items_job_rfq_id on rfq_items(job_id, rfq_id);
create index if not exists idx_rfq_items_job_material_item_id on rfq_items(job_id, material_item_id);
create index if not exists idx_rfq_items_awarded_lookup
  on rfq_items(job_id, rfq_id, awarded_vendor_id)
  where award_status = 'AWARDED' and awarded_vendor_id is not null;

create index if not exists idx_purchase_orders_job_rfq_id on purchase_orders(job_id, rfq_id);
create index if not exists idx_purchase_orders_job_id_desc on purchase_orders(job_id, id desc);

create index if not exists idx_po_lines_job_po_id on po_lines(job_id, po_id);
create index if not exists idx_po_lines_job_rfq_item_id on po_lines(job_id, rfq_item_id);
create index if not exists idx_receipts_job_po_line_id on receipts(job_id, po_line_id);
create index if not exists idx_receipts_job_mrr_log_id on receipts(job_id, mrr_log_id);

create index if not exists idx_import_batches_job_rfq_id_desc on import_batches(job_id, rfq_id, id desc);
create index if not exists idx_material_items_job_item_code on material_items(job_id, item_code);
create index if not exists idx_mrr_logs_job_id_desc on mrr_logs(job_id, id desc);
create index if not exists idx_fmr_logs_job_id_desc on fmr_logs(job_id, id desc);
