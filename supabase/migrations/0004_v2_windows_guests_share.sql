-- v2 "Share Your Moment": clock-driven windows, guests table, curated share.
-- Pre-launch: wipes test photos. Kills reveal/email/limits artifacts.

delete from photos;

alter table events
  add column window_start timestamptz,
  add column window_end timestamptz;
alter table events
  drop column is_revealed,
  drop column is_active,
  drop column starts_at,
  drop column ends_at;

create table guests (
  session_id text primary key,
  display_name text,
  message text,
  created_at timestamptz not null default now()
);
alter table guests enable row level security;

alter table photos
  drop column guest_name,
  drop column table_number,
  drop column caption,
  drop column is_private,
  drop column is_hidden;
alter table photos
  add column starred boolean not null default false,
  add constraint photos_session_fk foreign key (session_id) references guests(session_id);

drop table guest_emails;

create table app_settings (
  key text primary key,
  value text not null
);
alter table app_settings enable row level security;
