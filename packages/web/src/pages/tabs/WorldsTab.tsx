import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { DEFAULT_BACKUP_KEEP, editionOf, type BackupInfo, type BackupSchedule, type PregenRequest, type ServerInfo, type WorldInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { MenuButton, Progress, Slider, Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { DatapacksCard } from './DatapacksCard.tsx';
import { ago, bytes, dateTime, nameColor } from '../../format.ts';
import { href } from '../../router.ts';
import { locale, t } from '@srvmc/shared';

const WORLD_TYPES = [
  { value: 'minecraft:normal', label: t('Normal') },
  { value: 'minecraft:flat', label: t('Flat') },
  { value: 'minecraft:large_biomes', label: t('Large biomes') },
  { value: 'minecraft:amplified', label: t('Amplified') },
];

const SCHEDULES: { value: BackupSchedule; label: string }[] = [
  { value: 'off', label: t('Off') },
  { value: 'hourly', label: t('Every hour') },
  { value: '6h', label: t('Every 6 hours') },
  { value: 'daily', label: t('Every day') },
  { value: 'weekly', label: t('Every Monday') },
];

const TIMES = Array.from({ length: 48 }, (_, i) => {
  const t = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  return { value: t, label: t };
});

const KEEP = [3, 5, 7, 14, 30].map((n) => ({ value: String(n), label: t('{n} backups', { n }) }));

const KIND_LABEL: Record<BackupInfo['kind'], string> = { manual: t('manual'), auto: t('automatic'), safety: t('before restore') };

const PREGEN_SUPPORTED = new Set(['paper', 'purpur', 'spigot', 'fabric', 'quilt', 'forge', 'neoforge', 'arclight']);

function NewWorldDialog({ onCreate, onCancel, bedrock }: { onCreate: (b: { name: string; seed: string; type: string }) => void; onCancel: () => void; bedrock: boolean }) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [type, setType] = useState('minecraft:normal');
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nw-title"
        style={{ maxWidth: 440 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate({ name: name.trim(), seed: seed.trim(), type });
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <h2 id="nw-title" style={{ fontSize: 18, fontWeight: 600 }}>
          {t('New world')}
        </h2>
        <p className="muted" style={{ lineHeight: 1.5 }}>
          {t('The world is generated on the next server start. The current world stays saved and you can switch back any time.')}
        </p>
        <label className="field">
          <span className="label">{t('Folder name')}</span>
          <input autoFocus className="input mono" value={name} maxLength={48} placeholder={t('e.g. survival2')} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} />
        </label>
        <label className="field">
          <span className="label">{t('Seed (optional)')}</span>
          <input className="input mono" value={seed} maxLength={64} placeholder={t('empty = random')} onChange={(e) => setSeed(e.target.value)} />
        </label>
        {!bedrock && <Dropdown label={t('World type')} value={type} options={WORLD_TYPES} onChange={setType} searchable={false} />}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            {t('Create and make active')}
          </button>
        </div>
      </form>
    </div>
  );
}

function WorldCard({ world, server, busy, onAction }: { world: WorldInfo; server: ServerInfo; busy: boolean; onAction: (a: 'activate' | 'reset' | 'delete') => void }) {
  const running = server.status !== 'stopped' && server.status !== 'crashed' && server.status !== 'error';
  const pending = world.folders.length === 0;
  return (
    <article className="card stack" style={{ gap: 14, borderColor: world.active ? '#2f6b42' : undefined, borderWidth: 2 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ width: 48, height: 48, borderRadius: 8, background: nameColor(world.name), flex: 'none' }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="mono" style={{ fontWeight: 600, wordBreak: 'break-all' }}>
            {world.name}
          </span>
          <span className="muted small">
            {pending ? t('generated on start') : [world.version && t('version {v}', { v: world.version }), world.seed && `seed ${world.seed}`].filter(Boolean).join(' · ') || t('Minecraft world')}
          </span>
        </div>
        <span className="pill" style={world.active ? { background: 'var(--green-soft)', color: 'var(--green-text)' } : { background: 'var(--raised)', color: '#b5bcc4' }}>
          {world.active ? t('Active') : t('Inactive')}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, fontSize: 13 }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">{t('Size')}</span>
          <span>{pending ? '–' : bytes(world.sizeBytes)}</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">{t('Dimensions')}</span>
          <span>{pending ? '–' : world.folders.length === 1 ? t('in one folder') : world.folders.length}</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">{t('Played')}</span>
          <span>{world.lastPlayed ? ago(world.lastPlayed) : '–'}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {!pending && (
          <a className="btn sm" style={{ flex: '1 1 auto', minHeight: 40 }} href={api.worldDownloadUrl(server.id, world.name)} download>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
            </svg>
            {t('Download .zip')}
          </a>
        )}
        {world.active ? (
          !pending && (
            <button type="button" className="btn sm" style={{ flex: '1 1 auto', minHeight: 40, background: 'var(--amber-soft)', borderColor: 'transparent', color: 'var(--amber-text)' }} disabled={busy || running} title={running ? t('Stop the server first') : undefined} onClick={() => onAction('reset')}>
              {t('Reset')}
            </button>
          )
        ) : (
          <button type="button" className="btn sm primary" style={{ flex: '1 1 auto', minHeight: 40 }} disabled={busy || running} title={running ? t('Stop the server first') : undefined} onClick={() => onAction('activate')}>
            {t('Make active')}
          </button>
        )}
        {!world.active && (
          <button type="button" className="btn icon sm" style={{ width: 40, minHeight: 40, color: 'var(--red-text)' }} aria-label={t('Delete world {name}', { name: world.name })} disabled={busy || running} onClick={() => onAction('delete')}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

function PregenCard({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [radius, setRadius] = useState(3000);
  const [dimension, setDimension] = useState<PregenRequest['dimension']>('overworld');
  const [shape, setShape] = useState<PregenRequest['shape']>('square');
  const [border, setBorder] = useState(true);
  const [busy, setBusy] = useState(false);
  const p = server.pregen;
  const running = server.status === 'running';
  const chunksEstimate = Math.round(((radius * 2) / 16) ** 2 * (shape === 'circle' ? Math.PI / 4 : 1));

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast('ok', ok);
    } catch (err) {
      toast('error', label, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-pregen" style={{ gap: 14 }}>
      <h2 id="h-pregen" className="h2">
        {t('World pre-generation')}
      </h2>

      {!PREGEN_SUPPORTED.has(server.type) ? (
        <div className="banner info">{t('A Vanilla server has no plugins or mods. Pre-generation works on Paper or Fabric.')}</div>
      ) : !p?.installed ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <span className="muted" style={{ flex: '1 1 260px', fontSize: 13 }}>
            {t('Chunky is not installed.')}
          </span>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void act(t('Installing failed'), async () => {
                const r = await api.pregenInstall(server.id);
                toast('ok', t('Chunky installed'), r.needsRestart ? t('Restart the server to load it.') : t('It loads on the next start.'));
              })
            }
          >
            {busy ? <Spinner size={16} /> : null}
            {t('Install Chunky')}
          </button>
        </div>
      ) : (
        <>
          {p.state !== 'idle' && (
            <div className="stack" style={{ gap: 8 }} aria-live="polite">
              <div className="kv" style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--text-2)' }}>
                  {p.state === 'running' ? t('Generating') : p.state === 'paused' ? t('Paused') : t('Done')} · {p.world}
                </span>
                <span>{p.pct.toLocaleString(locale(), { maximumFractionDigits: 1 })} %</span>
              </div>
              <Progress pct={p.pct} />
              <span className="muted small">
                {t('{n} chunks', { n: p.chunks.toLocaleString(locale()) })}
                {p.state === 'running' && p.eta ? ` · ${t('{time} left', { time: p.eta })}` : ''}
                {p.state === 'running' && p.rate ? ` · ${t('{n} chunks/s', { n: p.rate.toLocaleString(locale()) })}` : ''}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {p.state === 'running' && (
                  <button type="button" className="btn sm" disabled={busy || !running} onClick={() => void act(t('The action failed'), () => api.pregenAction(server.id, 'pause'))}>
                    {t('Pause')}
                  </button>
                )}
                {p.state === 'paused' && (
                  <button type="button" className="btn sm primary" disabled={busy || !running} onClick={() => void act(t('The action failed'), () => api.pregenAction(server.id, 'continue'))}>
                    {t('Continue')}
                  </button>
                )}
                {p.state !== 'done' && (
                  <button type="button" className="btn sm ghost" disabled={busy || !running} onClick={() => void act(t('The action failed'), () => api.pregenAction(server.id, 'cancel'))}>
                    {t('Cancel')}
                  </button>
                )}
              </div>
            </div>
          )}
          {p.state !== 'running' && (
            <div className="stack" style={{ gap: 14 }}>
              <div className="grid-auto" style={{ ['--min' as string]: '200px', gap: 12 }}>
                <Dropdown
                  label={t('Dimension')}
                  value={dimension}
                  onChange={(v) => setDimension(v as PregenRequest['dimension'])}
                  searchable={false}
                  options={[
                    { value: 'overworld', label: 'Overworld' },
                    { value: 'nether', label: 'Nether' },
                    { value: 'end', label: 'End' },
                  ]}
                />
                <Dropdown
                  label={t('Shape')}
                  value={shape}
                  onChange={(v) => setShape(v as PregenRequest['shape'])}
                  searchable={false}
                  options={[
                    { value: 'square', label: t('Square') },
                    { value: 'circle', label: t('Circle') },
                  ]}
                />
              </div>
              <Slider id="pregen-radius" label={t('Radius from the center (0, 0)')} valueLabel={t('{n} blocks', { n: radius.toLocaleString(locale()) })} value={radius} min={500} max={20000} step={500} onChange={setRadius} />
              <span className="muted small">{t('About {n} chunks', { n: chunksEstimate.toLocaleString(locale()) })}</span>
              {dimension === 'overworld' && <Toggle label={t('Set the world border to {n} blocks', { n: (radius * 2).toLocaleString(locale()) })} checked={border} onChange={setBorder} />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !running}
                  onClick={() => void act(t('Starting failed'), () => api.pregenStart(server.id, { dimension, radius, shape, setBorder: border && dimension === 'overworld' }), t('Pre-generation started'))}
                >
                  {t('Start pre-generation')}
                </button>
                {!running && <span className="muted small">{t('The server must be running.')}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BackupsPanel({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [nextRun, setNextRun] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState<BackupInfo | null>(null);
  const stopped = server.status === 'stopped' || server.status === 'crashed' || server.status === 'error';

  const load = useCallback(
    () =>
      api
        .backups(server.id)
        .then((r) => {
          setList(r.backups);
          setNextRun(r.nextRun);
        })
        .catch((err: Error) => toast('error', t('Could not load the backups'), err.message)),
    [server.id, toast],
  );

  // Refresh whenever a backup or restore finishes.
  useEffect(() => {
    if (!server.task) void load();
  }, [load, server.task, server.backupSchedule, server.backupTime, server.backupKeep]);

  const update = (patch: Parameters<typeof api.update>[1]) => void api.update(server.id, patch).catch((err: Error) => toast('error', t('Could not save the settings'), err.message));
  const schedule = server.backupSchedule ?? 'off';

  return (
    <aside className="col-side card stack" aria-labelledby="h-backup" style={{ gap: 16, alignSelf: 'flex-start' }}>
      <div className="section-head">
        <h2 id="h-backup" className="h2">
          {t('Backups')}
        </h2>
        <button
          type="button"
          className="btn primary sm"
          style={{ minHeight: 40 }}
          disabled={!!server.task || !server.installed}
          onClick={() => void api.createBackup(server.id).catch((err: Error) => toast('error', t('The backup did not start'), err.message))}
        >
          {t('Back up now')}
        </button>
      </div>
      <Dropdown label={t('Automatically')} value={schedule} options={SCHEDULES} onChange={(v) => update({ backupSchedule: v as BackupSchedule })} searchable={false} />
      {(schedule === 'daily' || schedule === 'weekly') && <Dropdown label={t('At what time')} value={server.backupTime ?? '04:00'} options={TIMES} onChange={(v) => update({ backupTime: v })} mono />}
      <Dropdown label={t('Automatic backups to keep')} value={String(server.backupKeep ?? DEFAULT_BACKUP_KEEP)} options={KEEP} onChange={(v) => update({ backupKeep: Number(v) })} searchable={false} />
      {nextRun && <span className="muted small">{t('Next automatic backup: {time}', { time: dateTime(nextRun) })}</span>}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: 420, overflowY: 'auto' }}>
        {list === null && <Spinner />}
        {list?.length === 0 && <li className="muted small">{t('No backups yet.')}</li>}
        {list?.map((b) => (
          <li key={b.file} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', borderTop: '1px solid #22282f' }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{dateTime(b.createdAt)}</span>
              <span className="muted small">
                {bytes(b.size)} · {KIND_LABEL[b.kind]}
              </span>
            </span>
            <button type="button" className="btn sm" disabled={!!server.task || !stopped} title={stopped ? undefined : t('Stop the server first')} onClick={() => setRestoring(b)}>
              {t('Restore')}
            </button>
            <MenuButton
              label={t('Actions for the backup from {time}', { time: dateTime(b.createdAt) })}
              items={[
                { label: t('Download'), onClick: () => (window.location.href = api.backupDownloadUrl(server.id, b.file)) },
                { label: t('Delete'), color: 'var(--red-text)', onClick: () => setDeleting(b) },
              ]}
            />
          </li>
        ))}
      </ul>
      <div className="stack" style={{ gap: 4, fontSize: 12 }}>
        <span className="muted">{t('Backup folder')}</span>
        <span className="mono" style={{ color: 'var(--text-2)', wordBreak: 'break-all' }}>
          {server.dir.replace(/servers[\\/][^\\/]+$/, `backups\\${server.id}`)}
        </span>
      </div>

      {restoring && (
        <ConfirmDialog
          title={t('Restore the backup from {time}?', { time: dateTime(restoring.createdAt) })}
          text={t('The current state is backed up first (a "before restore" backup). Then the world, plugins and settings go back to the backup.')}
          confirmLabel={t('Restore')}
          onCancel={() => setRestoring(null)}
          onConfirm={() => {
            const b = restoring;
            setRestoring(null);
            void api.restoreBackup(server.id, b.file).catch((err: Error) => toast('error', t('The restore did not start'), err.message));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('Delete the backup?')}
          text={t('The backup from {time} ({size}) is deleted for good.', { time: dateTime(deleting.createdAt), size: bytes(deleting.size) })}
          confirmLabel={t('Delete for good')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const b = deleting;
            setDeleting(null);
            void api
              .deleteBackup(server.id, b.file)
              .then((r) => setList(r.backups))
              .catch((err: Error) => toast('error', t('Deleting failed'), err.message));
          }}
        />
      )}
    </aside>
  );
}

export function WorldsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ world: WorldInfo; action: 'reset' | 'delete' } | null>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [importName, setImportName] = useState('');
  const [activate, setActivate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const running = server.status !== 'stopped' && server.status !== 'crashed' && server.status !== 'error';
  const edition = editionOf(server.type);
  const bedrock = edition === 'bedrock';

  const load = useCallback(() => api.worlds(server.id).then(setWorlds).catch((err: Error) => toast('error', t('Could not load the worlds'), err.message)), [server.id, toast]);

  useEffect(() => {
    if (!server.task) void load();
  }, [load, server.status, server.task]);

  const run = async (label: string, fn: () => Promise<WorldInfo[]>, ok?: string) => {
    setBusy(true);
    try {
      setWorlds(await fn());
      if (ok) toast('ok', ok);
    } catch (err) {
      toast('error', label, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(zip|mcworld)$/i.test(file.name)) return toast('error', bedrock ? t('Upload the world as .mcworld or .zip') : t('Upload the world as .zip'));
    setUpload({ name: file.name, pct: 0 });
    try {
      const r = await api.importWorld(server.id, file, importName.trim() || file.name.replace(/\.(zip|mcworld)$/i, ''), activate && !running, (pct) => setUpload({ name: file.name, pct }));
      setWorlds(r.worlds);
      toast('ok', t('World uploaded as "{name}"', { name: r.name }), activate && !running ? t('It is set as active.') : undefined);
      setImportName('');
    } catch (err) {
      toast('error', t('Uploading the world failed'), (err as Error).message);
    } finally {
      setUpload(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void importFile(e.dataTransfer.files[0]);
  };

  if (edition === 'hytale') {
    return (
      <div className="row">
        <div className="col-main">
          <div className="empty">
            <span style={{ fontWeight: 600 }}>{t('The Hytale world is in the universe folder')}</span>
            <a className="btn" href={href({ page: 'server', id: server.id, tab: 'soubory', file: 'universe' })}>
              {t('Open in Files')}
            </a>
          </div>
        </div>
        <BackupsPanel server={server} />
      </div>
    );
  }

  return (
    <div className="row">
      <div className="col-main">
        <section className="stack" aria-labelledby="h-worlds" style={{ gap: 14 }}>
          <div className="section-head">
            <h2 id="h-worlds" className="h2">
              {t('Worlds')}
            </h2>
            <button type="button" className="btn" disabled={busy || running} title={running ? t('Stop the server first') : undefined} onClick={() => setNewOpen(true)}>
              <Icon name="plus" size={17} strokeWidth={2.2} />
              {t('New world')}
            </button>
          </div>
          {running && <div className="banner info">{t('The server is running. Switching, resetting or deleting a world works once it is stopped. Downloading works while it runs.')}</div>}
          <div className="grid-auto" style={{ ['--min' as string]: '320px', gap: 14 }}>
            {worlds === null && <Spinner />}
            {worlds?.map((w) => (
              <WorldCard
                key={w.name}
                world={w}
                server={server}
                busy={busy}
                onAction={(a) => (a === 'activate' ? void run(t('Switching failed'), () => api.activateWorld(server.id, w.name), t('Active world: {name}', { name: w.name })) : setConfirm({ world: w, action: a }))}
              />
            ))}
          </div>

          <div
            className={`empty dropzone${dragOver ? ' over' : ''}`}
            style={{ padding: 24, gap: 14 }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {upload ? (
              <div className="stack" style={{ width: '100%', maxWidth: 420, gap: 8 }}>
                <span>
                  {t('Uploading {name} · {pct} %', { name: upload.name, pct: upload.pct })}
                </span>
                <Progress pct={upload.pct} />
              </div>
            ) : (
              <>
                <span style={{ color: 'var(--green)' }}>
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 21V9M7 14l5-5 5 5M4 3h16" />
                  </svg>
                </span>
                <span style={{ fontWeight: 600 }}>{bedrock ? t('Drop a world here (.mcworld or .zip)') : t('Drop a world here (.zip)')}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', alignItems: 'center' }}>
                  <input className="input mono" style={{ width: 200 }} value={importName} maxLength={48} placeholder={t('name (optional)')} aria-label={t('Name of the uploaded world')} onChange={(e) => setImportName(e.target.value)} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: running ? 'var(--muted)' : 'var(--text-2)' }}>
                    <input type="checkbox" className="check" checked={activate && !running} disabled={running} onChange={(e) => setActivate(e.target.checked)} />
                    {t('Make it active')}
                  </label>
                  <input ref={fileRef} type="file" accept={bedrock ? '.mcworld,.zip,application/zip' : '.zip,application/zip'} hidden onChange={(e) => void importFile(e.target.files?.[0])} />
                  <button type="button" className="btn primary" disabled={!!server.task} onClick={() => fileRef.current?.click()}>
                    {t('Choose a file')}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        <PregenCard server={server} />
      </div>

      {edition === 'java' && <DatapacksCard server={server} />}

      <BackupsPanel server={server} />

      {newOpen && (
        <NewWorldDialog
          bedrock={bedrock}
          onCancel={() => setNewOpen(false)}
          onCreate={(b) => {
            setNewOpen(false);
            void run(t('Could not create the world'), () => api.newWorld(server.id, { name: b.name, seed: b.seed, type: b.type }), t('The new world {name} is generated on start', { name: b.name }));
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'reset' ? t('Reset world {name}?', { name: confirm.world.name }) : t('Delete world {name}?', { name: confirm.world.name })}
          text={
            confirm.action === 'reset'
              ? t("The world moves to srvMC's trash and a new one with the same seed is generated on the next start. To be safe, make a backup first.")
              : t("The world moves to srvMC's trash (the trash folder). You can bring it back from there by hand.")
          }
          confirmLabel={confirm.action === 'reset' ? t('Reset') : t('Move to trash')}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void (c.action === 'reset'
              ? run(t('Resetting failed'), () => api.resetWorld(server.id, c.world.name), t('World reset'))
              : run(t('Deleting failed'), () => api.deleteWorld(server.id, c.world.name), t('World moved to trash')));
          }}
        />
      )}
    </div>
  );
}
