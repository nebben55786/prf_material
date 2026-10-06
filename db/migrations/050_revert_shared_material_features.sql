-- Restore the pre-shared-inventory application's database behavior.
-- Preserve all receipts, issues and shared-feature history; do not delete data.
do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname, t.tgname
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname=current_schema()
      and t.tgname in ('shared_inventory_lock','shared_inventory_balance','shared_mrr_number')
  loop
    execute format('drop trigger %I on %I.%I',r.tgname,r.nspname,r.relname);
  end loop;
  -- Dormant shared-history records must not block normal BOM/requisition deletion.
  for r in
    select n.nspname,c.relname,k.conname
    from pg_constraint k join pg_class c on c.oid=k.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_class parent on parent.oid=k.confrelid
    where k.contype='f' and n.nspname=current_schema()
      and c.relname in ('inventory_reservations','shared_inventory_movements')
      and parent.relname in ('bom_headers','material_requisitions','material_requisition_lines')
  loop
    execute format('alter table %I.%I drop constraint %I',r.nspname,r.relname,r.conname);
  end loop;
end;
$$;
