create table if not exists rfq_sto_packages (
  id bigserial primary key,
  job_id bigint not null,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  sto_package_number text not null,
  sto_package_due_date date,
  created_by bigint references users(id) on delete set null,
  updated_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_rfq_sto_packages_job_rfq_package_unique
  on rfq_sto_packages(job_id, rfq_id, lower(sto_package_number));

create index if not exists idx_rfq_sto_packages_job_package
  on rfq_sto_packages(job_id, lower(sto_package_number), sto_package_due_date);

create index if not exists idx_rfq_sto_packages_job_rfq
  on rfq_sto_packages(job_id, rfq_id);
