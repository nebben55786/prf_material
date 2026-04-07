create index if not exists idx_fmr_logs_vendor_container_lookup
on fmr_logs (lower(trim(coalesce(vendor_name, ''))), lower(trim(coalesce(container_no, ''))));
