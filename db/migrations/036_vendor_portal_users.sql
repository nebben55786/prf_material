create table if not exists vendor_users (
  id bigserial primary key,
  vendor_id bigint not null references vendors(id) on delete cascade,
  name text not null default '',
  email text not null unique,
  password_hash text not null,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vendor_users_vendor_id on vendor_users(vendor_id);
create index if not exists idx_vendor_users_active on vendor_users(is_active);
create unique index if not exists idx_vendor_users_email_lower_unique on vendor_users(lower(email));
