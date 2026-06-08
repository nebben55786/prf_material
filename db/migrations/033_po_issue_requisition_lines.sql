alter table purchase_orders drop constraint if exists purchase_orders_po_no_key;
drop index if exists idx_purchase_orders_job_po_no_unique;

alter table material_requisition_lines
  add column if not exists source_po_line_id bigint references po_lines(id) on delete set null;

create index if not exists idx_material_requisition_lines_source_po_line
  on material_requisition_lines(job_id, source_po_line_id)
  where source_po_line_id is not null;
