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

create table if not exists material_receiving_logs (
  id bigserial primary key,
  legacy_row_id bigint unique,
  discipline text not null default '',
  vendor_name text not null default '',
  po_number text not null default '',
  po_position text not null default '',
  purchased_by text not null default '',
  delivery_to text not null default '',
  eta_to_site text not null default '',
  company text not null default '',
  slid text not null default '',
  fluor_item_code text not null default '',
  item_code text not null default '',
  ident_code text not null default '',
  commodity_code text not null default '',
  description text not null default '',
  size_1 text not null default '',
  size_2 text not null default '',
  thk_1 text not null default '',
  thk_2 text not null default '',
  bom_qty numeric(18,4) not null default 0,
  ship_qty numeric(18,4) not null default 0,
  received_qty numeric(18,4) not null default 0,
  qty_unit text not null default '',
  fmr_number text not null default '',
  mrr_number text not null default '',
  picking_ticket text not null default '',
  opi text not null default '',
  osd_number text not null default '',
  load_no text not null default '',
  container_no text not null default '',
  load_date text not null default '',
  mir_no text not null default '',
  mir_date text not null default '',
  cwa text not null default '',
  area text not null default '',
  drawing text not null default '',
  sheet_no text not null default '',
  iso text not null default '',
  pipe_class text not null default '',
  item_type text not null default '',
  short_code text not null default '',
  received_by text not null default '',
  warehouse text not null default '',
  location text not null default '',
  recv_date text not null default '',
  received_status text not null default '',
  comments text not null default '',
  iwp text not null default '',
  package_number text not null default '',
  scope text not null default '',
  on_off_skid text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists mrr_logs (
  id bigserial primary key,
  discipline text not null default '',
  mrr_number text not null unique,
  vendor_name text not null default '',
  po_number text not null default '',
  pick_ticket text not null default '',
  material_description text not null default '',
  received_date text not null default '',
  received_by text not null default '',
  mrr_lookup text not null default '',
  client_mrr text not null default '',
  mrr_link_label text not null default '',
  mtrs_required text not null default '',
  osd_required text not null default '',
  notes text not null default '',
  blank_mrr_link_label text not null default '',
  mrr_entered text not null default '',
  pictures_loaded text not null default '',
  sent_to_matheson text not null default '',
  load_number text not null default '',
  opi_number text not null default '',
  opi_date text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fmr_logs (
  id bigserial primary key,
  fmr_number text not null default '',
  vendor_name text not null default '',
  container_no text not null default '',
  fmr_lookup text not null default '',
  request_description text not null default '',
  fluor_id text not null default '',
  fluor_desc text not null default '',
  mrr_number text not null default '',
  mr_fmr text not null default '',
  mr_opi text not null default '',
  requestor text not null default '',
  request_date text not null default '',
  need_date text not null default '',
  pick_ticket text not null default '',
  ready_to_pickup text not null default '',
  pickup_location text not null default '',
  pickup_date text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fmr_number, container_no, fluor_id)
);

create index if not exists idx_po_po_no on purchase_orders(po_no);
create index if not exists idx_po_vendor_id on purchase_orders(vendor_id);
create index if not exists idx_po_rfq_id on purchase_orders(rfq_id);
create index if not exists idx_po_status on purchase_orders(status);
create index if not exists idx_material_receiving_logs_po_number on material_receiving_logs(po_number);
create index if not exists idx_material_receiving_logs_item_code on material_receiving_logs(item_code);
create index if not exists idx_material_receiving_logs_mrr_number on material_receiving_logs(mrr_number);
create index if not exists idx_material_receiving_logs_fmr_number on material_receiving_logs(fmr_number);
create index if not exists idx_material_receiving_logs_container_no on material_receiving_logs(container_no);
create index if not exists idx_mrr_logs_mrr_number on mrr_logs(mrr_number);
create index if not exists idx_fmr_logs_fmr_number on fmr_logs(fmr_number);
create index if not exists idx_fmr_logs_container_no on fmr_logs(container_no);
