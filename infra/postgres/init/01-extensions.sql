-- Runs once, when the Postgres data volume is first created.
-- Application migrations (Phase 1) also use IF NOT EXISTS, so this is safe to repeat.
CREATE EXTENSION IF NOT EXISTS vector;
