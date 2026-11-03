/**
 * Ordered, append-only list of schema migrations. Never edit a migration that has shipped:
 * the runner stores a checksum and refuses to continue if an applied migration changed.
 * Add a new entry instead.
 *
 * Money columns are NUMERIC(20,8): exact decimals with 8 places, matching the gateway's
 * integer "units of 1e-8 USD" (see money.ts). No floats are ever stored.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_initial_schema',
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

-- Tenants (virtual keys). Seeded from seed_keys.json; the raw key is never stored, only its hash.
CREATE TABLE virtual_keys (
  id                 BIGSERIAL PRIMARY KEY,
  key_hash           TEXT        NOT NULL UNIQUE,
  key_hint           TEXT        NOT NULL,
  team               TEXT        NOT NULL UNIQUE,
  status             TEXT        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  monthly_budget_usd NUMERIC(20,8) NOT NULL CHECK (monthly_budget_usd >= 0),
  rpm_limit          INTEGER     NOT NULL CHECK (rpm_limit >= 0),
  tpm_limit          INTEGER     CHECK (tpm_limit IS NULL OR tpm_limit >= 0),
  allowed_models     TEXT[]      NOT NULL DEFAULT '{}',
  cache_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  cache_threshold    NUMERIC(5,4)
                       CHECK (cache_threshold IS NULL OR (cache_threshold > 0 AND cache_threshold <= 1)),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Calendar-month (UTC) spend counter. 'reserved_usd' holds in-flight reservations (reserve -> settle).
CREATE TABLE budget_usage (
  key_id       BIGINT      NOT NULL REFERENCES virtual_keys(id) ON DELETE CASCADE,
  period       TEXT        NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  spent_usd    NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  reserved_usd NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  PRIMARY KEY (key_id, period)
);

-- One row per data-plane request, rejections included. key_id is NULL for unknown keys.
CREATE TABLE request_logs (
  request_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id                BIGINT      REFERENCES virtual_keys(id),
  requested_model       TEXT,
  resolved_provider     TEXT,
  resolved_model        TEXT,
  status                TEXT        NOT NULL CHECK (status IN (
                          'ok', 'cache_hit', 'rejected_auth', 'rejected_validation',
                          'rejected_not_found', 'rejected_allowlist', 'rejected_rate_limit',
                          'rejected_budget', 'rejected_unavailable', 'upstream_error',
                          'client_disconnect')),
  http_status           SMALLINT,
  error_code            TEXT,
  prompt_tokens         INTEGER     NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens     INTEGER     NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_usd              NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  cache                 TEXT        NOT NULL DEFAULT 'miss' CHECK (cache IN ('hit', 'miss')),
  fallback              BOOLEAN     NOT NULL DEFAULT FALSE,
  route_reason          TEXT,
  retries               INTEGER     NOT NULL DEFAULT 0 CHECK (retries >= 0),
  usage_estimated       BOOLEAN     NOT NULL DEFAULT FALSE,
  latency_ms            INTEGER     NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  time_to_first_token_ms INTEGER    CHECK (time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX request_logs_key_created_idx ON request_logs (key_id, created_at DESC);
CREATE INDEX request_logs_created_idx ON request_logs (created_at DESC);

-- Semantic cache. Always filtered by key_id (tenant isolation) and alias. vector(384) matches the
-- planned local sentence-embedding model; changing the model means a new migration.
-- No ANN index on purpose: an approximate index applied together with a per-tenant filter can
-- return too few candidates and cause false misses. The (key_id, alias, context_hash) btree
-- narrows each lookup to one tenant's small set, which is then ranked exactly.
CREATE TABLE cache_entries (
  id            BIGSERIAL   PRIMARY KEY,
  key_id        BIGINT      NOT NULL REFERENCES virtual_keys(id) ON DELETE CASCADE,
  alias         TEXT        NOT NULL,
  context_hash  TEXT        NOT NULL,
  prompt_text   TEXT        NOT NULL,
  embedding     vector(384) NOT NULL,
  response_json JSONB       NOT NULL,
  model         TEXT        NOT NULL,
  hit_count     INTEGER     NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ
);
CREATE INDEX cache_entries_scope_idx ON cache_entries (key_id, alias, context_hash);
`,
  },
];
