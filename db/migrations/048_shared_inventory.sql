-- Explicit opt-in inventory sharing. Existing jobs and receipts remain independent.
create table inventory_pool_lock (id integer primary key check(id=1));
insert into inventory_pool_lock values(1);
create table inventory_pools (
 id bigserial primary key,name text not null unique check(trim(name)<>''),created_by bigint references users(id),created_at timestamptz not null default now()
);
create table inventory_pool_jobs (
 job_id bigint primary key references jobs(id),pool_id bigint not null references inventory_pools(id),
 reviewed_by bigint not null references users(id),reviewed_at timestamptz not null default now(),unique(pool_id,job_id)
);
create table inventory_pool_materials (
 id bigserial primary key,pool_id bigint not null references inventory_pools(id),name text not null check(trim(name)<>''),
 uom text not null check(trim(uom)<>''),spec text not null default '',size_1 text not null default '',size_2 text not null default '',thk_1 text not null default '',thk_2 text not null default '',
 unique(pool_id,id),unique(pool_id,name)
);
create table inventory_pool_matches (
 id bigserial primary key,pool_id bigint not null,job_id bigint not null,material_id bigint not null,item_code text not null,uom text not null,spec text not null default '',
 size_1 text not null default '',size_2 text not null default '',thk_1 text not null default '',thk_2 text not null default '',
 reviewed_by bigint not null references users(id),reviewed_at timestamptz not null default now(),
 foreign key(pool_id,job_id) references inventory_pool_jobs(pool_id,job_id),
 foreign key(pool_id,material_id) references inventory_pool_materials(pool_id,id),
 unique(job_id,item_code,uom,spec,size_1,size_2,thk_1,thk_2),unique(material_id,job_id)
);
create table inventory_reservations (
 id bigserial primary key,pool_id bigint not null,material_id bigint not null,job_id bigint not null references jobs(id),purpose text not null default '',
 bom_id bigint references bom_headers(id),requisition_id bigint references material_requisitions(id),
 qty_remaining numeric(18,4) not null check(qty_remaining>=0),created_by bigint not null references users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(pool_id,material_id) references inventory_pool_materials(pool_id,id)
);
alter table material_requisition_lines add column inventory_reservation_id bigint references inventory_reservations(id);
create index inventory_reservations_material_idx on inventory_reservations(material_id) where qty_remaining>0;
create table shared_inventory_movements (
 id bigserial primary key,pool_id bigint not null references inventory_pools(id),material_id bigint references inventory_pool_materials(id),
 source_job_id bigint not null references jobs(id),destination_job_id bigint not null references jobs(id),
 item_code text not null,uom text not null,spec text not null default '',size_1 text not null default '',size_2 text not null default '',thk_1 text not null default '',thk_2 text not null default '',
 warehouse text not null,location text not null,requisition_id bigint not null references material_requisitions(id),requisition_line_id bigint not null references material_requisition_lines(id),
 reservation_id bigint references inventory_reservations(id),qty_issued numeric(18,4) not null check(qty_issued>0),qty_returned numeric(18,4) not null default 0 check(qty_returned>=0 and qty_returned<=qty_issued),
 created_by bigint not null references users(id),created_at timestamptz not null default now()
);
create index shared_inventory_movements_source_idx on shared_inventory_movements(source_job_id);
create index shared_inventory_movements_req_idx on shared_inventory_movements(requisition_id);
create table inventory_reservation_events (
 id bigserial primary key,reservation_id bigint references inventory_reservations(id),movement_id bigint references shared_inventory_movements(id),action text not null,
 qty numeric(18,4) not null,details text not null default '',created_by bigint not null references users(id),created_at timestamptz not null default now()
);
alter table material_issue_transactions add column shared_movement_id bigint references shared_inventory_movements(id);
create unique index material_issue_transactions_shared_idx on material_issue_transactions(shared_movement_id) where shared_movement_id is not null;
create view shared_inventory_item_metadata as
select mi.*,coalesce((select case when count(distinct ms.material_specification)=1 then max(ms.material_specification)
 when count(*)>1 then '[AMBIGUOUS SPEC]' else '' end from material_item_specs mis join material_specs ms on ms.id=mis.spec_id where mis.material_item_id=mi.id),'') as inventory_spec
from material_items mi;
create view shared_inventory_owned_stock as
select job_id,item_code,uom,spec,size_1,size_2,thk_1,thk_2,warehouse,location,max(description) as description,sum(qty) as qty_on_hand,sum(qty_osd) as qty_osd
from (
 select r.job_id,coalesce(nullif(pl.item_code_snapshot,''),mi.item_code) as item_code,upper(trim(coalesce(nullif(pl.uom_snapshot,''),mi.uom))) as uom,
 trim(coalesce(nullif(ri.spec,''),mi.inventory_spec,'')) as spec,
 trim(coalesce(pl.size_1,'')) as size_1,trim(coalesce(pl.size_2,'')) as size_2,trim(coalesce(pl.thk_1,'')) as thk_1,trim(coalesce(pl.thk_2,'')) as thk_2,
 initcap(lower(coalesce(r.warehouse,''))) as warehouse,upper(coalesce(r.location,'')) as location,coalesce(nullif(pl.description_snapshot,''),mi.description) as description,
 case when upper(coalesce(r.osd_status,'OK')) in ('OK','OVERAGE','SHORTAGE','BACKORDER','NOT ON THIS LOAD') then r.qty_received else 0 end as qty,
 case when upper(coalesce(r.osd_status,'OK')) in ('OK','OVERAGE','SHORTAGE','BACKORDER','NOT ON THIS LOAD') then 0 else r.qty_received end as qty_osd
 from receipts r join po_lines pl on pl.id=r.po_line_id join shared_inventory_item_metadata mi on mi.id=pl.material_item_id left join rfq_items ri on ri.id=pl.rfq_item_id
 union all
 select a.job_id,a.item_code,upper(trim(coalesce(mi.uom,''))),coalesce(mi.inventory_spec,''),
 trim(coalesce(a.size_1,'')),trim(coalesce(a.size_2,'')),trim(coalesce(a.thk_1,'')),trim(coalesce(a.thk_2,'')),initcap(lower(a.warehouse)),upper(a.location),a.description,a.qty_adjustment,0
 from inventory_adjustment_lines a left join shared_inventory_item_metadata mi on mi.job_id=a.job_id and lower(mi.item_code)=lower(a.item_code)
 union all
 select mit.job_id,bl.item_code,upper(trim(bl.uom)),trim(coalesce(bl.spec,'')),trim(coalesce(bl.size_1,'')),trim(coalesce(bl.size_2,'')),trim(coalesce(bl.thk_1,'')),trim(coalesce(bl.thk_2,'')),
 initcap(lower(mit.warehouse)),upper(mit.location),bl.description,-mit.qty_issued,0
 from material_issue_transactions mit join material_requisitions mr on mr.id=mit.requisition_id join material_requisition_lines mrl on mrl.id=mit.requisition_line_id
 join bom_lines bl on bl.id=coalesce(mit.source_bom_line_id,mrl.bom_line_id)
 where mit.shared_movement_id is null and mr.status<>'CANCELLED'
 union all
 select mr.job_id,bl.item_code,upper(trim(bl.uom)),trim(coalesce(bl.spec,'')),trim(coalesce(bl.size_1,'')),trim(coalesce(bl.size_2,'')),trim(coalesce(bl.thk_1,'')),trim(coalesce(bl.thk_2,'')),
 '','',bl.description,-mrl.qty_issued,0
 from material_requisition_lines mrl join material_requisitions mr on mr.id=mrl.requisition_id join bom_lines bl on bl.id=mrl.bom_line_id
 where mr.status in ('ISSUED','CLOSED') and not exists(select 1 from material_issue_transactions mit where mit.requisition_line_id=mrl.id)
 union all
 select source_job_id,item_code,uom,spec,size_1,size_2,thk_1,thk_2,warehouse,location,'',-(qty_issued-qty_returned),0 from shared_inventory_movements
) stock group by job_id,item_code,uom,spec,size_1,size_2,thk_1,thk_2,warehouse,location;
-- All stock mutations use the same transaction lock, including existing receiving and audit routes.
create function lock_shared_inventory() returns trigger language plpgsql as $$
begin
 perform id from inventory_pool_lock where id=1 for update;
 perform set_config('prf.shared_stock_checked','no',true);
 return null;
end $$;
do $$ declare t text; begin
 foreach t in array array['inventory_pool_jobs','inventory_pool_materials','inventory_pool_matches','inventory_reservations','shared_inventory_movements','receipts','inventory_adjustment_lines','material_issue_transactions','material_requisition_lines','material_requisitions','bom_lines','po_lines','rfq_items','material_items','material_specs','material_item_specs']
 loop execute format('create trigger shared_inventory_lock before insert or update or delete on %I for each statement execute function lock_shared_inventory()',t); end loop;
end $$;
-- Deferred validation protects reservations when legacy receipt reversals or audits reduce stock.
create function check_shared_inventory_balances() returns trigger language plpgsql as $$
declare mat record; line record; reservation record; stock_qty numeric; held numeric; needed numeric; used numeric; credits jsonb;
begin
 if current_setting('prf.shared_stock_checked',true)='yes' then return null; end if;
 for mat in select * from inventory_pool_materials loop
   select coalesce(sum(s.qty_on_hand),0) into stock_qty from shared_inventory_owned_stock s join inventory_pool_matches m
     on m.job_id=s.job_id and m.item_code=s.item_code and m.uom=s.uom and m.spec=s.spec
     and m.size_1=s.size_1 and m.size_2=s.size_2 and m.thk_1=s.thk_1 and m.thk_2=s.thk_2 where m.material_id=mat.id;
   select coalesce(sum(qty_remaining),0),coalesce(jsonb_object_agg(id::text,qty_remaining),'{}'::jsonb) into held,credits
     from inventory_reservations where material_id=mat.id and qty_remaining>0;
   for line in select mr.job_id,mr.id as requisition_id,bl.bom_id,mrl.qty_requested,mrl.inventory_reservation_id
     from material_requisition_lines mrl join material_requisitions mr on mr.id=mrl.requisition_id join bom_lines bl on bl.id=mrl.bom_line_id
     join inventory_pool_matches m on m.job_id=mr.job_id and m.item_code=trim(bl.item_code) and m.uom=upper(trim(bl.uom)) and m.spec=trim(coalesce(bl.spec,''))
       and m.size_1=trim(coalesce(bl.size_1,'')) and m.size_2=trim(coalesce(bl.size_2,'')) and m.thk_1=trim(coalesce(bl.thk_1,'')) and m.thk_2=trim(coalesce(bl.thk_2,''))
     where m.material_id=mat.id and mr.status in ('ACCEPTED','VERIFIED','FLAGGED','LOADED') order by mr.id,mrl.id
   loop
     needed:=line.qty_requested;
     for reservation in select * from inventory_reservations r where r.material_id=mat.id and r.qty_remaining>0 and r.job_id=line.job_id
       and (r.requisition_id is null or r.requisition_id=line.requisition_id) and (r.bom_id is null or r.bom_id=line.bom_id)
       and (trim(r.purpose)='' or r.requisition_id is not null or r.bom_id is not null or r.id=line.inventory_reservation_id)
       order by r.created_at,r.id
     loop
       used:=least(needed,coalesce((credits->>reservation.id::text)::numeric,0));
       needed:=needed-used;
       credits:=jsonb_set(credits,array[reservation.id::text],to_jsonb(coalesce((credits->>reservation.id::text)::numeric,0)-used));
     end loop;
     held:=held+needed;
   end loop;
   if stock_qty<held then raise exception 'Stock change would consume reserved material or accepted requisition holds. Release or reassign reservations first.'; end if;
 end loop;
 perform set_config('prf.shared_stock_checked','yes',true);
 return null;
end $$;
do $$ declare t text; begin
 foreach t in array array['receipts','inventory_adjustment_lines','material_issue_transactions','material_requisition_lines','material_requisitions','shared_inventory_movements','inventory_reservations','inventory_pool_matches']
 loop execute format('create constraint trigger shared_inventory_balance after insert or update or delete on %I deferrable initially deferred for each row execute function check_shared_inventory_balances()',t); end loop;
end $$;

