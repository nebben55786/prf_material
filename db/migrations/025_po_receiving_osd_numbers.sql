alter table osd_logs add column if not exists osd_number text not null default '';

with numbered as (
  select
    id,
    'OSD-' || lpad((row_number() over (partition by job_id order by id))::text, 6, '0') as next_osd_number
  from osd_logs
  where coalesce(osd_number, '') = ''
)
update osd_logs o
set osd_number = numbered.next_osd_number
from numbered
where o.id = numbered.id;

create unique index if not exists idx_osd_logs_job_osd_number_unique
  on osd_logs(job_id, osd_number)
  where coalesce(osd_number, '') <> '';

create index if not exists idx_osd_logs_job_status
  on osd_logs(job_id, osd_status);
