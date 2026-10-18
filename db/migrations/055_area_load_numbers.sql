create table material_load_counters (
  job_id bigint not null references jobs(id),
  prefix text not null,
  last_number bigint not null check(last_number>0),
  primary key(job_id,prefix)
);
alter table material_requisition_loads drop constraint material_requisition_loads_load_no_key;
create unique index material_requisition_loads_job_number_idx on material_requisition_loads(job_id,load_no);
