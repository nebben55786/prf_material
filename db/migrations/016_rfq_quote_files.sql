create table if not exists rfq_quote_files (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  vendor_id bigint references vendors(id) on delete set null,
  filename text not null,
  content_type text not null default '',
  size_bytes bigint not null default 0,
  blob_url text not null,
  blob_download_url text not null default '',
  blob_pathname text not null,
  uploaded_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rfq_quote_files_rfq_id on rfq_quote_files(rfq_id);
create index if not exists idx_rfq_quote_files_job_rfq_vendor on rfq_quote_files(job_id, rfq_id, vendor_id);
