import { useState } from 'react';
import { adminGet, budgetShare, usd, type UsageResponse } from '../api';
import { usePolled } from '../usePolled';

export function UsageView({ token, auto }: { token: string; auto: boolean }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, error, loading } = usePolled(
    (signal) => adminGet<UsageResponse>('/admin/usage', token, { from, to }, signal),
    [token, from, to],
    auto,
  );

  return (
    <section>
      <div className="toolbar">
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (inclusive) <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(from !== '' || to !== '') && (
          <button
            type="button"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            All time
          </button>
        )}
        {loading && <span className="muted">loading…</span>}
      </div>
      {error && <p className="error">{error.message}</p>}
      {data && (
        <>
          <div className="cards">
            <Card label="Requests" value={data.totals.requests} />
            <Card label="Served" value={data.totals.served} />
            <Card label="Cache hits" value={data.totals.cache_hits} />
            <Card label="Fallbacks" value={data.totals.fallbacks} />
            <Card label="Rejected" value={data.totals.rejected} />
            <Card label="Errors" value={data.totals.errors} />
            <Card label="Tokens" value={data.totals.total_tokens} />
            <Card label="Cost" value={usd(data.totals.cost_usd)} />
          </div>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th className="num">Requests</th>
                <th className="num">Cache hits</th>
                <th className="num">Fallbacks</th>
                <th className="num">Rejected</th>
                <th className="num">Errors</th>
                <th className="num">Prompt tok.</th>
                <th className="num">Completion tok.</th>
                <th className="num">Cost (window)</th>
                <th>Budget this month ({data.keys[0]?.budget.period ?? ''})</th>
              </tr>
            </thead>
            <tbody>
              {data.keys.map((key) => {
                const share = budgetShare(key.budget.spent_usd, key.budget.monthly_usd);
                return (
                  <tr key={key.key_id}>
                    <td>
                      <strong>{key.team}</strong> <span className="muted">{key.key_hint}</span>
                      {key.status !== 'active' && <span className="badge bad">{key.status}</span>}
                    </td>
                    <td className="num">{key.requests}</td>
                    <td className="num">{key.cache_hits}</td>
                    <td className="num">{key.fallbacks}</td>
                    <td className="num">{key.rejected}</td>
                    <td className="num">{key.errors}</td>
                    <td className="num">{key.prompt_tokens}</td>
                    <td className="num">{key.completion_tokens}</td>
                    <td className="num mono">{usd(key.cost_usd)}</td>
                    <td>
                      <div className="bar" title={`${(share * 100).toFixed(2)}% of the budget`}>
                        <div
                          className={share >= 1 ? 'fill over' : 'fill'}
                          style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }}
                        />
                      </div>
                      <span className="mono small">
                        {usd(key.budget.spent_usd)} of {usd(key.budget.monthly_usd)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">
            Requests with no valid key (rejected at authentication): {data.unattributed_requests}.
            Not included in the totals above.
          </p>
        </>
      )}
    </section>
  );
}

function Card({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card">
      <div className="muted small">{label}</div>
      <div className="big">{value}</div>
    </div>
  );
}
