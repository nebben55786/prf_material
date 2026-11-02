create table if not exists inventory_location_moves (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  item_code text not null, description text not null default '',
  size_1 text not null default '', size_2 text not null default '',
  thk_1 text not null default '', thk_2 text not null default '',
  from_warehouse text not null, from_location text not null,
  to_warehouse text not null, to_location text not null,
  qty numeric(18,4) not null default 0 check(qty>=0),
  qty_osd numeric(18,4) not null default 0 check(qty_osd>=0),
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check(qty>0 or qty_osd>0)
);
create index if not exists inventory_location_moves_job on inventory_location_moves(job_id);
