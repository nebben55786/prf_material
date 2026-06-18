create table if not exists users (
  id bigserial primary key,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'material_controller', 'buyer', 'warehouse', 'field', 'supervisor')),
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone text not null default '',
  must_change_password boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'material_controller', 'buyer', 'warehouse', 'field', 'supervisor'));

create table if not exists audit_log (
  id bigserial primary key,
  user_id bigint references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists access_requests (
  id bigserial primary key,
  first_name text not null default '',
  last_name text not null default '',
  email text not null,
  phone text not null default '',
  status text not null default 'PENDING',
  approved_by_user_id bigint references users(id) on delete set null,
  assigned_username text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_access_requests_status on access_requests(status);
alter table access_requests add column if not exists first_name text not null default '';
alter table access_requests add column if not exists last_name text not null default '';
alter table access_requests add column if not exists phone text not null default '';

create table if not exists vendors (
  id bigserial primary key,
  name text not null unique,
  contact_name text,
  website text,
  email text,
  phone text,
  is_active boolean not null default true,
  categories text not null default '',
  created_at timestamptz not null default now()
);

alter table vendors add column if not exists contact_name text;
alter table vendors add column if not exists website text;
alter table vendors add column if not exists is_active boolean not null default true;

create table if not exists vendor_contacts (
  id bigserial primary key,
  vendor_id bigint not null references vendors(id) on delete cascade,
  contact_name text not null,
  email text,
  phone text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_vendor_contacts_vendor_id on vendor_contacts(vendor_id);

create table if not exists vendor_users (
  id bigserial primary key,
  vendor_id bigint not null references vendors(id) on delete cascade,
  name text not null default '',
  email text not null unique,
  password_hash text not null,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vendor_users_vendor_id on vendor_users(vendor_id);
create index if not exists idx_vendor_users_active on vendor_users(is_active);
create unique index if not exists idx_vendor_users_email_lower_unique on vendor_users(lower(email));

create table if not exists material_items (
  id bigserial primary key,
  item_code text not null unique,
  description text not null,
  material_type text not null,
  uom text not null,
  created_at timestamptz not null default now()
);

alter table material_items add column if not exists job_id bigint;
alter table material_items add column if not exists commodity_code text not null default '';
alter table material_items add column if not exists size_1 text not null default '';
alter table material_items add column if not exists size_2 text not null default '';
alter table material_items add column if not exists thk_1 text not null default '';
alter table material_items add column if not exists thk_2 text not null default '';
alter table material_items add column if not exists notes text not null default '';
alter table material_items add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'jobs') then
    execute 'update material_items set job_id = (select min(id) from jobs) where job_id is null';
  end if;
end $$;

alter table material_items drop constraint if exists material_items_item_code_key;
create unique index if not exists idx_material_items_job_item_code_lower on material_items(job_id, lower(item_code));
create index if not exists idx_material_items_job_description on material_items(job_id, lower(description));

create table if not exists material_specs (
  id bigserial primary key,
  job_id bigint not null,
  name text not null,
  vendor_rev text not null default '',
  service_code text not null default '',
  service_description text not null default '',
  material_specification text not null default '',
  material text not null default '',
  rating text not null default '',
  specific_usage_requirements text not null default '',
  comments text not null default '',
  created_at timestamptz not null default now()
);

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

create table if not exists material_item_specs (
  job_id bigint not null,
  material_item_id bigint not null references material_items(id) on delete cascade,
  spec_id bigint not null references material_specs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (material_item_id, spec_id)
);

create index if not exists idx_material_item_specs_job_spec on material_item_specs(job_id, spec_id);

create table if not exists rfqs (
  id bigserial primary key,
  rfq_no text not null unique,
  project_name text not null,
  client_request_no text,
  po_number text,
  vendor_quote_number text,
  comments text,
  requestor_name text,
  due_date date,
  eta_date date,
  eta_date_override boolean not null default false,
  status text not null default 'SEND_FOR_QUOTES',
  created_at timestamptz not null default now()
);

alter table rfqs add column if not exists client_request_no text;
alter table rfqs add column if not exists po_number text;
alter table rfqs add column if not exists vendor_quote_number text;
alter table rfqs add column if not exists comments text;
alter table rfqs add column if not exists requestor_name text;
alter table rfqs add column if not exists eta_date date;
alter table rfqs add column if not exists eta_date_override boolean not null default false;

update rfqs
set status = case
  when status = 'OPEN' then 'SEND_FOR_QUOTES'
  when status = 'CLOSED' then 'RECEIVED'
  else status
end
where status in ('OPEN', 'CLOSED');

create table if not exists bom_headers (
  id bigserial primary key,
  job_number text not null,
  bom_no text not null unique,
  bom_name text,
  bom_type text not null,
  area text,
  system_name text,
  notes text,
  revision text,
  status text not null default 'DRAFT',
  is_system_generated boolean not null default false,
  system_key text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bom_lines (
  id bigserial primary key,
  bom_id bigint not null references bom_headers(id) on delete cascade,
  line_no text not null,
  item_code text not null,
  source_uid text generated always as (coalesce(line_no, '') || '|' || coalesce(item_code, '')) stored,
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
  iwp_no text,
  iso_no text,
  planning_status text not null default 'PLANNED',
  qty_quoted numeric(18,4) not null default 0,
  qty_awarded numeric(18,4) not null default 0,
  qty_ordered numeric(18,4) not null default 0,
  qty_received numeric(18,4) not null default 0,
  qty_issued numeric(18,4) not null default 0,
  updated_at timestamptz not null default now(),
  unique (bom_id, source_uid)
);

create table if not exists material_requisitions (
  id bigserial primary key,
  requisition_no text not null unique,
  bom_id bigint not null references bom_headers(id) on delete cascade,
  requested_by_user_id bigint references users(id) on delete set null,
  requested_by_name text not null,
  issued_to text,
  iwp_no text,
  iso_no text,
  status text not null default 'REQUESTED',
  notes text,
  verified_at timestamptz,
  verified_by_user_id bigint references users(id) on delete set null,
  issued_at timestamptz,
  issued_by_user_id bigint references users(id) on delete set null,
  flag_color text,
  flagged_at timestamptz,
  flagged_by_user_id bigint references users(id) on delete set null,
  trailer_number text,
  loaded_at timestamptz,
  loaded_by_user_id bigint references users(id) on delete set null,
  signed_at timestamptz,
  signed_by_name text,
  signed_signature_data text,
  signed_copy_filename text,
  signed_copy_mime text,
  signed_copy_data bytea,
  created_at timestamptz not null default now()
);

create table if not exists material_requisition_lines (
  id bigserial primary key,
  requisition_id bigint not null references material_requisitions(id) on delete cascade,
  bom_line_id bigint not null references bom_lines(id) on delete cascade,
  qty_requested numeric(18,4) not null,
  qty_issued numeric(18,4) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists material_issue_transactions (
  id bigserial primary key,
  requisition_id bigint not null references material_requisitions(id) on delete cascade,
  requisition_line_id bigint not null references material_requisition_lines(id) on delete cascade,
  warehouse text not null,
  location text not null,
  qty_issued numeric(18,4) not null,
  issue_source text not null default 'BOM',
  source_bom_line_id bigint references bom_lines(id) on delete set null,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table material_requisitions add column if not exists verified_at timestamptz;
alter table material_requisitions add column if not exists verified_by_user_id bigint references users(id) on delete set null;
alter table material_requisitions add column if not exists issued_to text;
alter table material_requisitions add column if not exists issued_at timestamptz;
alter table material_requisitions add column if not exists issued_by_user_id bigint references users(id) on delete set null;
alter table material_requisitions add column if not exists flag_color text;
alter table material_requisitions add column if not exists flagged_at timestamptz;
alter table material_requisitions add column if not exists flagged_by_user_id bigint references users(id) on delete set null;
alter table material_requisitions add column if not exists trailer_number text;
alter table material_requisitions add column if not exists loaded_at timestamptz;
alter table material_requisitions add column if not exists loaded_by_user_id bigint references users(id) on delete set null;
alter table material_requisitions add column if not exists signed_at timestamptz;
alter table material_requisitions add column if not exists signed_by_name text;
alter table material_requisitions add column if not exists signed_signature_data text;
alter table material_requisitions add column if not exists signed_copy_filename text;
alter table material_requisitions add column if not exists signed_copy_mime text;
alter table material_requisitions add column if not exists signed_copy_data bytea;
alter table material_requisition_lines add column if not exists qty_issued numeric(18,4) not null default 0;
alter table bom_headers add column if not exists is_system_generated boolean not null default false;
alter table bom_headers add column if not exists system_key text;
create unique index if not exists bom_headers_system_key_job_idx
  on bom_headers (job_id, system_key)
  where system_key is not null;
alter table material_issue_transactions add column if not exists issue_source text not null default 'BOM';
alter table material_issue_transactions add column if not exists source_bom_line_id bigint references bom_lines(id) on delete set null;
update material_requisitions set status = 'REQUESTED' where status = 'OPEN';

create table if not exists rfq_items (
  id bigserial primary key,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  bom_line_id bigint references bom_lines(id) on delete set null,
  material_item_id bigint not null references material_items(id),
  item_code_snapshot text,
  description_snapshot text,
  material_type_snapshot text,
  uom_snapshot text,
  po_line text,
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

create table if not exists rfq_quote_files (
  id bigserial primary key,
  job_id bigint not null,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  vendor_id bigint references vendors(id) on delete set null,
  filename text not null,
  content_type text not null default '',
  size_bytes bigint not null default 0,
  blob_url text not null,
  blob_download_url text not null default '',
  blob_pathname text not null,
  uploaded_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rfq_quote_files_rfq_id on rfq_quote_files(rfq_id);
create index if not exists idx_rfq_quote_files_job_rfq_vendor on rfq_quote_files(job_id, rfq_id, vendor_id);
create unique index if not exists idx_rfq_quote_files_blob_pathname_unique on rfq_quote_files(blob_pathname);

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

alter table bom_headers add column if not exists bom_name text;

create table if not exists material_log_lookup_values (
  id bigserial primary key,
  kind text not null,
  value text not null,
  created_at timestamptz not null default now(),
  unique (kind, value)
);

create index if not exists idx_material_log_lookup_values_kind on material_log_lookup_values(kind);

create table if not exists warehouses (
  id bigserial primary key,
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists warehouse_locations (
  id bigserial primary key,
  warehouse_id bigint not null references warehouses(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (warehouse_id, name)
);

create index if not exists idx_warehouse_locations_warehouse_id on warehouse_locations(warehouse_id);

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
  po_no text not null,
  vendor_id bigint not null references vendors(id),
  rfq_id bigint references rfqs(id),
  description text,
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
  item_code_snapshot text,
  description_snapshot text,
  material_type_snapshot text,
  uom_snapshot text,
  po_line text,
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
alter table users add column if not exists is_active boolean not null default true;
alter table users add column if not exists first_name text not null default '';
alter table users add column if not exists last_name text not null default '';
alter table users add column if not exists email text not null default '';
alter table users add column if not exists phone text not null default '';
alter table users add column if not exists must_change_password boolean not null default false;
alter table rfq_items add column if not exists bom_line_id bigint references bom_lines(id) on delete set null;
alter table rfq_items add column if not exists item_code_snapshot text;
alter table rfq_items add column if not exists description_snapshot text;
alter table rfq_items add column if not exists material_type_snapshot text;
alter table rfq_items add column if not exists uom_snapshot text;
alter table rfq_items add column if not exists po_line text;
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
alter table po_lines add column if not exists item_code_snapshot text;
alter table po_lines add column if not exists description_snapshot text;
alter table po_lines add column if not exists material_type_snapshot text;
alter table po_lines add column if not exists uom_snapshot text;
alter table po_lines add column if not exists po_line text;
alter table material_requisition_lines add column if not exists source_po_line_id bigint references po_lines(id) on delete set null;
create index if not exists idx_material_requisition_lines_source_po_line
  on material_requisition_lines(source_po_line_id)
  where source_po_line_id is not null;
alter table purchase_orders add column if not exists vendor_contact text;
alter table purchase_orders add column if not exists freight_terms text;
alter table purchase_orders add column if not exists ship_to text;
alter table purchase_orders add column if not exists bill_to text;
alter table purchase_orders add column if not exists description text;
alter table purchase_orders add column if not exists notes text;
alter table purchase_orders add column if not exists buyer_name text;
alter table purchase_orders add column if not exists issued_at timestamptz;
alter table purchase_orders add column if not exists closed_at timestamptz;
alter table purchase_orders add column if not exists cancelled_at timestamptz;
alter table bom_headers add column if not exists system_name text;
alter table bom_headers add column if not exists notes text;
alter table bom_lines add column if not exists material_type text not null default 'misc';
alter table bom_lines add column if not exists iwp_no text;
alter table bom_lines add column if not exists iso_no text;
alter table bom_lines add column if not exists planning_status text not null default 'PLANNED';
alter table bom_lines add column if not exists qty_quoted numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_awarded numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_ordered numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_received numeric(18,4) not null default 0;
alter table bom_lines add column if not exists qty_issued numeric(18,4) not null default 0;
drop index if exists idx_bom_lines_bom_source_uid;
alter table bom_lines drop constraint if exists bom_lines_bom_id_line_no_key;
alter table bom_lines drop constraint if exists bom_lines_bom_id_source_uid_key;
alter table bom_lines drop column if exists source_uid;
alter table bom_lines alter column line_no type text using line_no::text;
alter table bom_lines add column if not exists source_uid text generated always as (coalesce(line_no, '') || '|' || coalesce(item_code, '')) stored;
create unique index if not exists idx_bom_lines_bom_source_uid on bom_lines(bom_id, source_uid);

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

update rfq_items ri
set item_code_snapshot = coalesce(ri.item_code_snapshot, mi.item_code),
    description_snapshot = coalesce(ri.description_snapshot, mi.description),
    material_type_snapshot = coalesce(ri.material_type_snapshot, mi.material_type),
    uom_snapshot = coalesce(ri.uom_snapshot, mi.uom)
from material_items mi
where mi.id = ri.material_item_id
  and (
    ri.item_code_snapshot is null
    or ri.description_snapshot is null
    or ri.material_type_snapshot is null
    or ri.uom_snapshot is null
  );

update po_lines pl
set item_code_snapshot = coalesce(pl.item_code_snapshot, mi.item_code),
    description_snapshot = coalesce(pl.description_snapshot, mi.description),
    material_type_snapshot = coalesce(pl.material_type_snapshot, mi.material_type),
    uom_snapshot = coalesce(pl.uom_snapshot, mi.uom)
from material_items mi
where mi.id = pl.material_item_id
  and (
    pl.item_code_snapshot is null
    or pl.description_snapshot is null
    or pl.material_type_snapshot is null
    or pl.uom_snapshot is null
  );

insert into material_specs (job_id, name, material_specification)
select distinct source.job_id, source.spec, source.spec
from (
  select bh.job_id, trim(coalesce(bl.spec, '')) as spec
  from bom_lines bl
  join bom_headers bh on bh.id = bl.bom_id
  where trim(coalesce(bl.spec, '')) <> ''
  union
  select ri.job_id, trim(coalesce(ri.spec, '')) as spec
  from rfq_items ri
  where trim(coalesce(ri.spec, '')) <> ''
) source
where source.job_id is not null
on conflict do nothing;

insert into material_item_specs (job_id, material_item_id, spec_id)
select distinct mi.job_id, mi.id, ms.id
from material_items mi
join (
  select bh.job_id, bl.item_code, trim(coalesce(bl.spec, '')) as spec
  from bom_lines bl
  join bom_headers bh on bh.id = bl.bom_id
  where trim(coalesce(bl.spec, '')) <> ''
  union
  select ri.job_id, coalesce(ri.item_code_snapshot, mi2.item_code) as item_code, trim(coalesce(ri.spec, '')) as spec
  from rfq_items ri
  join material_items mi2 on mi2.id = ri.material_item_id
  where trim(coalesce(ri.spec, '')) <> ''
) source on source.job_id = mi.job_id and lower(source.item_code) = lower(mi.item_code)
join material_specs ms on ms.job_id = source.job_id
  and lower(coalesce(ms.material_specification, ms.name)) = lower(source.spec)
on conflict do nothing;

update purchase_orders
set status = case
  when status = 'OPEN' then 'ISSUED'
  when status = 'CLOSED' then 'FULLY_RECEIVED'
  else status
end
where status in ('OPEN', 'CLOSED');

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
  app_po_id bigint references purchase_orders(id) on delete set null,
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

create table if not exists opi_logs (
  id bigserial primary key,
  opi_number text not null unique,
  vendor_name text not null default '',
  material_description text not null default '',
  load_number text not null default '',
  mrr_number text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists osd_logs (
  id bigserial primary key,
  osd_number text not null default '',
  mrr_log_id bigint references mrr_logs(id) on delete set null,
  receipt_id bigint references receipts(id) on delete set null,
  po_id bigint references purchase_orders(id) on delete set null,
  po_line_id bigint references po_lines(id) on delete set null,
  mrr_number text not null default '',
  po_number text not null default '',
  item_code text not null default '',
  description text not null default '',
  warehouse text not null default '',
  location text not null default '',
  expected_qty numeric(18,4) not null default 0,
  received_qty numeric(18,4) not null default 0,
  osd_qty numeric(18,4) not null default 0,
  osd_status text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table mrr_logs add column if not exists app_po_id bigint references purchase_orders(id) on delete set null;
alter table mrr_logs add column if not exists status text not null default 'ACTIVE';
alter table mrr_logs add column if not exists reversed_at timestamptz;
alter table mrr_logs add column if not exists reversed_by bigint references users(id);

alter table receipts add column if not exists mrr_log_id bigint references mrr_logs(id) on delete set null;
alter table osd_logs add column if not exists osd_number text not null default '';

create index if not exists idx_po_po_no on purchase_orders(po_no);
create index if not exists idx_po_vendor_id on purchase_orders(vendor_id);
create index if not exists idx_po_rfq_id on purchase_orders(rfq_id);
create index if not exists idx_po_status on purchase_orders(status);
create index if not exists idx_rfq_rfq_no on rfqs(rfq_no);
create index if not exists idx_rfq_project_name on rfqs(project_name);
create index if not exists idx_rfq_status on rfqs(status);
create index if not exists idx_rfqs_job_id_desc on rfqs(job_id, id desc);
create index if not exists idx_rfqs_job_status_id_desc on rfqs(job_id, status, id desc);
create index if not exists idx_rfqs_job_requestor_name on rfqs(job_id, trim(coalesce(requestor_name, '')));
create index if not exists idx_quotes_vendor_id on quotes(vendor_id);
create index if not exists idx_quotes_rfq_item_id on quotes(rfq_item_id);
create index if not exists idx_rfq_items_job_rfq_id on rfq_items(job_id, rfq_id);
create index if not exists idx_rfq_items_job_material_item_id on rfq_items(job_id, material_item_id);
create index if not exists idx_rfq_items_awarded_lookup
  on rfq_items(job_id, rfq_id, awarded_vendor_id)
  where award_status = 'AWARDED' and awarded_vendor_id is not null;
create index if not exists idx_purchase_orders_job_rfq_id on purchase_orders(job_id, rfq_id);
create index if not exists idx_purchase_orders_job_id_desc on purchase_orders(job_id, id desc);
create index if not exists idx_po_lines_job_po_id on po_lines(job_id, po_id);
create index if not exists idx_po_lines_job_rfq_item_id on po_lines(job_id, rfq_item_id);
create index if not exists idx_receipts_job_po_line_id on receipts(job_id, po_line_id);
create index if not exists idx_receipts_job_mrr_log_id on receipts(job_id, mrr_log_id);
create index if not exists idx_import_batches_job_rfq_id_desc on import_batches(job_id, rfq_id, id desc);
create index if not exists idx_material_items_job_item_code on material_items(job_id, item_code);
create index if not exists idx_mrr_logs_job_id_desc on mrr_logs(job_id, id desc);
create index if not exists idx_fmr_logs_job_id_desc on fmr_logs(job_id, id desc);
create index if not exists idx_bom_headers_bom_no on bom_headers(bom_no);
create index if not exists idx_bom_headers_job_number on bom_headers(job_number);
create index if not exists idx_bom_headers_bom_type on bom_headers(bom_type);
create index if not exists idx_bom_headers_status on bom_headers(status);
create index if not exists idx_bom_lines_bom_id on bom_lines(bom_id);
create index if not exists idx_bom_lines_item_code on bom_lines(item_code);
create index if not exists idx_bom_lines_tag_number on bom_lines(tag_number);
create index if not exists idx_material_receiving_logs_po_number on material_receiving_logs(po_number);
create index if not exists idx_material_receiving_logs_item_code on material_receiving_logs(item_code);
create index if not exists idx_material_receiving_logs_mrr_number on material_receiving_logs(mrr_number);
create index if not exists idx_material_receiving_logs_fmr_number on material_receiving_logs(fmr_number);
create index if not exists idx_material_receiving_logs_container_no on material_receiving_logs(container_no);
create index if not exists idx_mrr_logs_mrr_number on mrr_logs(mrr_number);
create index if not exists idx_fmr_logs_fmr_number on fmr_logs(fmr_number);
create index if not exists idx_fmr_logs_container_no on fmr_logs(container_no);
create index if not exists idx_opi_logs_opi_number on opi_logs(opi_number);
create index if not exists idx_opi_logs_mrr_number on opi_logs(mrr_number);
create index if not exists idx_osd_logs_mrr_number on osd_logs(mrr_number);
create index if not exists idx_osd_logs_po_id on osd_logs(po_id);
create index if not exists idx_osd_logs_po_line_id on osd_logs(po_line_id);
create unique index if not exists idx_osd_logs_job_osd_number_unique on osd_logs(job_id, osd_number) where coalesce(osd_number, '') <> '';
