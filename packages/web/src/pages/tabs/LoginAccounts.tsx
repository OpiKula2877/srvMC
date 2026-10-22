import { useCallback, useEffect, useState } from 'react';
import type { LoginAccount, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Icon } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { ago } from '../../format.ts';
import { t } from '@srvmc/shared';

/** Players registered with srvMC Login: turn autologin off, or delete an account so the player registers again. */
export function LoginAccounts({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [list, setList] = useState<LoginAccount[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => api.loginAccounts(server.id).then(setList).catch(() => setList([])), [server.id]);
  useEffect(() => {
    void load();
  }, [load, server.status, server.players.length]);

  const run = async (fn: () => Promise<LoginAccount[]>, ok: string) => {
    try {
      setList(await fn());
      toast('ok', ok);
    } catch (err) {
      toast('error', t('That did not work'), (err as Error).message);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="muted small">{t('Commands: /register, /login, /changepassword, /autologin on|off')}</span>
      <span style={{ fontWeight: 600, fontSize: 14 }}>{t('Registered players ({n})', { n: list?.length ?? 0 })}</span>
      {list?.length === 0 && <span className="muted small">{t('Nobody has registered yet.')}</span>}
      {list?.map((a) => (
        <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span className="mono" style={{ fontWeight: 500 }}>
              {a.name}
              {a.online && <span style={{ color: 'var(--green-text)', marginLeft: 6 }}>●</span>}
            </span>
            <span className="muted small">
              {a.autologin ? t('paid account, autologin') : t('password')} · {a.lastLogin ? ago(a.lastLogin) : t('never logged in')}
            </span>
          </div>
          {a.autologin && (
            <button type="button" className="btn sm" onClick={() => void run(() => api.setLoginAutologin(server.id, a.name, false), t('Autologin off for {name}', { name: a.name }))}>
              {t('Autologin off')}
            </button>
          )}
          <button type="button" className="btn icon sm" style={{ width: 36, minHeight: 36, color: 'var(--red-text)' }} aria-label={t('Delete the account {name}', { name: a.name })} onClick={() => setDeleting(a.name)}>
            <Icon name="trash" size={15} />
          </button>
        </div>
      ))}
      {deleting && (
        <ConfirmDialog
          title={t('Delete the account {name}?', { name: deleting })}
          text={t('The password is forgotten. On the next join the player registers again with a new one.')}
          confirmLabel={t('Delete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const n = deleting;
            setDeleting(null);
            void run(() => api.deleteLoginAccount(server.id, n), t('Account {name} deleted', { name: n }));
          }}
        />
      )}
    </div>
  );
}
