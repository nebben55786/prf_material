alter table mrr_logs add column if not exists scanned_pdf_pathname text not null default '';
alter table mrr_logs add column if not exists scanned_pdf_size_bytes bigint not null default 0;
alter table mrr_logs add column if not exists scanned_pdf_uploaded_at timestamptz;
alter table mrr_logs add column if not exists scanned_pdf_uploaded_by bigint references users(id);
