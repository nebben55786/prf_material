create table if not exists inventory_audit_counts (
  id bigserial primary key,
  item_code text not null default '',
  description text not null default '',
  size_1 text not null default '',
  size_2 text not null default '',
  thk_1 text not null default '',
  thk_2 text not null default '',
  warehouse text not null default '',
  location text not null default '',
  actual_qty numeric(18,4) not null default 0,
  updated_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_code, size_1, size_2, thk_1, thk_2, warehouse, location)
);

create index if not exists idx_inventory_audit_counts_warehouse
on inventory_audit_counts (warehouse);

create index if not exists idx_inventory_audit_counts_location
on inventory_audit_counts (location);
