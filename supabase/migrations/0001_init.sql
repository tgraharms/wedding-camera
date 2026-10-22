create extension if not exists "pgcrypto";

create table events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  is_revealed boolean not null default false,
  created_at timestamptz not null default now()
);

create table photos (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  storage_key text not null unique,
  session_id text not null,
  guest_name text not null,
  table_number text,
  caption text,
  is_private boolean not null default false,
  is_hidden boolean not null default false,
  captured_at timestamptz not null,
  uploaded_at timestamptz not null default now()
);

create table guest_emails (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  email text not null,
  guest_name text,
  notified boolean not null default false,
  created_at timestamptz not null default now()
);

create table admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- RLS on: browser never touches Supabase directly; only the service role (Functions) does.
alter table events enable row level security;
alter table photos enable row level security;
alter table guest_emails enable row level security;
alter table admin_users enable row level security;

-- Seed the three events.
insert into events (name, is_revealed) values
  ('Akad', false),
  ('Reception', false),
  ('Internal Test', false);
