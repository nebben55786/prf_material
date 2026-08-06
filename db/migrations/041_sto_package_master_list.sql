create table if not exists sto_packages (
  id bigserial primary key,
  job_id bigint not null,
  sto_package_number text not null,
  sto_package_due_date date,
  created_by bigint references users(id) on delete set null,
  updated_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table rfq_sto_packages add column if not exists sto_package_id bigint references sto_packages(id) on delete cascade;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'rfq_sto_packages_sto_package_id_fkey'
  ) then
    alter table rfq_sto_packages
      add constraint rfq_sto_packages_sto_package_id_fkey
      foreign key (sto_package_id) references sto_packages(id) on delete cascade;
  end if;
end $$;

insert into sto_packages (job_id, sto_package_number, sto_package_due_date)
select source.job_id, source.sto_package_number, max(source.sto_package_due_date) as sto_package_due_date
from (
  select distinct job_id, sto_package_number, sto_package_due_date
  from rfq_sto_packages
  where coalesce(sto_package_number, '') <> ''
) source
where not exists (
  select 1
  from sto_packages sp
  where sp.job_id = source.job_id
    and lower(sp.sto_package_number) = lower(source.sto_package_number)
)
group by source.job_id, source.sto_package_number;

update rfq_sto_packages link
set sto_package_id = sp.id
from sto_packages sp
where link.sto_package_id is null
  and sp.job_id = link.job_id
  and lower(sp.sto_package_number) = lower(link.sto_package_number);

create unique index if not exists idx_sto_packages_job_package_unique
  on sto_packages(job_id, lower(sto_package_number));

create index if not exists idx_sto_packages_job_due_date
  on sto_packages(job_id, sto_package_due_date, lower(sto_package_number));

create unique index if not exists idx_rfq_sto_packages_job_rfq_package_id_unique
  on rfq_sto_packages(job_id, rfq_id, sto_package_id)
  where sto_package_id is not null;
