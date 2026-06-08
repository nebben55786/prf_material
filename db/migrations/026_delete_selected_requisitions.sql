do $$
begin
  create temporary table selected_requisitions_to_delete (
    requisition_no text primary key
  ) on commit drop;

  insert into selected_requisitions_to_delete (requisition_no)
  values
    ('KEQ3-MR-00016'),
    ('KEQ3-MR-00015'),
    ('KEQ3-MR-00014'),
    ('KEQ3-MR-00013'),
    ('KEQ3-MR-00012'),
    ('KEQ3-MR-00011'),
    ('KEQ3-MR-00010'),
    ('KEQ3-MR-00007'),
    ('KEQ3-MR-00006'),
    ('KEQ3-MR-00005'),
    ('KEQ3-MR-00004');

  create temporary table affected_requisition_jobs on commit drop as
  select distinct mr.job_id
  from material_requisitions mr
  join selected_requisitions_to_delete target
    on target.requisition_no = mr.requisition_no;

  delete from material_requisitions mr
  using selected_requisitions_to_delete target
  where target.requisition_no = mr.requisition_no;

  with issued_totals as (
    select
      bom_line_id,
      sum(qty_issued_total) as qty_issued_total
    from (
      select
        coalesce(mit.source_bom_line_id, mrl.bom_line_id) as bom_line_id,
        sum(mit.qty_issued) as qty_issued_total
      from material_issue_transactions mit
      join material_requisitions mr on mr.id = mit.requisition_id
      join material_requisition_lines mrl on mrl.id = mit.requisition_line_id
      join affected_requisition_jobs affected on affected.job_id = mr.job_id
      where coalesce(mit.qty_issued, 0) > 0
        and coalesce(mr.status, '') <> 'CANCELLED'
      group by coalesce(mit.source_bom_line_id, mrl.bom_line_id)

      union all

      select
        mrl.bom_line_id,
        sum(mrl.qty_issued) as qty_issued_total
      from material_requisition_lines mrl
      join material_requisitions mr on mr.id = mrl.requisition_id
      join affected_requisition_jobs affected on affected.job_id = mr.job_id
      where coalesce(mrl.qty_issued, 0) > 0
        and coalesce(mr.status, '') <> 'CANCELLED'
        and not exists (
          select 1
          from material_issue_transactions mit
          where mit.requisition_line_id = mrl.id
        )
      group by mrl.bom_line_id
    ) issued_rows
    group by bom_line_id
  )
  update bom_lines bl
  set qty_issued = coalesce((
        select issued_totals.qty_issued_total
        from issued_totals
        where issued_totals.bom_line_id = bl.id
      ), 0),
      planning_status = case
        when coalesce((
          select issued_totals.qty_issued_total
          from issued_totals
          where issued_totals.bom_line_id = bl.id
        ), 0) >= coalesce(bl.qty_required, 0)
          and coalesce(bl.qty_required, 0) > 0 then 'ISSUED'
        when coalesce(bl.qty_received, 0) > 0 then 'PARTIALLY_RECEIVED'
        when coalesce(bl.qty_ordered, 0) > 0 then 'ORDERED'
        when coalesce(bl.qty_awarded, 0) > 0 then 'AWARDED'
        when coalesce(bl.qty_quoted, 0) > 0 then 'ON_RFQ'
        else 'PLANNED'
      end,
      updated_at = now()
  from bom_headers bh
  join affected_requisition_jobs affected
    on affected.job_id = bh.job_id
  where bh.id = bl.bom_id
    and coalesce(bh.system_key, '') <> 'UNALLOCATED';
end $$;
