alter table material_specs add column if not exists service_code text not null default '';
alter table material_specs add column if not exists service_description text not null default '';
alter table material_specs add column if not exists material_specification text not null default '';
alter table material_specs add column if not exists material text not null default '';
alter table material_specs add column if not exists rating text not null default '';
alter table material_specs add column if not exists specific_usage_requirements text not null default '';
alter table material_specs add column if not exists comments text not null default '';

update material_specs
set material_specification = name
where coalesce(material_specification, '') = ''
  and coalesce(name, '') <> '';

drop index if exists idx_material_specs_job_name_lower;

create unique index if not exists idx_material_specs_job_service_spec_lower
  on material_specs(job_id, lower(service_code), lower(material_specification));
