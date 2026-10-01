create table if not exists material_photos (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  process_type text not null,
  mrr_log_id bigint references mrr_logs(id) on delete cascade,
  requisition_id bigint references material_requisitions(id) on delete cascade,
  material_item_id bigint references material_items(id) on delete set null,
  caption text not null default '',
  filename text not null,
  content_type text not null default '',
  size_bytes bigint not null default 0,
  blob_url text not null default '',
  blob_download_url text not null default '',
  blob_pathname text not null,
  uploaded_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint material_photos_process_type_check check (process_type in ('receiving', 'issuing', 'item')),
  constraint material_photos_target_check check (
    (process_type = 'receiving' and mrr_log_id is not null and requisition_id is null)
    or (process_type = 'issuing' and requisition_id is not null and mrr_log_id is null)
    or (process_type = 'item' and material_item_id is not null and mrr_log_id is null and requisition_id is null)
  )
);

create index if not exists idx_material_photos_job_process on material_photos(job_id, process_type);
create index if not exists idx_material_photos_mrr on material_photos(mrr_log_id);
create index if not exists idx_material_photos_requisition on material_photos(requisition_id);
create index if not exists idx_material_photos_item on material_photos(material_item_id);
create unique index if not exists idx_material_photos_blob_pathname_unique on material_photos(blob_pathname);
