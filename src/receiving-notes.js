// Receiving lines own notes; an MRR only summarizes its linked lines.
export function mrrReceivingNotesSql(alias = "m") {
  return `coalesce((
    select string_agg(distinct nullif(btrim(line_notes.notes), ''), ' | ' order by nullif(btrim(line_notes.notes), ''))
    from (
      select r.osd_notes as notes from receipts r
      where r.mrr_log_id = ${alias}.id and r.job_id = ${alias}.job_id
      union all
      select l.comments as notes from material_receiving_logs l
      where l.mrr_number = ${alias}.mrr_number and l.job_id = ${alias}.job_id
    ) line_notes
  ), '')`;
}
