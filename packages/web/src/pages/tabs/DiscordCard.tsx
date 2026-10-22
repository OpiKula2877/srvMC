import { useState } from 'react';
import { DISCORD_EVENTS, type DiscordEvent, type ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';

const LABELS: Record<DiscordEvent, string> = {
  start: 'Zapnutí',
  stop: 'Vypnutí',
  crash: 'Pád',
  join: 'Připojení hráče',
  leave: 'Odchod hráče',
  sleep: 'Uspání',
};

export function DiscordCard({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [webhook, setWebhook] = useState('');
  const [events, setEvents] = useState<DiscordEvent[]>(server.discord?.events ?? ['start', 'stop', 'crash', 'join', 'leave']);
  const [busy, setBusy] = useState<string | null>(null);
  const set = !!server.discordSet;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast('ok', ok);
      setWebhook('');
    } catch (err) {
      toast('error', 'Nepovedlo se', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="col-side card stack" style={{ gap: 14 }} aria-labelledby="h-discord">
      <h2 id="h-discord" className="h2">
        Discord
      </h2>
      <label className="field">
        <span className="label">{set ? 'Webhook je uložený – nový ho nahradí' : 'Webhook kanálu'}</span>
        <input className="input mono" type="password" autoComplete="off" value={webhook} placeholder="https://discord.com/api/webhooks/…" maxLength={300} onChange={(e) => setWebhook(e.target.value)} />
      </label>
      <div className="seg" role="group" aria-label="Události">
        {DISCORD_EVENTS.map((e) => (
          <button key={e} type="button" className="seg-btn" aria-pressed={events.includes(e)} onClick={() => setEvents(events.includes(e) ? events.filter((x) => x !== e) : [...events, e])}>
            {LABELS[e]}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn primary" disabled={!!busy || (!set && !webhook.trim())} onClick={() => void run('save', () => api.setDiscord(server.id, { ...(webhook.trim() && { webhook: webhook.trim() }), events }), 'Discord uložen')}>
          {busy === 'save' ? <Spinner size={14} /> : null}
          Uložit
        </button>
        {set && (
          <>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void run('test', () => api.testDiscord(server.id), 'Zkušební zpráva odeslána')}>
              Poslat zkoušku
            </button>
            <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void run('remove', () => api.removeDiscord(server.id), 'Discord odpojen')}>
              Odpojit
            </button>
          </>
        )}
      </div>
    </section>
  );
}
