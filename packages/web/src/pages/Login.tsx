import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Spinner } from '../components/Icon.tsx';

export function Login() {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(name.trim(), password);
      // A fresh start picks up the session everywhere (live connection included).
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card stack" style={{ width: '100%', maxWidth: 380, gap: 16, padding: 28 }} onSubmit={submit} aria-labelledby="login-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/brand.png" width={40} height={40} alt="" />
          <h1 id="login-title" style={{ fontFamily: 'var(--display)', fontSize: 24, fontWeight: 700 }}>
            srvMC
          </h1>
        </div>
        <label className="field">
          <span className="label">Jméno</span>
          <input className="input" autoFocus autoComplete="username" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Heslo</span>
          <input className="input" type="password" autoComplete="current-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn primary" style={{ minHeight: 46 }} disabled={busy || !name.trim() || !password}>
          {busy ? <Spinner size={16} /> : null}
          Přihlásit
        </button>
      </form>
    </main>
  );
}
