alter table purchase_orders drop constraint if exists purchase_orders_po_no_key;
drop index if exists idx_purchase_orders_job_po_no_unique;
create index if not exists idx_purchase_orders_job_po_no on purchase_orders (job_id, po_no);
