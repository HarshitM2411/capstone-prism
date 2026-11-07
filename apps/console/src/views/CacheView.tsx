import { adminGet, percent, type CacheStatsResponse } from '../api';
import { usePolled } from '../usePolled';

export function CacheView({ token, auto }: { token: string; auto: boolean }) {
  const { data, error, loading } = usePolled(
    (signal) => adminGet<CacheStatsResponse>('/admin/cache/stats', token, {}, signal),
    [token],
    auto,
  );

  return (
    <section>
      {loading && <span className="muted">loading…</span>}
      {error && <p className="error">{error.message}</p>}
      {data && (
        <>
          <div className="cards">
            <div className="card">
              <div className="muted small">Hit rate</div>
              <div className="big">{percent(data.overall.hit_rate)}</div>
            </div>
            <div className="card">
              <div className="muted small">Hits</div>
              <div className="big">{data.overall.hits}</div>
            </div>
            <div className="card">
              <div className="muted small">Misses</div>
              <div className="big">{data.overall.misses}</div>
            </div>
            <div className="card">
              <div className="muted small">Live entries</div>
              <div className="big">{data.overall.entries}</div>
            </div>
          </div>
          {!data.enabled && <p className="muted">The cache is not configured on this gateway.</p>}
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Cache</th>
                <th className="num">Threshold</th>
                <th className="num">Hits</th>
                <th className="num">Misses</th>
                <th className="num">Hit rate</th>
                <th className="num">Entries</th>
                <th className="num">Stored hit count</th>
              </tr>
            </thead>
            <tbody>
              {data.keys.map((key) => (
                <tr key={key.key_id}>
                  <td>
                    <strong>{key.team}</strong> <span className="muted">{key.key_hint}</span>
                  </td>
                  <td>
                    {key.cache_enabled ? (
                      <span className="badge good">on</span>
                    ) : (
                      <span className="badge">off</span>
                    )}
                  </td>
                  <td className="num">{key.similarity_threshold ?? '—'}</td>
                  <td className="num">{key.hits}</td>
                  <td className="num">{key.misses}</td>
                  <td className="num">{key.cache_enabled ? percent(key.hit_rate) : '—'}</td>
                  <td className="num">{key.entries}</td>
                  <td className="num">{key.stored_hit_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Hit rate = {data.definition}.</p>
        </>
      )}
    </section>
  );
}
