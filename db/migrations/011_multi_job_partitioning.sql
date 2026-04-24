create table if not exists jobs (
  id bigserial primary key,
  job_number text not null unique,
  plant_name text not null default '',
  performance_job_number text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_jobs (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  job_id bigint not null references jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, job_id)
);

with base_job as (
  insert into jobs (job_number, plant_name, performance_job_number, is_active)
  select
    coalesce(nullif((select value from app_settings where key = 'job_number'), ''), '0000'),
    coalesce((select value from app_settings where key = 'plant_name'), ''),
    coalesce((select value from app_settings where key = 'performance_job_number'), ''),
    true
  where not exists (select 1 from jobs)
  returning id, job_number
)
insert into user_jobs (user_id, job_id)
select u.id, j.id
from users u
cross join (
  select id from base_job
  union all
  select id from jobs order by id asc limit 1
) j
on conflict (user_id, job_id) do nothing;

do $$
declare
  target_table text;
  physical_column_count integer;
  target_tables text[] := array[
    'vendors',
    'vendor_contacts',
    'material_items',
    'rfqs',
    'bom_headers',
    'bom_lines',
    'material_requisitions',
    'material_requisition_lines',
    'material_issue_transactions',
    'rfq_items',
    'rfq_vendors',
    'quotes',
    'quote_revisions',
    'material_log_lookup_values',
    'warehouses',
    'warehouse_locations',
    'import_batches',
    'purchase_orders',
    'po_lines',
    'receipts',
    'material_receiving_logs',
    'mrr_logs',
    'fmr_logs',
    'opi_logs',
    'osd_logs',
    'inventory_audit_counts',
    'inventory_audit_reports',
    'inventory_audit_report_lines',
    'inventory_adjustment_lines',
    'vendor_fmr_request_lines'
  ];
begin
  foreach target_table in array target_tables loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = target_table
        and column_name = 'job_id'
    ) then
      continue;
    end if;

    select count(*)
    into physical_column_count
    from pg_attribute
    where attrelid = to_regclass(format('public.%I', target_table))
      and attnum > 0;

    if physical_column_count >= 1600 then
      raise exception
        'Cannot add job_id to table "%": table already has % physical columns (including dropped columns).',
        target_table,
        physical_column_count
        using errcode = '54011';
    end if;

    begin
      execute format(
        'alter table %I add column if not exists job_id bigint references jobs(id) on delete cascade',
        target_table
      );
    exception
      when others then
        raise exception
          'Failed adding job_id to table "%": %',
          target_table,
          SQLERRM
          using errcode = SQLSTATE;
    end;
  end loop;
end $$;

with initial_job as (
  select id, job_number
  from jobs
  order by id asc
  limit 1
)
update vendors set job_id = (select id from initial_job) where job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update material_items set job_id = (select id from initial_job) where job_id is null;
with initial_job as (select id, job_number from jobs order by id asc limit 1)
update bom_headers bh
set job_id = coalesce(
  (select j.id from jobs j where j.job_number = bh.job_number limit 1),
  (select id from initial_job)
)
where bh.job_id is null;
update vendor_contacts vc
set job_id = v.job_id
from vendors v
where vc.vendor_id = v.id
  and vc.job_id is null;
update bom_lines bl
set job_id = bh.job_id
from bom_headers bh
where bl.bom_id = bh.id
  and bl.job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update rfqs set job_id = (select id from initial_job) where job_id is null;
update material_requisitions mr
set job_id = bh.job_id
from bom_headers bh
where mr.bom_id = bh.id
  and mr.job_id is null;
update material_requisition_lines mrl
set job_id = mr.job_id
from material_requisitions mr
where mrl.requisition_id = mr.id
  and mrl.job_id is null;
update material_issue_transactions mit
set job_id = mr.job_id
from material_requisitions mr
where mit.requisition_id = mr.id
  and mit.job_id is null;
update rfq_items ri
set job_id = r.job_id
from rfqs r
where ri.rfq_id = r.id
  and ri.job_id is null;
update rfq_vendors rv
set job_id = r.job_id
from rfqs r
where rv.rfq_id = r.id
  and rv.job_id is null;
update quotes q
set job_id = ri.job_id
from rfq_items ri
where q.rfq_item_id = ri.id
  and q.job_id is null;
update quote_revisions qr
set job_id = ri.job_id
from rfq_items ri
where qr.rfq_item_id = ri.id
  and qr.job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update material_log_lookup_values set job_id = (select id from initial_job) where job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update warehouses set job_id = (select id from initial_job) where job_id is null;
update warehouse_locations wl
set job_id = w.job_id
from warehouses w
where wl.warehouse_id = w.id
  and wl.job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update import_batches set job_id = coalesce(job_id, (select id from initial_job)) where job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update purchase_orders set job_id = coalesce(job_id, (select id from initial_job)) where job_id is null;
update po_lines pl
set job_id = po.job_id
from purchase_orders po
where pl.po_id = po.id
  and pl.job_id is null;
update receipts r
set job_id = pl.job_id
from po_lines pl
where r.po_line_id = pl.id
  and r.job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update material_receiving_logs set job_id = (select id from initial_job) where job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update mrr_logs set job_id = (select id from initial_job) where job_id is null;
update fmr_logs f
set job_id = coalesce(
  (select m.job_id from mrr_logs m where m.mrr_number = f.mrr_number and m.job_id is not null limit 1),
  (select job_id from mrr_logs m where lower(trim(coalesce(m.vendor_name, ''))) = lower(trim(coalesce(f.vendor_name, ''))) order by m.id desc limit 1),
  (select id from jobs order by id asc limit 1)
)
where f.job_id is null;
update opi_logs o
set job_id = coalesce(
  (select m.job_id from mrr_logs m where m.opi_number = o.opi_number and m.job_id is not null limit 1),
  (select m.job_id from mrr_logs m where m.mrr_number = o.mrr_number and m.job_id is not null limit 1),
  (select id from jobs order by id asc limit 1)
)
where o.job_id is null;
update osd_logs o
set job_id = coalesce(
  (select r.job_id from receipts r where r.id = o.receipt_id and r.job_id is not null limit 1),
  (select po.job_id from purchase_orders po where po.id = o.po_id and po.job_id is not null limit 1),
  (select m.job_id from mrr_logs m where m.id = o.mrr_log_id and m.job_id is not null limit 1),
  (select id from jobs order by id asc limit 1)
)
where o.job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update inventory_audit_counts set job_id = (select id from initial_job) where job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update inventory_audit_reports set job_id = (select id from initial_job) where job_id is null;
update inventory_audit_report_lines l
set job_id = r.job_id
from inventory_audit_reports r
where l.report_id = r.id
  and l.job_id is null;
update inventory_adjustment_lines l
set job_id = coalesce(
  (select r.job_id from inventory_audit_reports r where r.id = l.report_id and r.job_id is not null limit 1),
  (select id from jobs order by id asc limit 1)
)
where l.job_id is null;
with initial_job as (select id from jobs order by id asc limit 1)
update vendor_fmr_request_lines set job_id = (select id from initial_job) where job_id is null;

alter table vendors alter column job_id set not null;
alter table vendor_contacts alter column job_id set not null;
alter table material_items alter column job_id set not null;
alter table rfqs alter column job_id set not null;
alter table bom_headers alter column job_id set not null;
alter table bom_lines alter column job_id set not null;
alter table material_requisitions alter column job_id set not null;
alter table material_requisition_lines alter column job_id set not null;
alter table material_issue_transactions alter column job_id set not null;
alter table rfq_items alter column job_id set not null;
alter table rfq_vendors alter column job_id set not null;
alter table quotes alter column job_id set not null;
alter table quote_revisions alter column job_id set not null;
alter table material_log_lookup_values alter column job_id set not null;
alter table warehouses alter column job_id set not null;
alter table warehouse_locations alter column job_id set not null;
alter table import_batches alter column job_id set not null;
alter table purchase_orders alter column job_id set not null;
alter table po_lines alter column job_id set not null;
alter table receipts alter column job_id set not null;
alter table material_receiving_logs alter column job_id set not null;
alter table mrr_logs alter column job_id set not null;
alter table fmr_logs alter column job_id set not null;
alter table opi_logs alter column job_id set not null;
alter table osd_logs alter column job_id set not null;
alter table inventory_audit_counts alter column job_id set not null;
alter table inventory_audit_reports alter column job_id set not null;
alter table inventory_audit_report_lines alter column job_id set not null;
alter table inventory_adjustment_lines alter column job_id set not null;
alter table vendor_fmr_request_lines alter column job_id set not null;

alter table vendors drop constraint if exists vendors_name_key;
create unique index if not exists idx_vendors_job_name_unique on vendors (job_id, lower(name));

alter table material_items drop constraint if exists material_items_item_code_key;
create unique index if not exists idx_material_items_job_item_code_unique on material_items (job_id, item_code);

alter table rfqs drop constraint if exists rfqs_rfq_no_key;
create unique index if not exists idx_rfqs_job_rfq_no_unique on rfqs (job_id, rfq_no);

alter table bom_headers drop constraint if exists bom_headers_bom_no_key;
create unique index if not exists idx_bom_headers_job_bom_no_unique on bom_headers (job_id, bom_no);

alter table material_requisitions drop constraint if exists material_requisitions_requisition_no_key;
create unique index if not exists idx_material_requisitions_job_requisition_no_unique on material_requisitions (job_id, requisition_no);

alter table purchase_orders drop constraint if exists purchase_orders_po_no_key;
create unique index if not exists idx_purchase_orders_job_po_no_unique on purchase_orders (job_id, po_no);

alter table mrr_logs drop constraint if exists mrr_logs_mrr_number_key;
create unique index if not exists idx_mrr_logs_job_mrr_number_unique on mrr_logs (job_id, mrr_number);

alter table opi_logs drop constraint if exists opi_logs_opi_number_key;
create unique index if not exists idx_opi_logs_job_opi_number_unique on opi_logs (job_id, opi_number);

alter table material_log_lookup_values drop constraint if exists material_log_lookup_values_kind_value_key;
create unique index if not exists idx_material_log_lookup_values_job_kind_value_unique on material_log_lookup_values (job_id, kind, value);

alter table warehouses drop constraint if exists warehouses_name_key;
create unique index if not exists idx_warehouses_job_name_unique on warehouses (job_id, name);

alter table vendor_fmr_request_lines drop constraint if exists vendor_fmr_request_lines_po_number_item_code_abbrev_description_key;
create unique index if not exists idx_vendor_fmr_request_lines_job_po_item_desc_unique
on vendor_fmr_request_lines (job_id, po_number, item_code, abbrev_description);

alter table fmr_logs drop constraint if exists fmr_logs_fmr_number_container_no_fluor_id_key;
create unique index if not exists idx_fmr_logs_job_fmr_container_fluor_unique
on fmr_logs (job_id, fmr_number, container_no, fluor_id);

drop index if exists idx_inventory_audit_counts_warehouse;
drop index if exists idx_inventory_audit_counts_location;
alter table inventory_audit_counts drop constraint if exists inventory_audit_counts_item_code_size_1_size_2_thk_1_thk_2_warehouse_lo_key;
create unique index if not exists idx_inventory_audit_counts_job_lookup_unique
on inventory_audit_counts (job_id, item_code, size_1, size_2, thk_1, thk_2, warehouse, location);
create index if not exists idx_inventory_audit_counts_job_warehouse on inventory_audit_counts (job_id, warehouse);
create index if not exists idx_inventory_audit_counts_job_location on inventory_audit_counts (job_id, location);

alter table inventory_audit_reports drop constraint if exists inventory_audit_reports_report_no_key;
create unique index if not exists idx_inventory_audit_reports_job_report_no_unique on inventory_audit_reports (job_id, report_no);

create index if not exists idx_user_jobs_user_id on user_jobs(user_id);
create index if not exists idx_user_jobs_job_id on user_jobs(job_id);
create index if not exists idx_vendors_job_id on vendors(job_id);
create index if not exists idx_material_items_job_id on material_items(job_id);
create index if not exists idx_rfqs_job_id on rfqs(job_id);
create index if not exists idx_bom_headers_job_id on bom_headers(job_id);
create index if not exists idx_material_requisitions_job_id on material_requisitions(job_id);
create index if not exists idx_purchase_orders_job_id on purchase_orders(job_id);
create index if not exists idx_mrr_logs_job_id on mrr_logs(job_id);
create index if not exists idx_fmr_logs_job_id on fmr_logs(job_id);
create index if not exists idx_opi_logs_job_id on opi_logs(job_id);
create index if not exists idx_osd_logs_job_id on osd_logs(job_id);
