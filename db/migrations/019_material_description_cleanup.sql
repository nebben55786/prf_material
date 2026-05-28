create temporary table material_description_candidates (
  job_id bigint not null,
  item_code text not null,
  description text not null,
  priority integer not null
) on commit drop;

insert into material_description_candidates (job_id, item_code, description, priority)
select bh.job_id, bl.item_code, trim(bl.description), 1
from bom_lines bl
join bom_headers bh on bh.id = bl.bom_id
where coalesce(bh.system_key, '') <> 'UNALLOCATED'
  and coalesce(trim(bl.item_code), '') <> ''
  and coalesce(trim(bl.description), '') <> ''
  and lower(trim(bl.description)) <> lower(trim(bl.item_code));

insert into material_description_candidates (job_id, item_code, description, priority)
select job_id, item_code, trim(description), 2
from material_receiving_logs
where job_id is not null
  and coalesce(trim(item_code), '') <> ''
  and coalesce(trim(description), '') <> ''
  and lower(trim(description)) <> lower(trim(item_code));

insert into material_description_candidates (job_id, item_code, description, priority)
select job_id, item_code, trim(abbrev_description), 3
from vendor_fmr_request_lines
where job_id is not null
  and coalesce(trim(item_code), '') <> ''
  and coalesce(trim(abbrev_description), '') <> ''
  and lower(trim(abbrev_description)) <> lower(trim(item_code));

with best_descriptions as (
  select distinct on (job_id, lower(trim(item_code)))
    job_id,
    item_code,
    description
  from material_description_candidates
  order by job_id, lower(trim(item_code)), priority, length(description) desc
)
update material_items mi
set description = best.description
from best_descriptions best
where mi.job_id = best.job_id
  and lower(trim(mi.item_code)) = lower(trim(best.item_code))
  and (
    coalesce(trim(mi.description), '') = ''
    or lower(trim(mi.description)) = lower(trim(mi.item_code))
  );

update material_items mi
set description = ''
where coalesce(trim(mi.description), '') <> ''
  and lower(trim(mi.description)) = lower(trim(mi.item_code))
  and not exists (
    select 1
    from material_description_candidates candidate
    where candidate.job_id = mi.job_id
      and lower(trim(candidate.item_code)) = lower(trim(mi.item_code))
  );

with best_descriptions as (
  select distinct on (job_id, lower(trim(item_code)))
    job_id,
    item_code,
    description
  from (
    select job_id, item_code, trim(description) as description, 0 as priority
    from material_items
    where coalesce(trim(item_code), '') <> ''
      and coalesce(trim(description), '') <> ''
      and lower(trim(description)) <> lower(trim(item_code))
    union all
    select job_id, item_code, description, priority
    from material_description_candidates
  ) source_descriptions
  order by job_id, lower(trim(item_code)), priority, length(description) desc
),
unallocated_lines as (
  select
    bl.id,
    best.description
  from bom_lines bl
  join bom_headers bh on bh.id = bl.bom_id
  left join best_descriptions best
    on best.job_id = bh.job_id
   and lower(trim(best.item_code)) = lower(trim(bl.item_code))
  where coalesce(bh.system_key, '') = 'UNALLOCATED'
    and (
      coalesce(trim(bl.description), '') = ''
      or lower(trim(bl.description)) = lower(trim(bl.item_code))
    )
)
update bom_lines bl
set description = coalesce(unallocated_lines.description, ''),
    updated_at = now()
from unallocated_lines
where bl.id = unallocated_lines.id;
