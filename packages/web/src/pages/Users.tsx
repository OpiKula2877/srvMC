import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PanelRole, PanelUser } from '@srvmc/shared';
import { api } from '../api.ts';
import { refreshAuth, ROLE_LABEL, setAuth, useAuth } from '../auth.ts';
import { Toggle } from '../components/Controls.tsx';
import { Dropdown } from '../components/Dropdown.tsx';
import { Icon, Spinner } from '../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../components/Overlays.tsx';
import { useLive } from '../live.ts';

const ROLES: { value: PanelRole; label: string }[] = [
  { value: 'admin', label: 'Admin – všechny servery, bez správy účtů' },
  { value: 'moderator', label: 'Moderátor – konzole, hráči, zapnout/vypnout' },
  { value: 'starter', label: 'Jen zapnout a vypnout' },
  { value: 'owner', label: 'Vlastník – úplně všechno' },
];

function ServerPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const servers = Object.values(useLive((s) => s.servers)).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  if (servers.length === 0) return <span className="muted small">Zatím žádný server.</span>;
  return (
    <div className="seg" role="group" aria-label="Servery, ke kterým má přístup">
      {servers.map((s) => (
        <button key={s.id} type="button" className="seg-btn" aria-pressed={value.includes(s.id)} onClick={() => onChange(value.includes(s.id) ? value.filter((x) => x !== s.id) : [...value, s.id])}>
          {s.name}
        </button>
      ))}
    </div>
  );
}

function UserDialog({ user, first, onDone, onCancel }: { user?: PanelUser; first: boolean; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<PanelRole>(first ? 'owner' : (user?.role ?? 'moderator'));
  const [servers, setServers] = useState<string[]>(user && user.servers !== 'all' ? user.servers : []);
  const [busy, setBusy] = useState(false);
  const auth = useAuth();
  const limited = role === 'moderator' || role === 'starter';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name: name.trim(), role, servers: limited ? servers : ('all' as const), ...(password && { password }) };
      if (user) await api.updateUser(user.id, body);
      else {
        await api.createUser({ ...body, password });
        // Outside the desktop window the first account would lock its own creator out, so it signs in with it.
        if (first && !auth?.local) setAuth(await api.login(body.name, password));
      }
      toast('ok', user ? 'Účet upraven' : first ? 'Účet vlastníka vytvořen' : 'Účet vytvořen', first ? 'Na jiných zařízeních se teď bude přihlašovat.' : undefined);
      onDone();
    } catch (err) {
      toast('error', 'Uložení selhalo', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="user-title" style={{ maxWidth: 520 }} onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="user-title" style={{ fontSize: 18, fontWeight: 600 }}>
          {user ? `Upravit ${user.name}` : first ? 'Účet vlastníka' : 'Nový účet'}
        </h2>
        <label className="field">
          <span className="label">Jméno</span>
          <input className="input" autoFocus autoComplete="off" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{user ? 'Nové heslo (nepovinné)' : 'Heslo (aspoň 8 znaků)'}</span>
          <input className="input" type="password" autoComplete="new-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {!first && <Dropdown label="Role" value={role} options={ROLES} onChange={(v) => setRole(v as PanelRole)} searchable={false} />}
        {limited && (
          <div className="stack" style={{ gap: 8 }}>
            <span className="label">Servery</span>
            <ServerPicker value={servers} onChange={setServers} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Zrušit
          </button>
          <button type="submit" className="btn primary" disabled={busy || name.trim().length < 2 || (!user && password.length < 8)}>
            {busy ? <Spinner size={14} /> : null}
            Uložit
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast('ok', 'Heslo změněno', 'Ostatní zařízení se musí přihlásit znovu.');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast('error', 'Heslo se nezměnilo', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack" style={{ gap: 12 }} onSubmit={submit} aria-labelledby="h-pass">
      <h2 id="h-pass" className="h2">
        Moje heslo
      </h2>
      <label className="field">
        <span className="label">Současné heslo</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">Nové heslo</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <button type="submit" className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy || !current || next.length < 8}>
        Změnit heslo
      </button>
    </form>
  );
}

export function Users() {
  const toast = useToast();
  const auth = useAuth();
  const servers = useLive((s) => s.servers);
  const [users, setUsers] = useState<PanelUser[] | null>(null);
  const [editing, setEditing] = useState<PanelUser | 'new' | null>(null);
  const [remove, setRemove] = useState<PanelUser | null>(null);

  const load = useCallback(() => api.users().then(setUsers).catch((err: Error) => toast('error', 'Účty se nepodařilo načíst', err.message)), [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!auth || !users) return <Spinner />;
  const first = users.length === 0;
  const describe = (u: PanelUser) =>
    u.servers === 'all'
      ? 'všechny servery'
      : u.servers.length === 0
        ? 'žádný server'
        : u.servers.map((id) => servers[id]?.name ?? '?').join(', ');

  return (
    <main className="main">
      <h1 className="h1">Uživatelé panelu</h1>
      <div className="row">
        <section className="col-main stack" aria-labelledby="h-users" style={{ gap: 14 }}>
          <div className="section-head">
            <h2 id="h-users" className="h2">
              Účty
            </h2>
            <button type="button" className="btn" onClick={() => setEditing('new')}>
              <Icon name="plus" size={17} strokeWidth={2.2} />
              {first ? 'Vytvořit účet vlastníka' : 'Nový účet'}
            </button>
          </div>
          {first ? (
            <div className="empty">
              <span style={{ fontWeight: 600 }}>Panel teď ovládá jen tento počítač</span>
              <span className="muted">S účty se přihlásí i další lidé – každý jen k tomu, co mu povolíš.</span>
            </div>
          ) : (
            <div className="table-wrap card" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Jméno</th>
                    <th>Role</th>
                    <th>Servery</th>
                    <th className="num">Akce</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 500 }}>
                        {u.name}
                        {auth.user?.id === u.id && <span className="muted small"> (ty)</span>}
                      </td>
                      <td>{ROLE_LABEL[u.role]}</td>
                      <td className="muted small">{describe(u)}</td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn sm" onClick={() => setEditing(u)}>
                          Upravit
                        </button>{' '}
                        <button type="button" className="btn icon sm" style={{ width: 36, minHeight: 36, color: 'var(--red-text)' }} aria-label={`Smazat účet ${u.name}`} disabled={auth.user?.id === u.id} onClick={() => setRemove(u)}>
                          <Icon name="trash" size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="col-side stack" style={{ gap: 16 }}>
          <div className="card stack" style={{ gap: 12 }} aria-labelledby="h-lan">
            <h2 id="h-lan" className="h2">
              Panel z domácí sítě
            </h2>
            <Toggle
              label="Povolit přístup z jiných zařízení"
              checked={auth.lan.enabled}
              disabled={first}
              onChange={(v) =>
                void api
                  .setLan(v)
                  .then(async () => {
                    await refreshAuth();
                    toast('ok', v ? 'Přístup ze sítě zapnutý' : 'Přístup ze sítě vypnutý', 'Projeví se po restartu srvMC.');
                  })
                  .catch((err: Error) => toast('error', 'Nepovedlo se', err.message))
              }
            />
            {first && <span className="muted small">Nejdřív vytvoř účet vlastníka.</span>}
            {auth.lan.enabled &&
              auth.lan.addresses.map((a) => (
                <span key={a} className="mono small">
                  {a}
                </span>
              ))}
          </div>
          {auth.user && auth.user.id !== 'local' && <PasswordCard />}
        </aside>
      </div>

      {editing && (
        <UserDialog
          user={editing === 'new' ? undefined : editing}
          first={first}
          onCancel={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void load();
            void refreshAuth();
          }}
        />
      )}
      {remove && (
        <ConfirmDialog
          title={`Smazat účet ${remove.name}?`}
          text="Odhlásí se ze všech zařízení."
          confirmLabel="Smazat"
          danger
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const r = remove;
            setRemove(null);
            void api
              .deleteUser(r.id)
              .then(load)
              .catch((err: Error) => toast('error', 'Smazání selhalo', err.message));
          }}
        />
      )}
    </main>
  );
}
