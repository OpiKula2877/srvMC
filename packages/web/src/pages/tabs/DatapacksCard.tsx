import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatapackInfo, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { Progress, Toggle } from '../../components/Controls.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { bytes } from '../../format.ts';
import { t } from '@srvmc/shared';

/** Datapacks of the active world: upload a .zip, turn packs on and off, delete them. */
export function DatapacksCard({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [packs, setPacks] = useState<DatapackInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [deleting, setDeleting] = useState<DatapackInfo | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const running = server.status !== 'stopped' && server.status !== 'crashed' && server.status !== 'error';

  const load = useCallback(() => api.datapacks(server.id).then(setPacks).catch((err: Error) => toast('error', t('Could not load the datapacks'), err.message)), [server.id, toast]);
  useEffect(() => {
    void load();
  }, [load, server.status]);

  const run = async (fn: () => Promise<DatapackInfo[]>, ok: string) => {
    setBusy(true);
    try {
      setPacks(await fn());
      toast('ok', ok);
    } catch (err) {
      toast('error', t('That did not work'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file?: File) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast('error', t('Choose a .zip file'), t('Datapacks come as .zip files.'));
      return;
    }
    setUpload({ name: file.name, pct: 0 });
    try {
      setPacks(await api.uploadDatapack(server.id, file, (pct) => setUpload({ name: file.name, pct })));
      toast('ok', t('Datapack {name} added', { name: file.name }), running ? t('It loads after /reload or the next start.') : undefined);
    } catch (err) {
      toast('error', t('Could not add the datapack'), (err as Error).message);
    } finally {
      setUpload(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="card stack" aria-label={t('Datapacks')} style={{ gap: 14 }}>
      <div className="section-head">
        <div className="stack" style={{ gap: 2 }}>
          <h2 className="h2" style={{ fontSize: 15 }}>
            {t('Datapacks')}
          </h2>
          <span className="muted small">{t('For the active world. Works on every Java server, vanilla too.')}</span>
        </div>
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => void uploadFile(e.target.files?.[0])} />
        <button type="button" className="btn sm primary" style={{ minHeight: 40 }} disabled={!!upload || busy} onClick={() => fileRef.current?.click()}>
          <Icon name="plus" size={15} />
          {t('Add datapack')}
        </button>
      </div>
      {upload && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">{t('Uploading {name} · {pct} %', { name: upload.name, pct: upload.pct })}</span>
          <Progress pct={upload.pct} />
        </div>
      )}
      {packs === null && <Spinner />}
      {packs?.length === 0 && <span className="muted small">{t('No datapacks yet. Add a .zip you downloaded, for example from Modrinth or Planet Minecraft.')}</span>}
      {packs?.map((p) => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="mono" style={{ fontWeight: 500, wordBreak: 'break-all' }}>
              {p.name}
            </span>
            <span className="muted small">
              {p.locked ? t('srvMC login (managed by srvMC)') : p.kind === 'zip' ? `zip · ${bytes(p.size ?? 0)}` : t('folder')}
            </span>
          </div>
          {!p.locked && (
            <>
              <Toggle
                label={<span className="sr-only">{t('Turn {name} on', { name: p.name })}</span>}
                checked={p.enabled}
                disabled={busy || running}
                onChange={(v) => void run(() => api.setDatapackEnabled(server.id, p.name, v), v ? t('Datapack {name} turned on.', { name: p.name }) : t('Datapack {name} turned off.', { name: p.name }))}
              />
              <button type="button" className="btn icon sm" style={{ width: 40, minHeight: 40, color: 'var(--red-text)' }} aria-label={t('Delete {name}', { name: p.name })} disabled={busy || running} title={running ? t('Stop the server first') : undefined} onClick={() => setDeleting(p)}>
                <Icon name="trash" size={15} />
              </button>
            </>
          )}
        </div>
      ))}
      {deleting && (
        <ConfirmDialog
          title={t('Delete the datapack {name}?', { name: deleting.name })}
          text={t('The datapack is deleted for good. Things it added to the world stay.')}
          confirmLabel={t('Delete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            void run(() => api.removeDatapack(server.id, d.name), t('Datapack {name} deleted.', { name: d.name }));
          }}
        />
      )}
    </section>
  );
}
