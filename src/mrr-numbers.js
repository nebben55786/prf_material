// A database row serializes reservations across users, forms, and server instances.
export async function reserveMrrNumber(db, jobId) {
  const row = (await db.query(`
    insert into mrr_number_counters as counter(job_id,prefix,number_width,last_number)
    select j.id,coalesce(substring(latest.mrr_number from '^(.*?)[0-9]+$'),'MRR-'),
      coalesce(length(substring(latest.mrr_number from '[0-9]+$')),6),
      coalesce(substring(latest.mrr_number from '[0-9]+$')::bigint,0)+1
    from jobs j
    left join lateral (
      select trim(mrr_number) as mrr_number from mrr_logs
      where job_id=j.id and trim(mrr_number) ~ '[0-9]+$'
      order by substring(trim(mrr_number) from '[0-9]+$')::bigint desc,id desc limit 1
    ) latest on true where j.id=$1
    on conflict(job_id) do update set
      prefix=case when excluded.last_number>counter.last_number then excluded.prefix else counter.prefix end,
      number_width=case when excluded.last_number>counter.last_number then excluded.number_width else counter.number_width end,
      last_number=greatest(counter.last_number+1,excluded.last_number)
    returning prefix,number_width,last_number
  `, [jobId])).rows[0];
  if (!row) throw Object.assign(new Error('Select a valid job before creating an MRR.'),{statusCode:400});
  return row.prefix + String(row.last_number).padStart(row.number_width,'0');
}

export async function useReservedMrrNumber(db, jobId, number) {
  // Keep the reservation lock until its MRR insert commits or rolls back.
  await db.query('select job_id from mrr_number_counters where job_id=$1 for update',[jobId]);
  const existing=(await db.query('select id from mrr_logs where job_id=$1 and lower(trim(mrr_number))=lower(trim($2::text)) limit 1',[jobId,number])).rows[0];
  if (existing) throw Object.assign(new Error('This MRR has already been posted. Open the MRR Log to review it before posting again.'),{statusCode:409});
  return number;
}
