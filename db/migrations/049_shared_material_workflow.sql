-- New MRRs use one register per explicitly configured material system.
-- Existing receiving job/PO records and historic numbering remain unchanged.
create or replace function enforce_shared_mrr_number() returns trigger language plpgsql as $$
declare target_pool bigint;
begin
  if tg_op = 'UPDATE' and new.job_id = old.job_id and lower(trim(new.mrr_number)) = lower(trim(old.mrr_number)) then
    return new;
  end if;
  perform 1 from inventory_pool_lock where id=1 for update;
  -- Let the existing (job_id,mrr_number) unique index handle exact same-job
  -- conflicts so historical import upserts can still update their original row.
  if tg_op = 'INSERT' and exists (select 1 from mrr_logs where job_id=new.job_id and mrr_number=new.mrr_number) then
    return new;
  end if;
  select pool_id into target_pool from inventory_pool_jobs where job_id=new.job_id;
  if target_pool is not null and exists (
    select 1 from mrr_logs m join inventory_pool_jobs pj on pj.job_id=m.job_id
    where pj.pool_id=target_pool and m.id<>new.id
      and lower(trim(m.mrr_number))=lower(trim(new.mrr_number))
  ) then
    raise exception 'MRR number % is already used in this material system. Choose another MRR number.', new.mrr_number;
  end if;
  return new;
end;
$$;
create trigger shared_mrr_number before insert or update of job_id, mrr_number on mrr_logs
for each row execute function enforce_shared_mrr_number();
