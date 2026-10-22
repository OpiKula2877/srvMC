import { useCallback, useEffect, useState } from 'react';
import type { AddonId, AddonState, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';

const INFO: Record<AddonId, { title: string; tile: string }> = {
  geyser: { title: 'Crossplay s Bedrockem', tile: '#6AA9FF' },
  bluemap: { title: 'Mapa světa (BlueMap)', tile: '#5BD27A' },
};

export function AddonCards({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [addons, setAddons] = useState<AddonState[] | null>(null);
  const [busy, setBusy] = useState<AddonId | null>(null);
  const [consent, setConsent] = useState(false);
  const running = server.status !== 'stopped' && server.status !== 'crashed' && server.status !== 'error';

  const load = useCallback(() => api.addons(server.id).then(setAddons).catch(() => setAddons([])), [server.id]);
  useEffect(() => {
    void load();
  }, [load, server.status]);

  const run = async (id: AddonId, fn: () => Promise<AddonState[]>, ok: string) => {
    setBusy(id);
    try {
      setAddons(await fn());
      toast('ok', ok);
    } catch (err) {
      toast('error', 'Nepovedlo se', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const shown = (addons ?? []).filter((a) => a.supported);
  if (shown.length === 0) return null;

  return (
    <section aria-label="Jedním kliknutím" className="grid-auto" style={{ ['--min' as string]: '280px', gap: 14 }}>
      {shown.map((a) => {
        const info = INFO[a.id];
        let text: string;
        if (a.installed && a.reason) text = a.reason;
        else if (!a.installed) text = a.id === 'geyser' ? 'Hráči z mobilů a konzolí se připojí na tenhle Java server.' : 'Živá 3D mapa světa v prohlížeči.';
        else if (a.pendingStart) text = 'Nastaví se při dalším startu serveru.';
        else if (a.id === 'geyser') text = `Bedrock hráči: port ${a.port ?? 19132} (TCP i UDP).`;
        else if (a.needsConsent) text = 'Mapa potřebuje stáhnout textury hry od Mojangu.';
        else text = `Mapa běží na portu ${a.port}.`;
        return (
          <div key={a.id} className="card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ width: 42, height: 42, borderRadius: 10, background: info.tile, flex: 'none' }} aria-hidden="true" />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{info.title}</span>
              <span className="muted small">{text}</span>
            </div>
            {busy === a.id ? (
              <Spinner size={16} />
            ) : !a.installed ? (
              <button type="button" className="btn primary sm" disabled={running} title={running ? 'Nejdřív zastav server' : undefined} onClick={() => void run(a.id, () => api.installAddon(server.id, a.id), `${info.title}: nainstalováno`)}>
                Zapnout
              </button>
            ) : a.needsConsent ? (
              <button type="button" className="btn primary sm" onClick={() => setConsent(true)}>
                Povolit
              </button>
            ) : a.url && running ? (
              <a className="btn sm" href={a.url} target="_blank" rel="noreferrer">
                Otevřít mapu
              </a>
            ) : (
              <button type="button" className="btn sm" disabled={running} title={running ? 'Nejdřív zastav server' : undefined} onClick={() => void run(a.id, () => api.removeAddon(server.id, a.id), `${info.title}: odebráno`)}>
                Odebrat
              </button>
            )}
          </div>
        );
      })}
      {consent && (
        <ConfirmDialog
          title="Stáhnout zdroje hry pro mapu?"
          text={
            <>
              BlueMap stáhne od Mojangu klientskou část Minecraftu (textury a modely). Tím souhlasíš s{' '}
              <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                Minecraft EULA
              </a>
              .
            </>
          }
          confirmLabel="Souhlasím"
          onCancel={() => setConsent(false)}
          onConfirm={() => {
            setConsent(false);
            void run('bluemap', () => api.bluemapConsent(server.id), 'Mapa se začne vykreslovat');
          }}
        />
      )}
    </section>
  );
}
