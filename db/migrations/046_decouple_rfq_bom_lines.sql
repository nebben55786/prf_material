-- RFQs keep item snapshots, not BOM allocations. Restore planning fields
-- previously changed solely by copying a BOM to an RFQ.
update bom_lines bl
set planning_status = 'PLANNED', qty_quoted = 0, updated_at = now()
where bl.planning_status = 'ON_RFQ'
  and exists (select 1 from rfq_items ri where ri.bom_line_id = bl.id);

alter table rfq_items drop column if exists bom_line_id;
