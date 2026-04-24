alter table material_requisitions add column if not exists signed_at timestamptz;
alter table material_requisitions add column if not exists signed_by_name text;
alter table material_requisitions add column if not exists signed_signature_data text;
alter table material_requisitions add column if not exists signed_copy_filename text;
alter table material_requisitions add column if not exists signed_copy_mime text;
alter table material_requisitions add column if not exists signed_copy_data bytea;
