create table if not exists users (
  id bigserial primary key,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'buyer', 'warehouse')),
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  user_id bigint references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists vendors (
  id bigserial primary key,
  name text not null unique,
  email text,
  phone text,
  categories text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists material_items (
  id bigserial primary key,
  item_code text not null unique,
  description text not null,
  material_type text not null,
  uom text not null,
  created_at timestamptz not null default now()
);

create table if not exists rfqs (
  id bigserial primary key,
  rfq_no text not null unique,
  project_name text not null,
  due_date date,
  status text not null default 'OPEN',
  created_at timestamptz not null default now()
);

create table if not exists rfq_items (
  id bigserial primary key,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  material_item_id bigint not null references material_items(id),
  size_1 text,
  size_2 text,
  thk_1 text,
  thk_2 text,
  qty numeric(18,4) not null,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists quotes (
  id bigserial primary key,
  rfq_item_id bigint not null references rfq_items(id) on delete cascade,
  vendor_id bigint not null references vendors(id),
  unit_price numeric(18,4) not null,
  lead_days integer not null default 0,
  quoted_at timestamptz not null default now(),
  unique (rfq_item_id, vendor_id)
);

create table if not exists purchase_orders (
  id bigserial primary key,
  po_no text not null unique,
  vendor_id bigint not null references vendors(id),
  rfq_id bigint references rfqs(id),
  status text not null default 'OPEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists po_lines (
  id bigserial primary key,
  po_id bigint not null references purchase_orders(id) on delete cascade,
  material_item_id bigint not null references material_items(id),
  size_1 text,
  size_2 text,
  thk_1 text,
  thk_2 text,
  qty_ordered numeric(18,4) not null,
  unit_price numeric(18,4) not null,
  updated_at timestamptz not null default now()
);

create table if not exists receipts (
  id bigserial primary key,
  po_line_id bigint not null references po_lines(id) on delete cascade,
  qty_received numeric(18,4) not null,
  warehouse text not null,
  location text not null,
  osd_status text not null,
  osd_notes text,
  received_at timestamptz not null default now()
);

create index if not exists idx_po_po_no on purchase_orders(po_no);
create index if not exists idx_po_vendor_id on purchase_orders(vendor_id);
create index if not exists idx_po_rfq_id on purchase_orders(rfq_id);
create index if not exists idx_po_status on purchase_orders(status);
