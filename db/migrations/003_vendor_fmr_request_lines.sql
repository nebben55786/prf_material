create table if not exists vendor_fmr_request_lines (
  id bigserial primary key,
  vendor_name text not null default '',
  po_number text not null default '',
  item_code text not null default '',
  abbrev_description text not null default '',
  po_line text not null default '',
  sub_line text not null default '',
  qty_ordered numeric(18,4) not null default 0,
  qty_received numeric(18,4) not null default 0,
  mrr_number text not null default '',
  issued_date text not null default '',
  received_date text not null default '',
  srn_number text not null default '',
  crate_number text not null default '',
  source_filename text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (po_number, item_code, abbrev_description)
);

create index if not exists idx_vendor_fmr_request_lines_po_number
on vendor_fmr_request_lines (po_number);

create index if not exists idx_vendor_fmr_request_lines_item_code
on vendor_fmr_request_lines (item_code);

create index if not exists idx_vendor_fmr_request_lines_vendor_name
on vendor_fmr_request_lines (vendor_name);

create index if not exists idx_vendor_fmr_request_lines_crate_number
on vendor_fmr_request_lines (crate_number);
