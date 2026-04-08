create table if not exists inventory_audit_reports (
  id bigserial primary key,
  report_no text not null unique,
  created_by bigint references users(id) on delete set null,
  warehouse_filter text not null default '',
  location_filter text not null default '',
  ident_filter text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists inventory_audit_report_lines (
  id bigserial primary key,
  report_id bigint not null references inventory_audit_reports(id) on delete cascade,
  item_code text not null default '',
  description text not null default '',
  size_1 text not null default '',
  size_2 text not null default '',
  thk_1 text not null default '',
  thk_2 text not null default '',
  warehouse text not null default '',
  location text not null default '',
  book_qty numeric(18,4) not null default 0,
  actual_qty numeric(18,4) not null default 0,
  adjustment_qty numeric(18,4) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists inventory_adjustment_lines (
  id bigserial primary key,
  report_id bigint references inventory_audit_reports(id) on delete set null,
  report_line_id bigint references inventory_audit_report_lines(id) on delete set null,
  item_code text not null default '',
  description text not null default '',
  size_1 text not null default '',
  size_2 text not null default '',
  thk_1 text not null default '',
  thk_2 text not null default '',
  warehouse text not null default '',
  location text not null default '',
  qty_adjustment numeric(18,4) not null default 0,
  reason text not null default 'INVENTORY AUDIT',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inventory_audit_report_lines_report_id
on inventory_audit_report_lines (report_id);

create index if not exists idx_inventory_adjustment_lines_report_id
on inventory_adjustment_lines (report_id);

create index if not exists idx_inventory_adjustment_lines_lookup
on inventory_adjustment_lines (item_code, warehouse, location);
