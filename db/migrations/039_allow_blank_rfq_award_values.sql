alter table quotes alter column lead_days drop not null;
alter table quotes alter column lead_days drop default;

alter table quote_revisions alter column lead_days drop not null;
alter table quote_revisions alter column lead_days drop default;

alter table po_lines add column if not exists lead_days integer;
alter table po_lines alter column unit_price drop not null;
alter table po_lines alter column lead_days drop not null;
alter table po_lines alter column lead_days drop default;
