import type { Pool } from '../db/pool.js';

/** What is stored for a cached answer, and replayed on a hit. */
export interface CachedResponse {
  content: string;
  finishReason: string;
  /** The usage of the original call (informational: a hit costs nothing). */
  promptTokens: number;
  completionTokens: number;
  /** The provider and model that originally produced it (also when a fallback served it). */
  provider: string;
  model: string;
}

export interface CacheQuery {
  /** The tenant. Every lookup is filtered by it, in the query itself. */
  keyId: number;
  /** The tier (or model name) the request resolved to: a `fast` answer never serves `smart`. */
  alias: string;
  contextHash: string;
  embedding: readonly number[];
  /** Minimum cosine similarity, from the key's own configuration. */
  threshold: number;
}

export interface CacheHit {
  response: CachedResponse;
  similarity: number;
}

export interface CacheEntryInput {
  keyId: number;
  alias: string;
  contextHash: string;
  promptText: string;
  embedding: readonly number[];
  response: CachedResponse;
}

export interface CacheKeyStats {
  keyId: number;
  team: string;
  keyHint: string;
  cacheEnabled: boolean;
  threshold: number | null;
  /** Requests answered from the cache. */
  hits: number;
  /** Requests of this key that were served (`ok` or `cache_hit`), whether or not they hit. */
  served: number;
  entries: number;
  /** Sum of `hit_count` over the key's live entries. */
  storedHits: number;
}

export interface CacheStats {
  keys: CacheKeyStats[];
}

export interface CacheStore {
  /** The best entry of this tenant and scope that meets the threshold, or `null`. */
  lookup(query: CacheQuery): Promise<CacheHit | null>;
  write(entry: CacheEntryInput): Promise<void>;
  /** Removes expired entries; returns how many. */
  deleteExpired(): Promise<number>;
  stats(): Promise<CacheStats>;
}

/** pgvector's text form: `[0.1,0.2,...]`. Non-finite numbers are rejected rather than stored. */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const x of vector) {
    if (!Number.isFinite(x)) throw new Error('embedding contains a non-finite number');
  }
  return `[${vector.join(',')}]`;
}

/** Largest answer stored, so one huge response cannot bloat the table. */
export const MAX_CACHED_CHARS = 256 * 1024;

export class PgCacheStore implements CacheStore {
  /**
   * @param ttlMs how long an entry is served; `0` keeps entries until they are removed manually.
   *              Eviction is by expiry only (documented limitation: no size cap).
   */
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number,
  ) {}

  async lookup(query: CacheQuery): Promise<CacheHit | null> {
    const vector = toVectorLiteral(query.embedding);
    // Tenant isolation lives here: `key_id` is part of every lookup, never filtered afterwards.
    // The nearest entry of this tenant/tier/context is ranked exactly (no approximate index), then
    // compared with the key's threshold.
    const { rows } = await this.pool.query<{
      id: string;
      response_json: CachedResponse;
      similarity: number;
    }>(
      `SELECT id, response_json, 1 - (embedding <=> $1::vector) AS similarity
         FROM cache_entries
        WHERE key_id = $2
          AND alias = $3
          AND context_hash = $4
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [vector, query.keyId, query.alias, query.contextHash],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const similarity = Number(row.similarity);
    if (!Number.isFinite(similarity) || similarity < query.threshold) return null;

    // Counting a hit is bookkeeping: it must never fail or delay the answer.
    this.pool
      .query('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = $1 AND key_id = $2', [
        row.id,
        query.keyId,
      ])
      .catch(() => undefined);
    return { response: row.response_json, similarity };
  }

  async write(entry: CacheEntryInput): Promise<void> {
    if (entry.response.content === '' || entry.response.content.length > MAX_CACHED_CHARS) return;
    const vector = toVectorLiteral(entry.embedding);
    // An identical prompt in the same scope is stored once (concurrent identical requests may both
    // miss and both try to write; the second becomes a no-op rather than a duplicate).
    await this.pool.query(
      `INSERT INTO cache_entries
         (key_id, alias, context_hash, prompt_text, embedding, response_json, model, expires_at)
       SELECT $1::bigint, $2::text, $3::text, $4::text, $5::vector, $6::jsonb, $7::text,
              CASE WHEN $8::bigint > 0 THEN now() + ($8::bigint * interval '1 millisecond') END
        WHERE NOT EXISTS (
          SELECT 1 FROM cache_entries
           WHERE key_id = $1::bigint AND alias = $2::text AND context_hash = $3::text
             AND prompt_text = $4::text
             AND (expires_at IS NULL OR expires_at > now()))`,
      [
        entry.keyId,
        entry.alias,
        entry.contextHash,
        entry.promptText,
        vector,
        JSON.stringify(entry.response),
        entry.response.model,
        this.ttlMs,
      ],
    );
  }

  async deleteExpired(): Promise<number> {
    const result = await this.pool.query('DELETE FROM cache_entries WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }

  async stats(): Promise<CacheStats> {
    const { rows } = await this.pool.query<{
      id: string;
      team: string;
      key_hint: string;
      cache_enabled: boolean;
      cache_threshold: string | null;
      hits: string;
      served: string;
      entries: string;
      stored_hits: string;
    }>(
      `SELECT k.id, k.team, k.key_hint, k.cache_enabled, k.cache_threshold,
              COALESCE(l.hits, 0) AS hits, COALESCE(l.served, 0) AS served,
              COALESCE(e.entries, 0) AS entries, COALESCE(e.stored_hits, 0) AS stored_hits
         FROM virtual_keys k
         LEFT JOIN (
           SELECT key_id,
                  COUNT(*) FILTER (WHERE status = 'cache_hit') AS hits,
                  COUNT(*) FILTER (WHERE status IN ('ok', 'cache_hit')) AS served
             FROM request_logs GROUP BY key_id
         ) l ON l.key_id = k.id
         LEFT JOIN (
           SELECT key_id, COUNT(*) AS entries, SUM(hit_count) AS stored_hits
             FROM cache_entries
            WHERE expires_at IS NULL OR expires_at > now()
            GROUP BY key_id
         ) e ON e.key_id = k.id
        ORDER BY k.id`,
    );
    return {
      keys: rows.map((row) => ({
        keyId: Number(row.id),
        team: row.team,
        keyHint: row.key_hint,
        cacheEnabled: row.cache_enabled,
        threshold: row.cache_threshold === null ? null : Number(row.cache_threshold),
        hits: Number(row.hits),
        served: Number(row.served),
        entries: Number(row.entries),
        storedHits: Number(row.stored_hits),
      })),
    };
  }
}
