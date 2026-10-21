import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { DEFAULT_BACKUP_KEEP, type BackupInfo, type BackupSchedule, type PregenRequest, type ServerInfo, type WorldInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { MenuButton, Progress, Slider, Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { ago, bytes, dateTime, nameColor } from '../../format.ts';

const WORLD_TYPES = [
  { value: 'minecraft:normal', label: 'Normální' },
  { value: 'minecraft:flat', label: 'Plochý' },
  { value: 'minecraft:large_biomes', label: 'Velké biomy' },
  { value: 'minecraft:amplified', label: 'Zesílený (amplified)' },
];

const SCHEDULES: { value: BackupSchedule; label: string; hint?: string }[] = [
  { value: 'off', label: 'Vypnuto' },
  { value: 'hourly', label: 'Každou hodinu' },
  { value: '6h', label: 'Každých 6 hodin', hint: '0:00, 6:00, 12:00, 18:00' },
  { value: 'daily', label: 'Každý den' },
  { value: 'weekly', label: 'Každý týden', hint: 'v pondělí' },
];

const TIMES = Array.from({ length: 48 }, (_, i) => {
  const t = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  return { value: t, label: t };
});

const KEEP = [3, 5, 7, 14, 30].map((n) => ({ value: String(n), label: `${n} záloh` }));

const KIND_LABEL: Record<BackupInfo['kind'], string> = { manual: 'ruční', auto: 'automatická', safety: 'před obnovou' };

const PREGEN_SUPPORTED = new Set(['paper', 'purpur', 'spigot', 'fabric', 'quilt', 'forge', 'neoforge', 'arclight']);

function NewWorldDialog({ onCreate, onCancel }: { onCreate: (b: { name: string; seed: string; type: string }) => void; onCancel: () => void }) {
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
          Nový svět
        </h2>
        <p className="muted" style={{ lineHeight: 1.5 }}>
          Svět se vygeneruje při dalším startu serveru. Současný svět zůstane uložený a můžeš se na něj kdykoli vrátit.
        </p>
        <label className="field">
          <span className="label">Název složky</span>
          <input autoFocus className="input mono" value={name} maxLength={48} placeholder="napr. survival2" onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} />
        </label>
        <label className="field">
          <span className="label">Seed (nepovinné)</span>
          <input className="input mono" value={seed} maxLength={64} placeholder="prázdné = náhodný" onChange={(e) => setSeed(e.target.value)} />
        </label>
        <Dropdown label="Typ světa" value={type} options={WORLD_TYPES} onChange={setType} searchable={false} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Zrušit
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            Vytvořit a nastavit aktivní
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
            {pending ? 'vygeneruje se při startu' : [world.version && `verze ${world.version}`, world.seed && `seed ${world.seed}`].filter(Boolean).join(' · ') || 'svět Minecraftu'}
          </span>
        </div>
        <span className="pill" style={world.active ? { background: 'var(--green-soft)', color: 'var(--green-text)' } : { background: 'var(--raised)', color: '#b5bcc4' }}>
          {world.active ? 'Aktivní' : 'Neaktivní'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, fontSize: 13 }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">Velikost</span>
          <span>{pending ? '–' : bytes(world.sizeBytes)}</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">Dimenze</span>
          <span>{pending ? '–' : world.folders.length === 1 ? 'v jedné složce' : world.folders.length}</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">Hráno</span>
          <span>{world.lastPlayed ? ago(world.lastPlayed) : '–'}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {!pending && (
          <a className="btn sm" style={{ flex: '1 1 auto', minHeight: 40 }} href={api.worldDownloadUrl(server.id, world.name)} download>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
            </svg>
            Stáhnout .zip
          </a>
        )}
        {world.active ? (
          !pending && (
            <button type="button" className="btn sm" style={{ flex: '1 1 auto', minHeight: 40, background: 'var(--amber-soft)', borderColor: 'transparent', color: 'var(--amber-text)' }} disabled={busy || running} title={running ? 'Nejdřív zastav server' : undefined} onClick={() => onAction('reset')}>
              Resetovat
            </button>
          )
        ) : (
          <button type="button" className="btn sm primary" style={{ flex: '1 1 auto', minHeight: 40 }} disabled={busy || running} title={running ? 'Nejdřív zastav server' : undefined} onClick={() => onAction('activate')}>
            Nastavit aktivní
          </button>
        )}
        {!world.active && (
          <button type="button" className="btn icon sm" style={{ width: 40, minHeight: 40, color: 'var(--red-text)' }} aria-label={`Smazat svět ${world.name}`} disabled={busy || running} onClick={() => onAction('delete')}>
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
      <div className="stack" style={{ gap: 4 }}>
        <h2 id="h-pregen" className="h2">
          Pre-generace světa
        </h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Chunky vygeneruje mapu předem, takže hráči pak nemají lagy při objevování nových míst.
        </span>
      </div>

      {!PREGEN_SUPPORTED.has(server.type) ? (
        <div className="banner info">Vanilla server neumí pluginy ani mody. Pre-generace funguje na Paperu nebo Fabricu.</div>
      ) : !p?.installed ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <span className="muted" style={{ flex: '1 1 260px', fontSize: 13 }}>
            Chunky ještě není nainstalovaný. Stáhnu ho z Modrinthu i s tím, co potřebuje.
          </span>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void act('Instalace selhala', async () => {
                const r = await api.pregenInstall(server.id);
                toast('ok', 'Chunky nainstalován', r.needsRestart ? 'Restartuj server, aby se načetl.' : 'Načte se při dalším startu.');
              })
            }
          >
            {busy ? <Spinner size={16} /> : null}
            Nainstalovat Chunky
          </button>
        </div>
      ) : (
        <>
          {p.state !== 'idle' && (
            <div className="stack" style={{ gap: 8 }} aria-live="polite">
              <div className="kv" style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--text-2)' }}>
                  {p.state === 'running' ? 'Generuji' : p.state === 'paused' ? 'Pozastaveno' : 'Hotovo'} · {p.world}
                </span>
                <span>{p.pct.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %</span>
              </div>
              <Progress pct={p.pct} />
              <span className="muted small">
                {p.chunks.toLocaleString('cs-CZ')} chunků
                {p.state === 'running' && p.eta ? ` · zbývá ${p.eta}` : ''}
                {p.state === 'running' && p.rate ? ` · ${p.rate.toLocaleString('cs-CZ')} chunků/s` : ''}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {p.state === 'running' && (
                  <button type="button" className="btn sm" disabled={busy || !running} onClick={() => void act('Akce selhala', () => api.pregenAction(server.id, 'pause'))}>
                    Pozastavit
                  </button>
                )}
                {p.state === 'paused' && (
                  <button type="button" className="btn sm primary" disabled={busy || !running} onClick={() => void act('Akce selhala', () => api.pregenAction(server.id, 'continue'))}>
                    Pokračovat
                  </button>
                )}
                {p.state !== 'done' && (
                  <button type="button" className="btn sm ghost" disabled={busy || !running} onClick={() => void act('Akce selhala', () => api.pregenAction(server.id, 'cancel'))}>
                    Zrušit
                  </button>
                )}
              </div>
            </div>
          )}
          {p.state !== 'running' && (
            <div className="stack" style={{ gap: 14 }}>
              <div className="grid-auto" style={{ ['--min' as string]: '200px', gap: 12 }}>
                <Dropdown
                  label="Dimenze"
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
                  label="Tvar"
                  value={shape}
                  onChange={(v) => setShape(v as PregenRequest['shape'])}
                  searchable={false}
                  options={[
                    { value: 'square', label: 'Čtverec' },
                    { value: 'circle', label: 'Kruh' },
                  ]}
                />
              </div>
              <Slider id="pregen-radius" label="Poloměr od středu (0, 0)" valueLabel={`${radius.toLocaleString('cs-CZ')} bloků`} value={radius} min={500} max={20000} step={500} onChange={setRadius} />
              <span className="muted small">Cca {chunksEstimate.toLocaleString('cs-CZ')} chunků. Malý server zvládne 50–200 chunků za sekundu.</span>
              {dimension === 'overworld' && <Toggle label={`Nastavit hranici světa na ${(radius * 2).toLocaleString('cs-CZ')} bloků`} checked={border} onChange={setBorder} />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !running}
                  onClick={() => void act('Start selhal', () => api.pregenStart(server.id, { dimension, radius, shape, setBorder: border && dimension === 'overworld' }), 'Pre-generace spuštěna')}
                >
                  Spustit pre-generaci
                </button>
                {!running && <span className="muted small">Server musí běžet.</span>}
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
        .catch((err: Error) => toast('error', 'Zálohy se nepodařilo načíst', err.message)),
    [server.id, toast],
  );

  // Refresh whenever a backup or restore finishes.
  useEffect(() => {
    if (!server.task) void load();
  }, [load, server.task, server.backupSchedule, server.backupTime, server.backupKeep]);

  const update = (patch: Parameters<typeof api.update>[1]) => void api.update(server.id, patch).catch((err: Error) => toast('error', 'Nastavení se nepodařilo uložit', err.message));
  const schedule = server.backupSchedule ?? 'off';

  return (
    <aside className="col-side card stack" aria-labelledby="h-backup" style={{ gap: 16, alignSelf: 'flex-start' }}>
      <div className="section-head">
        <h2 id="h-backup" className="h2">
          Zálohy
        </h2>
        <button
          type="button"
          className="btn primary sm"
          style={{ minHeight: 40 }}
          disabled={!!server.task || !server.installed}
          onClick={() => void api.createBackup(server.id).catch((err: Error) => toast('error', 'Záloha nezačala', err.message))}
        >
          Zálohovat teď
        </button>
      </div>
      <Dropdown label="Automaticky" value={schedule} options={SCHEDULES} onChange={(v) => update({ backupSchedule: v as BackupSchedule })} searchable={false} />
      {(schedule === 'daily' || schedule === 'weekly') && <Dropdown label="V kolik hodin" value={server.backupTime ?? '04:00'} options={TIMES} onChange={(v) => update({ backupTime: v })} mono />}
      <Dropdown label="Ponechat automatických" value={String(server.backupKeep ?? DEFAULT_BACKUP_KEEP)} options={KEEP} onChange={(v) => update({ backupKeep: Number(v) })} searchable={false} />
      {nextRun && <span className="muted small">Další automatická záloha: {dateTime(nextRun)}</span>}
      <span className="muted small">Ruční zálohy se nemažou. Automatické nad limit ano, nejstarší první.</span>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: 420, overflowY: 'auto' }}>
        {list === null && <Spinner />}
        {list?.length === 0 && <li className="muted small">Zatím žádná záloha.</li>}
        {list?.map((b) => (
          <li key={b.file} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', borderTop: '1px solid #22282f' }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{dateTime(b.createdAt)}</span>
              <span className="muted small">
                {bytes(b.size)} · {KIND_LABEL[b.kind]}
              </span>
            </span>
            <button type="button" className="btn sm" disabled={!!server.task || !stopped} title={stopped ? undefined : 'Nejdřív zastav server'} onClick={() => setRestoring(b)}>
              Obnovit
            </button>
            <MenuButton
              label={`Akce se zálohou ${dateTime(b.createdAt)}`}
              items={[
                { label: 'Stáhnout', onClick: () => (window.location.href = api.backupDownloadUrl(server.id, b.file)) },
                { label: 'Smazat', color: 'var(--red-text)', onClick: () => setDeleting(b) },
              ]}
            />
          </li>
        ))}
      </ul>
      <div className="stack" style={{ gap: 4, fontSize: 12 }}>
        <span className="muted">Složka záloh</span>
        <span className="mono" style={{ color: 'var(--text-2)', wordBreak: 'break-all' }}>
          {server.dir.replace(/servers[\\/][^\\/]+$/, `backups\\${server.id}`)}
        </span>
      </div>

      {restoring && (
        <ConfirmDialog
          title={`Obnovit zálohu z ${dateTime(restoring.createdAt)}?`}
          text="Současný stav se nejdřív sám zazálohuje (záloha „před obnovou“). Potom se svět, pluginy a nastavení vrátí do stavu ze zálohy."
          confirmLabel="Obnovit"
          onCancel={() => setRestoring(null)}
          onConfirm={() => {
            const b = restoring;
            setRestoring(null);
            void api.restoreBackup(server.id, b.file).catch((err: Error) => toast('error', 'Obnova nezačala', err.message));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Smazat zálohu?"
          text={`Záloha z ${dateTime(deleting.createdAt)} (${bytes(deleting.size)}) se smaže natrvalo.`}
          confirmLabel="Smazat natrvalo"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const b = deleting;
            setDeleting(null);
            void api
              .deleteBackup(server.id, b.file)
              .then((r) => setList(r.backups))
              .catch((err: Error) => toast('error', 'Smazání selhalo', err.message));
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

  const load = useCallback(() => api.worlds(server.id).then(setWorlds).catch((err: Error) => toast('error', 'Světy se nepodařilo načíst', err.message)), [server.id, toast]);

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
    if (!/\.zip$/i.test(file.name)) return toast('error', 'Nahraj svět jako .zip');
    setUpload({ name: file.name, pct: 0 });
    try {
      const r = await api.importWorld(server.id, file, importName.trim() || file.name.replace(/\.zip$/i, ''), activate && !running, (pct) => setUpload({ name: file.name, pct }));
      setWorlds(r.worlds);
      toast('ok', `Svět nahrán jako „${r.name}“`, activate && !running ? 'Je nastavený jako aktivní.' : undefined);
      setImportName('');
    } catch (err) {
      toast('error', 'Nahrání světa selhalo', (err as Error).message);
    } finally {
      setUpload(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void importFile(e.dataTransfer.files[0]);
  };

  return (
    <div className="row">
      <div className="col-main">
        <section className="stack" aria-labelledby="h-worlds" style={{ gap: 14 }}>
          <div className="section-head">
            <h2 id="h-worlds" className="h2">
              Světy
            </h2>
            <button type="button" className="btn" disabled={busy || running} title={running ? 'Nejdřív zastav server' : undefined} onClick={() => setNewOpen(true)}>
              <Icon name="plus" size={17} strokeWidth={2.2} />
              Nový svět
            </button>
          </div>
          {running && <div className="banner info">Server běží. Přepnout, resetovat nebo smazat svět jde až po zastavení. Stahovat můžeš i za běhu.</div>}
          <div className="grid-auto" style={{ ['--min' as string]: '320px', gap: 14 }}>
            {worlds === null && <Spinner />}
            {worlds?.map((w) => (
              <WorldCard
                key={w.name}
                world={w}
                server={server}
                busy={busy}
                onAction={(a) => (a === 'activate' ? void run('Přepnutí selhalo', () => api.activateWorld(server.id, w.name), `Aktivní svět: ${w.name}`) : setConfirm({ world: w, action: a }))}
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
                  Nahrávám {upload.name} · {upload.pct} %
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
                <div className="stack" style={{ gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>Přetáhni sem svět (.zip)</span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    Najdu level.dat i složky Netheru a Endu. Funguje i zip ze singleplayeru (.minecraft/saves).
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', alignItems: 'center' }}>
                  <input className="input mono" style={{ width: 200 }} value={importName} maxLength={48} placeholder="název (nepovinné)" aria-label="Název nahraného světa" onChange={(e) => setImportName(e.target.value)} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: running ? 'var(--muted)' : 'var(--text-2)' }}>
                    <input type="checkbox" className="check" checked={activate && !running} disabled={running} onChange={(e) => setActivate(e.target.checked)} />
                    Nastavit jako aktivní
                  </label>
                  <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
                  <button type="button" className="btn primary" disabled={!!server.task} onClick={() => fileRef.current?.click()}>
                    Vybrat soubor
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        <PregenCard server={server} />
      </div>

      <BackupsPanel server={server} />

      {newOpen && (
        <NewWorldDialog
          onCancel={() => setNewOpen(false)}
          onCreate={(b) => {
            setNewOpen(false);
            void run('Svět se nepodařilo založit', () => api.newWorld(server.id, { name: b.name, seed: b.seed, type: b.type }), `Nový svět ${b.name} se vygeneruje při startu`);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'reset' ? `Resetovat svět ${confirm.world.name}?` : `Smazat svět ${confirm.world.name}?`}
          text={
            confirm.action === 'reset'
              ? 'Svět se přesune do koše srvMC a při dalším startu se vygeneruje nový se stejným seedem. Chceš-li jistotu, udělej předtím zálohu.'
              : 'Svět se přesune do koše srvMC (složka trash). Odtud ho jde ručně vrátit.'
          }
          confirmLabel={confirm.action === 'reset' ? 'Resetovat' : 'Přesunout do koše'}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void (c.action === 'reset'
              ? run('Reset selhal', () => api.resetWorld(server.id, c.world.name), 'Svět resetován')
              : run('Mazání selhalo', () => api.deleteWorld(server.id, c.world.name), 'Svět přesunut do koše'));
          }}
        />
      )}
    </div>
  );
}
