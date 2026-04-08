create table if not exists rfq_vendors (
  id bigserial primary key,
  rfq_id bigint not null references rfqs(id) on delete cascade,
  vendor_id bigint not null references vendors(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (rfq_id, vendor_id)
);

create index if not exists idx_rfq_vendors_rfq_id on rfq_vendors(rfq_id);
create index if not exists idx_rfq_vendors_vendor_id on rfq_vendors(vendor_id);

insert into rfq_vendors (rfq_id, vendor_id)
select distinct ri.rfq_id, q.vendor_id
from rfq_items ri
join quotes q on q.rfq_item_id = ri.id
where q.vendor_id is not null
on conflict (rfq_id, vendor_id) do nothing;

insert into rfq_vendors (rfq_id, vendor_id)
select distinct rfq_id, awarded_vendor_id
from rfq_items
where awarded_vendor_id is not null
on conflict (rfq_id, vendor_id) do nothing;
