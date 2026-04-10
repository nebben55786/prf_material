alter table users add column if not exists first_name text not null default '';
alter table users add column if not exists last_name text not null default '';
alter table users add column if not exists email text not null default '';
alter table users add column if not exists phone text not null default '';
