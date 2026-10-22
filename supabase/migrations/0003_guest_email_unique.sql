-- Remove any existing duplicates first (keeps one row per (event_id, lower(email))).
delete from guest_emails a
  using guest_emails b
  where a.ctid < b.ctid
    and a.event_id = b.event_id
    and lower(a.email) = lower(b.email);

create unique index if not exists guest_emails_event_email_uniq
  on guest_emails (event_id, lower(email));
