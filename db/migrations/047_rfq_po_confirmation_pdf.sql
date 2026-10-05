alter table rfqs add column if not exists po_confirmation_pdf_pathname text not null default '';
alter table rfqs add column if not exists po_confirmation_pdf_size_bytes bigint not null default 0;
alter table rfqs add column if not exists po_confirmation_pdf_uploaded_at timestamptz;
alter table rfqs add column if not exists po_confirmation_pdf_uploaded_by bigint references users(id);
