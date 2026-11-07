import { useState } from 'react';
import { adminGet, usd, type LogEntry, type LogsResponse } from '../api';
import { usePolled } from '../usePolled';

const STATUSES = [
  'ok',
  'cache_hit',
  'upstream_error',
  'client_disconnect',
  'internal_error',
  'rejected_auth',
  'rejected_validation',
  'rejected_not_found',
  'rejected_allowlist',
  'rejected_rate_limit',
  'rejected_budget',
  'rejected_unavailable',
];

function badgeClass(status: string): string {
  if (status === 'ok') return 'badge good';
  if (status === 'cache_hit') return 'badge info';
  if (status.startsWith('rejected_')) return 'badge warn';
  return 'badge bad';
}

export function RequestsView({ token, auto }: { token: string; auto: boolean }) {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(50);
  // Older pages belong to the filters they were loaded with; other filters start again.
  const signature = JSON.stringify([token, key, status, limit]);
  const [olderPages, setOlderPages] = useState<{
    signature: string;
    rows: LogEntry[];
    cursor: string | null;
  } | null>(null);
  const older = olderPages?.signature === signature ? olderPages : null;
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const { data, error, loading } = usePolled(
    (signal) =>
      adminGet<LogsResponse>('/admin/logs', token, { key: key.trim(), status, limit }, signal),
    [token, key, status, limit],
    auto,
  );

  const newest = data?.data ?? [];
  // Older pages are appended below the (auto-refreshed) newest page; they never repeat it.
  const seen = new Set(newest.map((row) => row.request_id));
  const rows = [...newest, ...(older?.rows ?? []).filter((row) => !seen.has(row.request_id))];
  const nextCursor = older !== null ? older.cursor : (data?.next_cursor ?? null);

  async function loadMore() {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await adminGet<LogsResponse>('/admin/logs', token, {
        key: key.trim(),
        status,
        limit,
        cursor: nextCursor,
      });
      setOlderPages({
        signature,
        rows: [...(older?.rows ?? []), ...page.data],
        cursor: page.next_cursor,
      });
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section>
      <div className="toolbar">
        <label>
          Key (team or id){' '}
          <input value={key} placeholder="all keys" onChange={(e) => setKey(e.target.value)} />
        </label>
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rows{' '}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {loading && <span className="muted">loading…</span>}
      </div>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Key</th>
            <th>Requested → served by</th>
            <th>Status</th>
            <th>Cache</th>
            <th>Fallback</th>
            <th>Route reason</th>
            <th className="num">Tokens (in/out)</th>
            <th className="num">Cost</th>
            <th className="num">Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.request_id} title={row.request_id}>
              <td className="mono small">{new Date(row.created_at).toLocaleTimeString()}</td>
              <td>{row.team ?? <span className="muted">no key</span>}</td>
              <td>
                {row.requested_model ?? <span className="muted">—</span>}
                {' → '}
                {row.resolved_provider !== null && row.resolved_model !== null ? (
                  `${row.resolved_provider}/${row.resolved_model}`
                ) : (
                  <span className="muted">none</span>
                )}
              </td>
              <td>
                <span className={badgeClass(row.status)}>{row.status}</span>{' '}
                <span className="muted small">
                  {row.http_status}
                  {row.error_code ? ` ${row.error_code}` : ''}
                </span>
              </td>
              <td>{row.cache}</td>
              <td>
                {row.fallback ? <span className="badge warn">fallback</span> : '—'}
                {row.retries > 0 && <span className="muted small"> {row.retries} retries</span>}
              </td>
              <td className="small">{row.route_reason ?? <span className="muted">—</span>}</td>
              <td className="num">
                {row.prompt_tokens}/{row.completion_tokens}
                {row.usage_estimated && <span title="estimated"> ≈</span>}
              </td>
              <td className="num mono">{usd(row.cost_usd)}</td>
              <td className="num">{row.latency_ms} ms</td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={10} className="muted">
                No requests match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {moreError && <p className="error">{moreError}</p>}
      {nextCursor !== null && (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  );
}
