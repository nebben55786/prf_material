update material_requisition_lines mrl
set qty_issued = mrl.qty_requested
from material_requisitions mr
where mr.id = mrl.requisition_id
  and mr.job_id = mrl.job_id
  and mr.status = 'VERIFIED'
  and coalesce(mrl.qty_issued, 0) = 0
  and coalesce(mrl.qty_requested, 0) > 0;
