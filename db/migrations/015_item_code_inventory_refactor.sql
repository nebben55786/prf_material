alter table bom_headers add column if not exists is_system_generated boolean not null default false;
alter table bom_headers add column if not exists system_key text;

create unique index if not exists bom_headers_system_key_job_idx
  on bom_headers (job_id, system_key)
  where system_key is not null;

alter table material_issue_transactions add column if not exists issue_source text not null default 'BOM';
alter table material_issue_transactions add column if not exists source_bom_line_id bigint references bom_lines(id) on delete set null;

update material_issue_transactions
set issue_source = 'BOM'
where coalesce(issue_source, '') = '';

update material_issue_transactions mit
set source_bom_line_id = mrl.bom_line_id
from material_requisition_lines mrl
where mit.requisition_line_id = mrl.id
  and mit.source_bom_line_id is null;
