alter table events add column is_active boolean not null default false;

-- Current phase is pre-wedding testing; the couple switches this from /admin on the day.
-- Fails loudly if the seed matches anything other than exactly one event (e.g. it was renamed).
do $$
declare n int;
begin
  update events set is_active = true where name = 'Internal Test';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'expected exactly 1 event named "Internal Test", updated % rows', n;
  end if;
end $$;
