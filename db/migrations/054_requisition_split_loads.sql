create table material_requisition_loads (
 id bigserial primary key,
 job_id bigint not null references jobs(id),
 requisition_id bigint not null references material_requisitions(id) on delete cascade,
 load_sequence integer not null check(load_sequence>0),
 load_no text not null unique,
 trailer_number text not null check(trim(trailer_number)<>''),
 status text not null default 'PLANNED' check(status in ('PLANNED','LOADED','ISSUED','CANCELLED')),
 created_by bigint references users(id), created_at timestamptz not null default now(),
 loaded_at timestamptz, issued_at timestamptz,
 signed_at timestamptz, signed_by_name text, signed_signature_data text,
 signed_copy_filename text, signed_copy_mime text, signed_copy_data bytea,
 unique(requisition_id,load_sequence)
);
create table material_requisition_load_lines (
 id bigserial primary key,
 load_id bigint not null references material_requisition_loads(id) on delete cascade,
 requisition_line_id bigint not null references material_requisition_lines(id) on delete cascade,
 qty numeric(18,4) not null check(qty>0),
 unique(load_id,requisition_line_id)
);
alter table material_issue_transactions add column load_id bigint references material_requisition_loads(id);
create index material_issue_transactions_load_idx on material_issue_transactions(load_id);
create index material_requisition_loads_parent_idx on material_requisition_loads(job_id,requisition_id);
