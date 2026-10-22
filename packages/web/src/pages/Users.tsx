import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PanelRole, PanelUser } from '@srvmc/shared';
import { api } from '../api.ts';
import { refreshAuth, ROLE_LABEL, setAuth, useAuth } from '../auth.ts';
import { Toggle } from '../components/Controls.tsx';
import { Dropdown } from '../components/Dropdown.tsx';
import { Icon, Spinner } from '../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../components/Overlays.tsx';
import { useLive } from '../live.ts';
import { t } from '@srvmc/shared';

const ROLES: { value: PanelRole; label: string }[] = [
  { value: 'admin', label: t('Admin – all servers, no account management') },
  { value: 'moderator', label: t('Moderator – console, players, start/stop') },
  { value: 'starter', label: t('Start and stop only') },
  { value: 'owner', label: t('Owner – everything') },
];

function ServerPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const servers = Object.values(useLive((s) => s.servers)).sort((a, b) => a.name.localeCompare(b.name));
  if (servers.length === 0) return <span className="muted small">{t('No servers yet.')}</span>;
  return (
    <div className="seg" role="group" aria-label={t('Servers this account can reach')}>
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
      toast('ok', user ? t('Account updated') : first ? t('Owner account created') : t('Account created'), first ? t('Other devices now have to sign in.') : undefined);
      onDone();
    } catch (err) {
      toast('error', t('Saving failed'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="user-title" style={{ maxWidth: 520 }} onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="user-title" style={{ fontSize: 18, fontWeight: 600 }}>
          {user ? t('Edit {name}', { name: user.name }) : first ? t('Owner account') : t('New account')}
        </h2>
        <label className="field">
          <span className="label">{t('User name')}</span>
          <input className="input" autoFocus autoComplete="off" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{user ? t('New password (optional)') : t('Password (at least 8 characters)')}</span>
          <input className="input" type="password" autoComplete="new-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {!first && <Dropdown label={t('Role')} value={role} options={ROLES} onChange={(v) => setRole(v as PanelRole)} searchable={false} />}
        {limited && (
          <div className="stack" style={{ gap: 8 }}>
            <span className="label">{t('Servers')}</span>
            <ServerPicker value={servers} onChange={setServers} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || name.trim().length < 2 || (!user && password.length < 8)}>
            {busy ? <Spinner size={14} /> : null}
            {t('Save')}
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
      toast('ok', t('Password changed'), t('Other devices have to sign in again.'));
      setCurrent('');
      setNext('');
    } catch (err) {
      toast('error', t('The password did not change'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack" style={{ gap: 12 }} onSubmit={submit} aria-labelledby="h-pass">
      <h2 id="h-pass" className="h2">
        {t('My password')}
      </h2>
      <label className="field">
        <span className="label">{t('Current password')}</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">{t('New password')}</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <button type="submit" className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy || !current || next.length < 8}>
        {t('Change password')}
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

  const load = useCallback(() => api.users().then(setUsers).catch((err: Error) => toast('error', t('Could not load the accounts'), err.message)), [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!auth || !users) return <Spinner />;
  const first = users.length === 0;
  const describe = (u: PanelUser) =>
    u.servers === 'all'
      ? t('all servers')
      : u.servers.length === 0
        ? t('no server')
        : u.servers.map((id) => servers[id]?.name ?? '?').join(', ');

  return (
    <main className="main">
      <h1 className="h1">{t('Panel users')}</h1>
      <div className="row">
        <section className="col-main stack" aria-labelledby="h-users" style={{ gap: 14 }}>
          <div className="section-head">
            <h2 id="h-users" className="h2">
              {t('Accounts')}
            </h2>
            <button type="button" className="btn" onClick={() => setEditing('new')}>
              <Icon name="plus" size={17} strokeWidth={2.2} />
              {first ? t('Create the owner account') : t('New account')}
            </button>
          </div>
          {first ? (
            <div className="empty">
              <span style={{ fontWeight: 600 }}>{t('Only this computer controls the panel now')}</span>
              <span className="muted">{t('With accounts, other people can sign in too – each only to what you allow.')}</span>
            </div>
          ) : (
            <div className="table-wrap card" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('User name')}</th>
                    <th>{t('Role')}</th>
                    <th>{t('Servers')}</th>
                    <th className="num">{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 500 }}>
                        {u.name}
                        {auth.user?.id === u.id && <span className="muted small">{t(' (you)')}</span>}
                      </td>
                      <td>{ROLE_LABEL[u.role]}</td>
                      <td className="muted small">{describe(u)}</td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn sm" onClick={() => setEditing(u)}>
                          {t('Edit')}
                        </button>{' '}
                        <button type="button" className="btn icon sm" style={{ width: 36, minHeight: 36, color: 'var(--red-text)' }} aria-label={t('Delete account {name}', { name: u.name })} disabled={auth.user?.id === u.id} onClick={() => setRemove(u)}>
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
              {t('Panel from the home network')}
            </h2>
            <Toggle
              label={t('Allow access from other devices')}
              checked={auth.lan.enabled}
              disabled={first}
              onChange={(v) =>
                void api
                  .setLan(v)
                  .then(async () => {
                    await refreshAuth();
                    toast('ok', v ? t('Network access on') : t('Network access off'), t('Takes effect after srvMC restarts.'));
                  })
                  .catch((err: Error) => toast('error', t('That did not work'), err.message))
              }
            />
            {first && <span className="muted small">{t('Create the owner account first.')}</span>}
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
          title={t('Delete account {name}?', { name: remove.name })}
          text={t('It is signed out on all devices.')}
          confirmLabel={t('Delete')}
          danger
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const r = remove;
            setRemove(null);
            void api
              .deleteUser(r.id)
              .then(load)
              .catch((err: Error) => toast('error', t('Deleting failed'), err.message));
          }}
        />
      )}
    </main>
  );
}
