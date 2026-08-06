alter table sto_packages add column if not exists test_type text not null default '';
alter table sto_packages drop column if exists test;
alter table sto_packages drop column if exists type;
