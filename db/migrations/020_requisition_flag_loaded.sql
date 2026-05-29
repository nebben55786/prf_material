alter table material_requisitions add column if not exists flag_color text;
alter table material_requisitions add column if not exists flagged_at timestamptz;
alter table material_requisitions add column if not exists flagged_by_user_id bigint references users(id) on delete set null;
alter table material_requisitions add column if not exists trailer_number text;
alter table material_requisitions add column if not exists loaded_at timestamptz;
alter table material_requisitions add column if not exists loaded_by_user_id bigint references users(id) on delete set null;
