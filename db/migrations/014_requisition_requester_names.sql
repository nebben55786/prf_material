update material_requisitions mr
set requested_by_name = trim(concat_ws(' ', u.first_name, u.last_name))
from users u
where mr.requested_by_user_id = u.id
  and trim(concat_ws(' ', u.first_name, u.last_name)) <> ''
  and coalesce(mr.requested_by_name, '') <> trim(concat_ws(' ', u.first_name, u.last_name));
