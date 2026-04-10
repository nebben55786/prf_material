create table if not exists material_issue_transactions (
  id bigserial primary key,
  requisition_id bigint not null references material_requisitions(id) on delete cascade,
  requisition_line_id bigint not null references material_requisition_lines(id) on delete cascade,
  warehouse text not null,
  location text not null,
  qty_issued numeric(18,4) not null,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists material_issue_transactions_requisition_id_idx
  on material_issue_transactions (requisition_id);

create index if not exists material_issue_transactions_requisition_line_id_idx
  on material_issue_transactions (requisition_line_id);

create index if not exists material_issue_transactions_location_idx
  on material_issue_transactions (warehouse, location);
