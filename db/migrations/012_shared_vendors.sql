do $$
begin
  create temp table tmp_global_vendor_dedupe_map on commit drop as
  with ranked_vendors as (
    select
      id,
      lower(trim(name)) as normalized_name,
      row_number() over (
        partition by lower(trim(name))
        order by
          case when is_active then 0 else 1 end,
          id asc
      ) as vendor_rank,
      first_value(id) over (
        partition by lower(trim(name))
        order by
          case when is_active then 0 else 1 end,
          id asc
      ) as keep_vendor_id
    from vendors
    where coalesce(trim(name), '') <> ''
  )
  select id as duplicate_vendor_id, keep_vendor_id
  from ranked_vendors
  where vendor_rank > 1;

  if exists (select 1 from tmp_global_vendor_dedupe_map) then
    update vendor_contacts vc
    set vendor_id = m.keep_vendor_id
    from tmp_global_vendor_dedupe_map m
    where vc.vendor_id = m.duplicate_vendor_id;

    update rfq_items ri
    set awarded_vendor_id = m.keep_vendor_id
    from tmp_global_vendor_dedupe_map m
    where ri.awarded_vendor_id = m.duplicate_vendor_id;

    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'rfq_vendors'
    ) then
      execute $rfq$
        delete from rfq_vendors rv
        using tmp_global_vendor_dedupe_map m
        where rv.vendor_id = m.duplicate_vendor_id
          and exists (
            select 1
            from rfq_vendors existing
            where existing.rfq_id = rv.rfq_id
              and existing.job_id = rv.job_id
              and existing.vendor_id = m.keep_vendor_id
          )
      $rfq$;

      execute $rfq$
        update rfq_vendors rv
        set vendor_id = m.keep_vendor_id
        from tmp_global_vendor_dedupe_map m
        where rv.vendor_id = m.duplicate_vendor_id
      $rfq$;
    end if;

    delete from quotes q
    using tmp_global_vendor_dedupe_map m
    where q.vendor_id = m.duplicate_vendor_id
      and exists (
        select 1
        from quotes existing
        where existing.rfq_item_id = q.rfq_item_id
          and existing.vendor_id = m.keep_vendor_id
      );

    update quotes q
    set vendor_id = m.keep_vendor_id
    from tmp_global_vendor_dedupe_map m
    where q.vendor_id = m.duplicate_vendor_id;

    update quote_revisions qr
    set vendor_id = m.keep_vendor_id
    from tmp_global_vendor_dedupe_map m
    where qr.vendor_id = m.duplicate_vendor_id;

    update purchase_orders po
    set vendor_id = m.keep_vendor_id
    from tmp_global_vendor_dedupe_map m
    where po.vendor_id = m.duplicate_vendor_id;

    delete from vendors v
    using tmp_global_vendor_dedupe_map m
    where v.id = m.duplicate_vendor_id;
  end if;
end $$;

alter table vendors alter column job_id drop not null;
alter table vendor_contacts alter column job_id drop not null;

update vendors set job_id = null;
update vendor_contacts set job_id = null;

alter table vendors drop constraint if exists vendors_name_key;
drop index if exists idx_vendors_job_name_unique;
create unique index if not exists idx_vendors_name_unique on vendors (lower(name));
