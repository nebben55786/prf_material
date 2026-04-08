alter table vendor_fmr_request_lines
add column if not exists selected_for_request boolean not null default false;

create index if not exists idx_vendor_fmr_request_lines_selected_for_request
on vendor_fmr_request_lines (selected_for_request);
