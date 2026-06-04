alter table material_items add column if not exists job_id bigint;
alter table material_items add column if not exists commodity_code text not null default '';
alter table material_items add column if not exists size_1 text not null default '';
alter table material_items add column if not exists size_2 text not null default '';
alter table material_items add column if not exists thk_1 text not null default '';
alter table material_items add column if not exists thk_2 text not null default '';
alter table material_items add column if not exists notes text not null default '';
alter table material_items add column if not exists updated_at timestamptz not null default now();

update material_items
set job_id = (select min(id) from jobs)
where job_id is null
  and exists (select 1 from jobs);

create index if not exists idx_material_items_job_item_code_lower
  on material_items(job_id, lower(item_code));

create index if not exists idx_material_items_job_description
  on material_items(job_id, lower(description));

create table if not exists material_specs (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_material_specs_job_name_lower
  on material_specs(job_id, lower(name));

create table if not exists material_item_specs (
  job_id bigint not null references jobs(id) on delete cascade,
  material_item_id bigint not null references material_items(id) on delete cascade,
  spec_id bigint not null references material_specs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (material_item_id, spec_id)
);

create index if not exists idx_material_item_specs_job_spec
  on material_item_specs(job_id, spec_id);

alter table rfq_items add column if not exists item_code_snapshot text;
alter table rfq_items add column if not exists description_snapshot text;
alter table rfq_items add column if not exists material_type_snapshot text;
alter table rfq_items add column if not exists uom_snapshot text;

alter table po_lines add column if not exists item_code_snapshot text;
alter table po_lines add column if not exists description_snapshot text;
alter table po_lines add column if not exists material_type_snapshot text;
alter table po_lines add column if not exists uom_snapshot text;

update rfq_items ri
set item_code_snapshot = coalesce(ri.item_code_snapshot, mi.item_code),
    description_snapshot = coalesce(ri.description_snapshot, mi.description),
    material_type_snapshot = coalesce(ri.material_type_snapshot, mi.material_type),
    uom_snapshot = coalesce(ri.uom_snapshot, mi.uom)
from material_items mi
where mi.id = ri.material_item_id
  and (
    ri.item_code_snapshot is null
    or ri.description_snapshot is null
    or ri.material_type_snapshot is null
    or ri.uom_snapshot is null
  );

update po_lines pl
set item_code_snapshot = coalesce(pl.item_code_snapshot, mi.item_code),
    description_snapshot = coalesce(pl.description_snapshot, mi.description),
    material_type_snapshot = coalesce(pl.material_type_snapshot, mi.material_type),
    uom_snapshot = coalesce(pl.uom_snapshot, mi.uom)
from material_items mi
where mi.id = pl.material_item_id
  and (
    pl.item_code_snapshot is null
    or pl.description_snapshot is null
    or pl.material_type_snapshot is null
    or pl.uom_snapshot is null
  );

insert into material_specs (job_id, name)
select distinct source.job_id, source.spec
from (
  select bh.job_id, trim(coalesce(bl.spec, '')) as spec
  from bom_lines bl
  join bom_headers bh on bh.id = bl.bom_id
  where trim(coalesce(bl.spec, '')) <> ''
  union
  select ri.job_id, trim(coalesce(ri.spec, '')) as spec
  from rfq_items ri
  where trim(coalesce(ri.spec, '')) <> ''
) source
where source.job_id is not null
on conflict do nothing;

insert into material_item_specs (job_id, material_item_id, spec_id)
select distinct mi.job_id, mi.id, ms.id
from material_items mi
join (
  select bh.job_id, bl.item_code, trim(coalesce(bl.spec, '')) as spec
  from bom_lines bl
  join bom_headers bh on bh.id = bl.bom_id
  where trim(coalesce(bl.spec, '')) <> ''
  union
  select ri.job_id, coalesce(ri.item_code_snapshot, mi2.item_code) as item_code, trim(coalesce(ri.spec, '')) as spec
  from rfq_items ri
  join material_items mi2 on mi2.id = ri.material_item_id
  where trim(coalesce(ri.spec, '')) <> ''
) source on source.job_id = mi.job_id and lower(source.item_code) = lower(mi.item_code)
join material_specs ms on ms.job_id = source.job_id and lower(ms.name) = lower(source.spec)
where mi.job_id is not null
on conflict do nothing;
