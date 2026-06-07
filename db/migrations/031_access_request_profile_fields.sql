alter table access_requests add column if not exists first_name text not null default '';
alter table access_requests add column if not exists last_name text not null default '';
alter table access_requests add column if not exists phone text not null default '';
