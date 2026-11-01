alter table material_requisitions add column if not exists created_by_user_id bigint references users(id) on delete set null;
alter table material_requisitions add column if not exists created_by_name text not null default '';
update material_requisitions mr
set created_by_user_id = mr.requested_by_user_id,
    created_by_name = coalesce((select coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.username) from users u where u.id=mr.requested_by_user_id),'')
where mr.created_by_user_id is null and mr.created_by_name='';
