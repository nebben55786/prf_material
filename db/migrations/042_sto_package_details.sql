alter table sto_packages add column if not exists person_assigned text not null default '';
alter table sto_packages add column if not exists spec text not null default '';
alter table sto_packages add column if not exists area text not null default '';
alter table sto_packages add column if not exists package_status text not null default '';
alter table sto_packages add column if not exists test text not null default '';
alter table sto_packages add column if not exists type text not null default '';
alter table sto_packages add column if not exists test_psig text not null default '';
