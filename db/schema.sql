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

create table if not exists bom_headers (
  id bigserial primary key,
  job_number text not null,
  bom_no text not null unique,
  bom_type text not null,
  area text,
  system_name text,
  notes text,
  revision text,
  status text not null default 'DRAFT',
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bom_lines (
  id bigserial primary key,
  bom_id bigint not null references bom_headers(id) on delete cascade,
  line_no text not null,
  item_code text not null,
  description text not null,
  material_type text not null default 'misc',
  uom text not null,
  qty_required numeric(18,4) not null,
  spec text,
  commodity_code text,
  tag_number text,
  size_1 text,
  size_2 text,
  thk_1 text,
  thk_2 text,
  notes text,
  planning_status text not null default 'PLANNED',
  qty_quoted numeric(18,4) not null default 0,
  qty_awarded numeric(18,4) not null default 0,
  qty_ordered numeric(18,4) not null default 0,
  qty_received numeric(18,4) not null default 0,
  qty_issued numeric(18,4) not null default 0,
  updated_at timestamptz not null default now(),
  unique (bom_id, line_no)
);

create table if not exists rfq_items (
  id bigserial primary key,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  bom_line_id bigint references bom_lines(id) on delete set null,
  material_item_id bigint not null references material_items(id),
  spec text,
  commodity_code text,
  tag_number text,
  size_1 text,
  size_2 text,
  thk_1 text,
  thk_2 text,
  qty numeric(18,4) not null,
  notes text,
  award_status text not null default 'OPEN',
  awarded_vendor_id bigint references vendors(id),
  awarded_unit_price numeric(18,4),
  awarded_lead_days integer,
  awarded_at timestamptz,
  awarded_by bigint references users(id),
  award_notes text,
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

create table if not exists quote_revisions (
  id bigserial primary key,
  rfq_item_id bigint not null references rfq_items(id) on delete cascade,
  vendor_id bigint not null references vendors(id),
  unit_price numeric(18,4) not null,
  lead_days integer not null default 0,
  source_type text not null,
  source_batch_id bigint,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists import_batches (
  id bigserial primary key,
  entity_type text not null,
  rfq_id bigint references rfqs(id) on delete cascade,
  uploaded_by bigint references users(id) on delete set null,
  filename text,
  status text not null default 'COMPLETED',
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists import_batch_errors (
  id bigserial primary key,
  batch_id bigint not null references import_batches(id) on delete cascade,
  row_number integer not null,
  error_code text not null,
  message text not null,
  raw_payload jsonb not null default '{}'::jsonb
);

create table if not exists purchase_orders (
  id bigserial primary key,
  po_no text not null unique,
  vendor_id bigint not null references vendors(id),
  rfq_id bigint references rfqs(id),
  vendor_contact text,
  freight_terms text,
  ship_to text,
  bill_to text,
  notes text,
  buyer_name text,
  status text not null default 'DRAFT',
  issued_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists po_lines (
  id bigserial primary key,
  po_id bigint not null references purchase_orders(id) on delete cascade,
  rfq_item_id bigint references rfq_items(id) on delete set null,
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

alter table rfq_items add column if not exists award_status text not null default 'OPEN';
alter table rfq_items add column if not exists bom_line_id bigint references bom_lines(id) on delete set null;
alter table rfq_items add column if not exists spec text;
alter table rfq_items add column if not exists commodity_code text;
alter table rfq_items add column if not exists tag_number text;
alter table rfq_items add column if not exists awarded_vendor_id bigint references vendors(id);
alter table rfq_items add column if not exists awarded_unit_price numeric(18,4);
alter table rfq_items add column if not exists awarded_lead_days integer;
alter table rfq_items add column if not exists awarded_at timestamptz;
alter table rfq_items add column if not exists awarded_by bigint references users(id);
alter table rfq_items add column if not exists award_notes text;
alter table po_lines add column if not exists rfq_item_id bigint references rfq_items(id) on delete set null;
alter table purchase_orders add column if not exists vendor_contact text;
alter table purchase_orders add column if not exists freight_terms text;
alter table purchase_orders add column if not exists ship_to text;
alter table purchase_orders add column if not exists bill_to text;
alter table purchase_orders add column if not exists notes text;
alter table purchase_orders add column if not exists buyer_name text;
alter table purchase_orders add column if not exists issued_at timestamptz;
alter table purchase_orders add column if not exists closed_at timestamptz;
alter table purchase_orders add column if not exists cancelled_at timestamptz;
alter table bom_headers add column if not exists system_name text;
alter table bom_headers add column if not exists notes text;
alter table bom_lines add column if not exists material_type text not null default 'misc';
alter table bom_lines add column if not exists planning_status text not null default 'PLANNED';
alter table bom_lines add column if not exists qty_quoted numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_awarded numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_ordered numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_received numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_issued numeric(18,4) not null default 0;
alter table bom_lines alter column line_no type text using line_no::text;

update po_lines pl
set rfq_item_id = ri.id
from purchase_orders po
join rfq_items ri on ri.rfq_id = po.rfq_id
where pl.po_id = po.id
  and pl.rfq_item_id is null
  and ri.material_item_id = pl.material_item_id
  and coalesce(ri.size_1, '') = coalesce(pl.size_1, '')
  and coalesce(ri.size_2, '') = coalesce(pl.size_2, '')
  and coalesce(ri.thk_1, '') = coalesce(pl.thk_1, '')
  and coalesce(ri.thk_2, '') = coalesce(pl.thk_2, '')
  and not exists (
    select 1
    from rfq_items ri2
    where ri2.rfq_id = ri.rfq_id
      and ri2.material_item_id = ri.material_item_id
      and coalesce(ri2.size_1, '') = coalesce(pl.size_1, '')
      and coalesce(ri2.size_2, '') = coalesce(pl.size_2, '')
      and coalesce(ri2.thk_1, '') = coalesce(pl.thk_1, '')
      and coalesce(ri2.thk_2, '') = coalesce(pl.thk_2, '')
      and ri2.id <> ri.id
  );

update purchase_orders
set status = case
  when status = 'OPEN' then 'ISSUED'
  when status = 'CLOSED' then 'FULLY_RECEIVED'
  else status
end
where status in ('OPEN', 'CLOSED');

create index if not exists idx_po_po_no on purchase_orders(po_no);
create index if not exists idx_po_vendor_id on purchase_orders(vendor_id);
create index if not exists idx_po_rfq_id on purchase_orders(rfq_id);
create index if not exists idx_po_status on purchase_orders(status);
create index if not exists idx_rfq_rfq_no on rfqs(rfq_no);
create index if not exists idx_rfq_project_name on rfqs(project_name);
create index if not exists idx_rfq_status on rfqs(status);
create index if not exists idx_quotes_vendor_id on quotes(vendor_id);
create index if not exists idx_quotes_rfq_item_id on quotes(rfq_item_id);
create index if not exists idx_bom_headers_bom_no on bom_headers(bom_no);
create index if not exists idx_bom_headers_job_number on bom_headers(job_number);
create index if not exists idx_bom_headers_bom_type on bom_headers(bom_type);
create index if not exists idx_bom_headers_status on bom_headers(status);
create index if not exists idx_bom_lines_bom_id on bom_lines(bom_id);
create index if not exists idx_bom_lines_item_code on bom_lines(item_code);
create index if not exists idx_bom_lines_tag_number on bom_lines(tag_number);
