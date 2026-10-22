-- photos.session_id carries a foreign key, but Postgres does not index the
-- referencing side of an FK. Two hot paths filter on it: the per-guest fair-use
-- count in /api/presign (once per upload) and /api/me/photos pagination.
create index if not exists photos_session_id_idx on photos (session_id);
