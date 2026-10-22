import { useState, type FormEvent } from 'react';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { t } from '@srvmc/shared';

/** CurseForge only answers apps with an API key; the user pastes their own once. */
export function CurseForgeKey({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.setCurseForgeKey(key.trim());
      toast('ok', t('CurseForge connected'));
      onSaved();
    } catch (err) {
      toast('error', t('Could not save the key'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" style={{ gap: 12 }} onSubmit={(e) => void save(e)}>
      <span style={{ fontWeight: 600 }}>{t('CurseForge needs an API key')}</span>
      <ol style={{ margin: 0, paddingLeft: 20, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6 }}>
        <li>
          {t('Go to')}{' '}
          <a href="https://console.curseforge.com/" target="_blank" rel="noreferrer">
            console.curseforge.com
          </a>{' '}
          {t('and sign in with a CurseForge account.')}
        </li>
        <li>{t('Create a key under API keys and copy it.')}</li>
        <li>{t('Paste it here. It is stored encrypted, only on this computer.')}</li>
      </ol>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <input className="input mono" type="password" style={{ flex: '1 1 260px', width: 'auto' }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="$2a$10$…" autoComplete="off" spellCheck={false} aria-label={t('CurseForge API key')} />
        <button type="submit" className="btn primary" disabled={busy || key.trim().length < 20}>
          {busy && <Spinner size={14} />}
          {t('Save key')}
        </button>
      </div>
    </form>
  );
}
