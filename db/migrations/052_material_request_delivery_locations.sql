create table delivery_locations (
 id bigserial primary key,job_id bigint not null references jobs(id),name text not null check(trim(name)<>''),
 request_prefix text not null check(trim(request_prefix)<>''),is_active boolean not null default true,
 updated_at timestamptz not null default now(),unique(job_id,id)
);
create unique index delivery_locations_job_name on delivery_locations(job_id,lower(name));
create table material_request_counters (
 job_id bigint not null references jobs(id),prefix text not null,last_number bigint not null check(last_number>0),primary key(job_id,prefix)
);
alter table material_requisitions add column delivery_location_id bigint;
alter table material_requisitions add column delivery_location_name text not null default '';
alter table material_requisitions add column request_prefix text not null default '';
alter table material_requisitions add constraint material_requisitions_delivery_job_fk foreign key(job_id,delivery_location_id) references delivery_locations(job_id,id);
