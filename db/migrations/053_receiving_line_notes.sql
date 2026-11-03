-- Preserve legacy MRR notes on their linked receiving lines. Headers no longer
-- own editable notes; imported headers without lines keep them until receiving.
create or replace function move_mrr_notes_to_receiving_lines(mrr_id bigint, receiving_job_id bigint)
returns void language plpgsql as $$
declare
  legacy_notes text;
  mrr_no text;
begin
  select btrim(coalesce(notes, '')), mrr_number into legacy_notes, mrr_no
  from mrr_logs where id = mrr_id and job_id = receiving_job_id for update;
  if coalesce(legacy_notes, '') = '' then return; end if;
  if not exists (select 1 from receipts where mrr_log_id = mrr_id and job_id = receiving_job_id)
     and not exists (select 1 from material_receiving_logs where mrr_number = mrr_no and job_id = receiving_job_id)
  then return; end if;

  update receipts set osd_notes = case
    when btrim(coalesce(osd_notes, '')) = legacy_notes then legacy_notes
    else concat_ws(' | ', nullif(btrim(osd_notes), ''), legacy_notes) end
  where mrr_log_id = mrr_id and job_id = receiving_job_id;
  update material_receiving_logs set comments = case
    when btrim(coalesce(comments, '')) = legacy_notes then legacy_notes
    else concat_ws(' | ', nullif(btrim(comments), ''), legacy_notes) end
  where mrr_number = mrr_no and job_id = receiving_job_id;
  update mrr_logs set notes = '', updated_at = now()
  where id = mrr_id and job_id = receiving_job_id;
end;
$$;

select move_mrr_notes_to_receiving_lines(id, job_id) from mrr_logs where btrim(coalesce(notes, '')) <> '';

-- Keep legacy imports and first receipts consistent with the same ownership.
create or replace function transfer_legacy_mrr_notes() returns trigger language plpgsql as $$
declare linked_mrr_id bigint;
begin
  if TG_TABLE_NAME = 'mrr_logs' then
    perform move_mrr_notes_to_receiving_lines(new.id, new.job_id);
  elsif TG_TABLE_NAME = 'receipts' then
    if new.mrr_log_id is not null then
      perform move_mrr_notes_to_receiving_lines(new.mrr_log_id, new.job_id);
    end if;
  else
    for linked_mrr_id in select id from mrr_logs
      where mrr_number = new.mrr_number and job_id = new.job_id
    loop
      perform move_mrr_notes_to_receiving_lines(linked_mrr_id, new.job_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger mrr_notes_to_lines after insert or update of notes on mrr_logs
for each row execute function transfer_legacy_mrr_notes();
create trigger receipt_legacy_mrr_notes after insert or update of mrr_log_id on receipts
for each row execute function transfer_legacy_mrr_notes();
create trigger manual_receipt_legacy_mrr_notes after insert or update of mrr_number on material_receiving_logs
for each row execute function transfer_legacy_mrr_notes();
