import { useState, type FormEvent } from 'react';
import { ApiError, adminGet } from './api';
import { CacheView } from './views/CacheView';
import { RequestsView } from './views/RequestsView';
import { UsageView } from './views/UsageView';

/**
 * A deliberately plain ops console (the visual design comes later). It reads only from the
 * gateway's admin API, using the demo admin token the operator types in; the token is kept for
 * the browser session only.
 */
const TOKEN_KEY = 'prism-admin-token';
type Tab = 'usage' | 'requests' | 'cache';

export function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  if (token === null) {
    return (
      <Login
        onToken={(value) => {
          sessionStorage.setItem(TOKEN_KEY, value);
          setToken(value);
        }}
      />
    );
  }
  return (
    <Console
      token={token}
      onSignOut={() => {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }}
    />
  );
}

function Login({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError(null);
    try {
      await adminGet('/admin/ping', value.trim());
      onToken(value.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That admin token was not accepted.'
          : err instanceof Error
            ? err.message
            : 'Could not check the token.',
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="login">
      <h1>Prism Ops Console</h1>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Admin token
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={checking || value.trim() === ''}>
          {checking ? 'Checking…' : 'Sign in'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}

function Console({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('usage');
  const [auto, setAuto] = useState(true);
  const tabs: [Tab, string][] = [
    ['usage', 'Usage by key'],
    ['requests', 'Recent requests'],
    ['cache', 'Cache'],
  ];

  return (
    <main>
      <header>
        <h1>Prism Ops Console</h1>
        <nav>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'tab active' : 'tab'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <label className="small">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{' '}
          Refresh every 5 s
        </label>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {tab === 'usage' && <UsageView token={token} auto={auto} />}
      {tab === 'requests' && <RequestsView token={token} auto={auto} />}
      {tab === 'cache' && <CacheView token={token} auto={auto} />}
    </main>
  );
}
