alter table po_lines add column if not exists lead_days integer not null default 0;
