create table tracker_counters (
  job_id bigint not null references jobs(id) on delete cascade,
  kind text not null check(kind in ('receiving','issuing')),
  last_number bigint not null default 0,
  primary key(job_id,kind)
);
create table tracker_documents (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  kind text not null check(kind in ('receiving','issuing')),
  number text not null,
  data jsonb not null default '{}',
  cancelled boolean not null default false,
  version integer not null default 1,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  unique(job_id,kind,number), unique(job_id,id)
);
create table tracker_rows (
  id bigserial primary key,
  job_id bigint not null,
  document_id bigint not null,
  material_item_id bigint references material_items(id) on delete restrict,
  item_code text not null default '', description text not null default '',
  size_1 text not null default '', size_2 text not null default '',
  thk_1 text not null default '', thk_2 text not null default '',
  uom text not null default '', material_type text not null default '',
  quantity numeric(18,4) not null default 0 check(quantity>=0),
  posted_quantity numeric(18,4) not null default 0 check(posted_quantity>=0),
  reserved_quantity numeric(18,4) not null default 0 check(reserved_quantity>=0),
  warehouse text not null default '', location text not null default '',
  osd boolean not null default false,
  data jsonb not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  foreign key(job_id,document_id) references tracker_documents(job_id,id),
  unique(job_id,id)
);
create table tracker_postings (
  id bigserial primary key,
  job_id bigint not null,
  document_id bigint not null,
  request_key text not null,
  issued_date date not null,
  reversed boolean not null default false,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  foreign key(job_id,document_id) references tracker_documents(job_id,id),
  unique(job_id,request_key), unique(job_id,id)
);
create table tracker_allocations (
  id bigserial primary key,
  job_id bigint not null,
  posting_id bigint not null,
  row_id bigint not null,
  receipt_row_id bigint,
  warehouse text not null, location text not null,
  size_1 text not null default '', size_2 text not null default '',
  thk_1 text not null default '', thk_2 text not null default '',
  quantity numeric(18,4) not null check(quantity>0),
  foreign key(job_id,posting_id) references tracker_postings(job_id,id),
  foreign key(job_id,row_id) references tracker_rows(job_id,id),
  foreign key(job_id,receipt_row_id) references tracker_rows(job_id,id)
);
create table tracker_contacts (
  id bigserial primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  day_contact text not null,
  night_contact_1 text not null default '', night_contact_2 text not null default '',
  active boolean not null default true,
  version integer not null default 1,
  unique(job_id,day_contact)
);
-- Receipt attribution for issues posted through the existing request/load screens.
-- These rows are traceability only; the original issue ledger still owns the debit.
create table tracker_legacy_allocations (
  id bigserial primary key,
  job_id bigint not null,
  receipt_row_id bigint not null,
  issue_transaction_id bigint not null references material_issue_transactions(id) on delete cascade,
  quantity numeric(18,4) not null check(quantity>0),
  foreign key(job_id,receipt_row_id) references tracker_rows(job_id,id)
);
create table tracker_setup (
  job_id bigint primary key references jobs(id) on delete cascade,
  source text not null,
  imported_at timestamptz not null default now()
);
create index tracker_rows_document on tracker_rows(job_id,document_id);
create index tracker_rows_item on tracker_rows(job_id,item_code);
create index tracker_allocations_receipt on tracker_allocations(job_id,receipt_row_id);
create index tracker_allocations_row on tracker_allocations(job_id,row_id);
create index tracker_legacy_allocations_receipt on tracker_legacy_allocations(job_id,receipt_row_id);
create index tracker_legacy_allocations_issue on tracker_legacy_allocations(issue_transaction_id);
