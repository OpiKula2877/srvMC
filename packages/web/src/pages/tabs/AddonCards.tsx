import { useCallback, useEffect, useState } from 'react';
import type { AddonId, AddonState, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { t } from '@srvmc/shared';

const INFO: Record<AddonId, { title: string; tile: string }> = {
  geyser: { title: t('Crossplay with Bedrock'), tile: '#6AA9FF' },
  bluemap: { title: t('World map (BlueMap)'), tile: '#5BD27A' },
};

export function AddonCards({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [addons, setAddons] = useState<AddonState[] | null>(null);
  const [busy, setBusy] = useState<AddonId | null>(null);
  // 'install': asked when turning the map on; 'allow': asked later, after the first start.
  const [consent, setConsent] = useState<'install' | 'allow' | null>(null);
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
      toast('error', t('That did not work'), (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const shown = (addons ?? []).filter((a) => a.supported);
  if (shown.length === 0) return null;

  return (
    <section aria-label={t('One click')} className="grid-auto" style={{ ['--min' as string]: '280px', gap: 14 }}>
      {shown.map((a) => {
        const info = INFO[a.id];
        let text: string;
        if (a.installed && a.reason) text = a.reason;
        else if (!a.installed) text = a.id === 'geyser' ? t('Players on phones and consoles can join this Java server.') : t('A live 3D map of the world in the browser.');
        else if (a.pendingStart) text = t('It is set up on the next server start.');
        else if (a.id === 'geyser') text = t('Bedrock players: port {port} (TCP and UDP).', { port: a.port ?? 19132 });
        else if (a.needsConsent) text = t("The map needs to download the game's textures from Mojang.");
        else text = t('The map runs on port {port}.', { port: a.port ?? '' });
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
              <button type="button" className="btn primary sm" disabled={running} title={running ? t('Stop the server first') : undefined} onClick={() => (a.id === 'bluemap' ? setConsent('install') : void run(a.id, () => api.installAddon(server.id, a.id), t('{name}: installed', { name: info.title })))}>
                {t('Turn on')}
              </button>
            ) : a.needsConsent ? (
              <button type="button" className="btn primary sm" onClick={() => setConsent('allow')}>
                {t('Allow')}
              </button>
            ) : a.url && running ? (
              <a className="btn sm" href={a.url} target="_blank" rel="noreferrer">
                {t('Open map')}
              </a>
            ) : (
              <button type="button" className="btn sm" disabled={running} title={running ? t('Stop the server first') : undefined} onClick={() => void run(a.id, () => api.removeAddon(server.id, a.id), t('{name}: removed', { name: info.title }))}>
                {t('Remove')}
              </button>
            )}
          </div>
        );
      })}
      {consent && (
        <ConfirmDialog
          title={t('Do you want to allow accept-download?')}
          text={
            <>
              {t('BlueMap downloads the client part of Minecraft (textures and models) from Mojang. By doing so you agree to the')}{' '}
              <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                Minecraft EULA
              </a>
              .
            </>
          }
          confirmLabel={t('Yes')}
          cancelLabel={t('No')}
          onCancel={() => {
            const was = consent;
            setConsent(null);
            if (was === 'install') void run('bluemap', () => api.installAddon(server.id, 'bluemap'), t('{name}: installed', { name: INFO.bluemap.title }));
          }}
          onConfirm={() => {
            const was = consent;
            setConsent(null);
            if (was === 'install') void run('bluemap', () => api.installAddon(server.id, 'bluemap', true), t('{name}: installed', { name: INFO.bluemap.title }));
            else void run('bluemap', () => api.bluemapConsent(server.id), t('The map starts rendering'));
          }}
        />
      )}
    </section>
  );
}
