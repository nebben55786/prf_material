alter table rfqs add column if not exists eta_date date;
alter table rfqs add column if not exists eta_date_override boolean not null default false;
