alter table mrr_logs add column if not exists status text not null default 'ACTIVE';
alter table mrr_logs add column if not exists reversed_at timestamptz;
alter table mrr_logs add column if not exists reversed_by bigint references users(id);
