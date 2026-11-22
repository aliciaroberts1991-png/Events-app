import { useState } from 'react';
import { api, errorMessage } from '../lib/api';

export function LoginPage({ appName, hasOwner, onDone }: { appName: string; hasOwner: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="login" id="main">
      <div className="login-card card">
        <p className="brand login-brand">
          <span className="brand-mark" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          {appName}
        </p>
        <h1>Sign in</h1>
        {!hasOwner ? (
          <div className="setup-note" role="note">
            <p>No account has been set up on this server yet.</p>
            <p className="small">
              Set <code>OWNER_EMAIL</code> and <code>OWNER_PASSWORD</code> and restart, or run <code>npm run owner:create -- --email you@example.com</code>.
            </p>
          </div>
        ) : (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await api('POST', '/api/auth/login', { email, password });
                onDone();
              } catch (x) {
                setErr(errorMessage(x));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              <span className="field-label">Email</span>
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {err && <p className="error-note" role="alert">{err}</p>}
            <button className="btn btn-primary block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="muted small">You stay signed in on this device for 90 days of use.</p>
          </form>
        )}
      </div>
    </main>
  );
}
