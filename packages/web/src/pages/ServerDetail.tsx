import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ServerInfo, SystemInfo } from '@srvmc/shared';
import { api } from '../api.ts';
import { Progress, RamPicker, Sparkline, StatusPill, Toggle } from '../components/Controls.tsx';
import { Dropdown } from '../components/Dropdown.tsx';
import { Icon } from '../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../components/Overlays.tsx';
import { AddressBox, ServerTile } from '../components/ServerBits.tsx';
import { clock, gb, isActive, mcVersion, typeName } from '../format.ts';
import { loadHistory, useLive } from '../live.ts';
import { href, navigate } from '../router.ts';
import { FilesTab } from './tabs/FilesTab.tsx';
import { LogsTab } from './tabs/LogsTab.tsx';
import { OptionsTab } from './tabs/OptionsTab.tsx';
import { PlayersTab } from './tabs/PlayersTab.tsx';
import { GraphsTab } from './tabs/GraphsTab.tsx';
import { ModsTab } from './tabs/ModsTab.tsx';
import { NetworkTab } from './tabs/NetworkTab.tsx';
import { ScheduleTab } from './tabs/ScheduleTab.tsx';
import { WorldsTab } from './tabs/WorldsTab.tsx';

const TIMEZONES = (() => {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Europe/Prague', 'Europe/Bratislava', 'UTC'];
  return [{ value: '', label: 'Podle počítače' }, ...zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))];
})();

const SLEEP_OPTIONS = [
  { value: '0', label: 'Nikdy' },
  { value: '5', label: 'Po 5 minutách' },
  { value: '10', label: 'Po 10 minutách' },
  { value: '15', label: 'Po 15 minutách' },
  { value: '30', label: 'Po 30 minutách' },
  { value: '60', label: 'Po hodině' },
  { value: '120', label: 'Po 2 hodinách' },
];

const TABS: { id: string; label: string; phase?: number }[] = [
  { id: 'konzole', label: 'Konzole' },
  { id: 'nastaveni', label: 'Nastavení' },
  { id: 'hraci', label: 'Hráči' },
  { id: 'moznosti', label: 'Možnosti' },
  { id: 'zaznamy', label: 'Záznamy' },
  { id: 'soubory', label: 'Soubory' },
  { id: 'svety', label: 'Světy' },
  { id: 'mody', label: 'Mody a pluginy' },
  { id: 'grafy', label: 'Grafy' },
  { id: 'planovac', label: 'Plánovač' },
  { id: 'sit', label: 'Síť a doména' },
];

const QUICK = ['list', 'save-all', 'time set day', 'weather clear', 'say Restart za 5 minut'];

// Paper prints "[12:00:00 INFO]: ", vanilla "[12:00:00] [Server thread/INFO]: ", Forge-family servers add
// a logger name ("[minecraft/MinecraftServer]"). The panel shows its own time column.
const SERVER_PREFIX_RE = /^\[\d{2}:\d{2}:\d{2}(?: [A-Z]+)?\](?: \[[^\]]+\])*: ?/;

function Console({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const lines = useLive((s) => s.logs[server.id]) ?? [];
  const [cmd, setCmd] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = server.status === 'running' || server.status === 'starting';

  const shown = errorsOnly ? lines.filter((l) => l.level === 'error' || l.level === 'warn') : lines;

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const send = async (command: string) => {
    const c = command.trim();
    if (!c) return;
    history.current = [c, ...history.current.filter((h) => h !== c)].slice(0, 50);
    histPos.current = -1;
    setCmd('');
    try {
      await api.command(server.id, c);
    } catch (err) {
      toast('error', 'Příkaz se nepodařilo odeslat', (err as Error).message);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(cmd);
  };

  const download = () => {
    const text = lines.map((l) => `[${clock(l.t)}] ${l.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.name.replace(/[^\w.-]+/g, '_')}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="console" aria-label="Konzole" style={{ flex: '999 1 560px', minWidth: 0 }}>
      <div className="console-bar">
        <span style={{ fontWeight: 600 }}>Konzole</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" className="btn sm" aria-pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)} style={errorsOnly ? { borderColor: 'var(--amber)', color: 'var(--amber-text)' } : undefined}>
            Jen varování a chyby
          </button>
          <button type="button" className="btn sm" onClick={download} disabled={lines.length === 0}>
            Stáhnout log
          </button>
        </div>
      </div>
      <div
        className="console-log"
        role="log"
        aria-label="Výstup serveru"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 && <div className="muted">Zatím žádný výstup. Spusť server a uvidíš tu, co dělá.</div>}
        {shown.map((l, i) => (
          <div key={`${l.t}-${i}`} className={`line lv-${l.level}`}>
            <span className="time">{clock(l.t)}</span>
            {l.text.replace(SERVER_PREFIX_RE, '')}
          </div>
        ))}
      </div>
      <div className="quick">
        {QUICK.map((q) => (
          <button key={q} type="button" disabled={!running} onClick={() => void send(q)}>
            {q}
          </button>
        ))}
      </div>
      <form className="console-input" onSubmit={onSubmit}>
        <label className="prompt">
          <span className="mono" style={{ color: 'var(--green)' }}>
            &gt;
          </span>
          <span className="sr-only">Příkaz</span>
          <input
            value={cmd}
            disabled={!running}
            placeholder={running ? 'Napiš příkaz bez lomítka, např. time set day' : 'Server neběží'}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              const h = history.current;
              histPos.current = Math.max(-1, Math.min(h.length - 1, histPos.current + (e.key === 'ArrowUp' ? 1 : -1)));
              setCmd(histPos.current >= 0 ? (h[histPos.current] ?? '') : '');
            }}
          />
        </label>
        <button type="submit" className="btn primary" disabled={!running || !cmd.trim()}>
          Odeslat
        </button>
      </form>
    </section>
  );
}

function Metrics({ server }: { server: ServerInfo }) {
  const points = useLive((s) => s.metrics[server.id]) ?? [];
  const recent = points.slice(-90);
  const last = isActive(server) ? recent.at(-1) : undefined;
  return (
    <aside className="col-side" aria-label="Zátěž">
      <h2 className="h2">Zátěž</h2>
      <div className="card tight stack" style={{ gap: 8 }}>
        <div className="kv" style={{ alignItems: 'baseline' }}>
          <span className="muted" style={{ fontSize: 13 }}>
            CPU
          </span>
          <span>
            <span style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 600 }}>{last ? `${last.cpu.toFixed(0)} %` : '–'}</span>
          </span>
        </div>
        <Sparkline values={recent.map((p) => p.cpu)} max={100} color="var(--blue)" height={60} label="Využití procesoru" />
      </div>
      <div className="card tight stack" style={{ gap: 8 }}>
        <div className="kv" style={{ alignItems: 'baseline' }}>
          <span className="muted" style={{ fontSize: 13 }}>
            RAM
          </span>
          <span>
            <span style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 600 }}>{last ? gb(last.memMb) : '–'}</span>{' '}
            <span className="muted small">z {gb(server.ramMaxMb)}</span>
          </span>
        </div>
        <Sparkline values={recent.map((p) => p.memMb)} max={server.ramMaxMb * 1.15} color="var(--green)" height={60} label="Využití paměti" />
      </div>
      {last?.tps !== undefined && (
        <div className="card tight kv" style={{ alignItems: 'baseline' }}>
          <span className="muted" style={{ fontSize: 13 }}>
            TPS
          </span>
          <span style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 600, color: last.tps < 15 ? 'var(--amber-text)' : undefined }}>{last.tps.toFixed(1).replace('.', ',')}</span>
        </div>
      )}
      <div className="card tight stack" style={{ gap: 10 }}>
        <span style={{ fontWeight: 600 }}>Online hráči ({server.players.length})</span>
        {server.players.length === 0 ? (
          <span className="muted small">Nikdo nehraje.</span>
        ) : (
          server.players.map((p) => (
            <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 30, height: 30, borderRadius: 4, background: '#7fb069', display: 'grid', placeItems: 'center', fontFamily: 'var(--pixel)', fontSize: 18, color: 'var(--bg)' }}>
                {p.charAt(0).toUpperCase()}
              </span>
              <span style={{ fontWeight: 500 }}>{p}</span>
            </div>
          ))
        )}
      </div>
      <div className="card tight stack" style={{ gap: 6 }}>
        <span style={{ fontWeight: 600 }}>Složka serveru</span>
        <span className="mono small muted" style={{ wordBreak: 'break-all' }}>
          {server.dir}
        </span>
      </div>
    </aside>
  );
}

function Settings({ server, system }: { server: ServerInfo; system: SystemInfo | null }) {
  const toast = useToast();
  const [name, setName] = useState(server.name);
  const [port, setPort] = useState(server.port);
  const [ramMb, setRamMb] = useState(server.ramMaxMb);
  const [flags, setFlags] = useState(server.jvmFlags);
  const [extra, setExtra] = useState(server.extraJvmArgs);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const [timezone, setTimezone] = useState(server.timezone ?? '');
  const [crashRestart, setCrashRestart] = useState(server.crashRestart !== false);
  const [wakeOnJoin, setWakeOnJoin] = useState(!!server.wakeOnJoin);
  const [sleepAfter, setSleepAfter] = useState(String(server.sleepAfterMin ?? 0));
  const [diskOn, setDiskOn] = useState(!!server.diskLimitMb);
  const [diskGb, setDiskGb] = useState(server.diskLimitMb ? String(Math.round((server.diskLimitMb / 1024) * 10) / 10).replace('.', ',') : '10');
  const [busy, setBusy] = useState(false);
  const diskMb = diskOn ? Math.round((Number(diskGb.replace(',', '.')) || 0) * 1024) : 0;
  const maxMb = Math.max(1024, Math.min(32768, Math.floor(((system?.totalMemMb ?? 16384) - 1024) / 256) * 256));
  const dirty =
    name !== server.name ||
    port !== server.port ||
    ramMb !== server.ramMaxMb ||
    flags !== server.jvmFlags ||
    extra !== server.extraJvmArgs ||
    autoStart !== server.autoStart ||
    timezone !== (server.timezone ?? '') ||
    crashRestart !== (server.crashRestart !== false) ||
    wakeOnJoin !== !!server.wakeOnJoin ||
    Number(sleepAfter) !== (server.sleepAfterMin ?? 0) ||
    diskMb !== (server.diskLimitMb ?? 0);

  const save = async () => {
    setBusy(true);
    try {
      if (diskOn && diskMb < 1024) throw new Error('Limit disku musí být aspoň 1 GB.');
      await api.update(server.id, { name, port, ramMaxMb: ramMb, jvmFlags: flags, extraJvmArgs: extra, autoStart, timezone, crashRestart, wakeOnJoin, sleepAfterMin: Number(sleepAfter), diskLimitMb: diskMb });
      toast('ok', 'Uloženo', isActive(server) ? 'Port, RAM a Java argumenty se projeví po restartu.' : undefined);
    } catch (err) {
      toast('error', 'Uložení selhalo', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row">
      <section className="col-main card stack" style={{ gap: 18 }} aria-label="Základní nastavení">
        <h2 className="h2">Základní nastavení</h2>
        <div className="grid-auto" style={{ ['--min' as string]: '220px', gap: 14 }}>
          <label className="field">
            <span className="label">Název serveru</span>
            <input className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Port</span>
            <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, '')) || 0)} />
          </label>
        </div>
        <RamPicker id="ram-edit" label="Max RAM" valueMb={ramMb} maxMb={maxMb} onChange={setRamMb} />
        <div className="grid-auto" style={{ ['--min' as string]: '240px', gap: 14 }}>
          <Dropdown
            label="Optimalizace Javy"
            value={flags}
            onChange={(v) => setFlags(v as typeof flags)}
            options={[
              { value: 'aikar', label: 'Aikar flags (doporučeno)' },
              { value: 'default', label: 'Výchozí Java' },
            ]}
          />
          <label className="field">
            <span className="label">Vlastní JVM argumenty</span>
            <input className="input mono" value={extra} placeholder="-Duser.timezone=Europe/Prague" onChange={(e) => setExtra(e.target.value)} />
          </label>
        </div>
        <div style={{ maxWidth: 420 }}>
          <Dropdown label="Časové pásmo serveru" value={timezone} options={TIMEZONES} onChange={setTimezone} searchable />
        </div>
        <Toggle label="Spustit server se zapnutím srvMC" checked={autoStart} onChange={setAutoStart} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>
            Uložit změny
          </button>
        </div>
      </section>

      <section className="col-side card stack" style={{ gap: 14 }} aria-labelledby="h-watch">
        <h2 id="h-watch" className="h2">
          Hlídání a spánek
        </h2>
        <Toggle label="Po pádu restartovat (max 3× za 10 min)" checked={crashRestart} onChange={setCrashRestart} />
        <Toggle label="Probudit, když se někdo připojí" checked={wakeOnJoin} onChange={setWakeOnJoin} />
        <Dropdown label="Uspat, když nikdo nehraje" value={sleepAfter} options={SLEEP_OPTIONS} onChange={setSleepAfter} searchable={false} />
        <Toggle label="Limit disku" checked={diskOn} onChange={setDiskOn} />
        {diskOn && (
          <label className="field">
            <span className="label">Největší velikost složky serveru</span>
            <span className="unit-input">
              <input inputMode="decimal" aria-label="Limit disku v GB" value={diskGb} onChange={(e) => setDiskGb(e.target.value.replace(/[^0-9,.]/g, ''))} />
              <span className="muted">GB</span>
            </span>
          </label>
        )}
        {server.diskUsageMb !== undefined && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="kv" style={{ fontSize: 13 }}>
              <span className="muted">Složka serveru</span>
              <span style={{ color: diskMb && server.diskUsageMb > diskMb ? 'var(--red-text)' : undefined }}>
                {gb(server.diskUsageMb)}
                {diskMb ? ` z ${gb(diskMb)}` : ''}
              </span>
            </div>
            {diskMb > 0 && <Progress pct={Math.min(100, Math.round((server.diskUsageMb / diskMb) * 100))} />}
          </div>
        )}
      </section>
    </div>
  );
}

export function ServerDetail({ id, tab, file, system }: { id: string; tab: string; file?: string; system: SystemInfo | null }) {
  const toast = useToast();
  const server = useLive((s) => s.servers[id]);
  const loaded = useLive((s) => s.loaded);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void loadHistory(id).catch(() => undefined);
  }, [id]);

  if (!server) {
    return (
      <main className="main">
        <p className="muted">{loaded ? 'Server neexistuje.' : 'Načítám…'}</p>
        {loaded && (
          <a className="btn" href={href({ page: 'overview' })}>
            Zpět na servery
          </a>
        )}
      </main>
    );
  }

  const act = async (action: 'start' | 'stop' | 'restart' | 'kill') => {
    setBusy(true);
    try {
      await api.action(server.id, action);
    } catch (err) {
      toast('error', 'Akce selhala', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.remove(server.id);
      toast('ok', 'Server smazán', server.name);
      navigate({ page: 'overview' });
    } catch (err) {
      toast('error', 'Smazání selhalo', (err as Error).message);
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const s = server.status;

  return (
    <main className="main">
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18 }}>
        <ServerTile server={server} large />
        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontFamily: 'var(--display)', fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em' }}>{server.name}</h1>
            <StatusPill server={server} />
          </div>
          <div className="muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span>
              {server.modpack ? `${server.modpack.title} ${server.modpack.versionNumber} · ${server.modpack.loader} ${server.version}` : `${typeName(server)} ${mcVersion(server)}`}
              {!server.modpack && server.build && server.build !== 'official' ? ` · build ${server.build}` : ''}
            </span>
            {server.javaMajor && <span>· Java {server.javaMajor}</span>}
            <span>· {gb(server.ramMaxMb)} RAM</span>
          </div>
        </div>
        <div style={{ width: 260, maxWidth: '100%' }}>
          <AddressBox server={server} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {(s === 'stopped' || s === 'crashed') && (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => act('start')}>
                <Icon name="play" size={16} />
                Spustit
              </button>
              <button type="button" className="btn icon" aria-label="Smazat server" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={17} />
              </button>
            </>
          )}
          {s === 'error' && !server.install && (
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={17} />
              Smazat
            </button>
          )}
          {(s === 'running' || s === 'starting') && (
            <>
              <button type="button" className="btn" disabled={busy || s === 'starting'} onClick={() => act('restart')}>
                <Icon name="restart" size={17} />
                Restartovat
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => act('stop')}>
                <Icon name="stop" size={15} />
                Zastavit
              </button>
            </>
          )}
          {s === 'stopping' && (
            <button type="button" className="btn danger" onClick={() => act('kill')}>
              Ukončit násilně
            </button>
          )}
        </div>
      </header>

      {server.install && (
        <div className="card tight stack" style={{ gap: 8 }} aria-live="polite">
          <div className="kv" style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--text-2)' }}>{server.install.text}</span>
            <span>{server.install.pct != null ? `${server.install.pct} %` : ''}</span>
          </div>
          <Progress pct={server.install.pct} />
        </div>
      )}
      {server.task && (
        <div className="card tight stack" style={{ gap: 8 }} aria-live="polite">
          <div className="kv" style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--text-2)' }}>{server.task.text}</span>
            <span>{server.task.pct != null ? `${server.task.pct} %` : ''}</span>
          </div>
          <Progress pct={server.task.pct} />
        </div>
      )}
      {s === 'crashed' && server.lastCrash ? (
        <div className="banner error" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', alignItems: 'baseline' }}>
          <strong>Server spadl: {server.lastCrash.summary}</strong>
          {server.lastCrash.suspects.length > 0 && <span>Podezřelé: {server.lastCrash.suspects.join(', ')}</span>}
          <a href={href({ page: 'server', id: server.id, tab: 'zaznamy' })} style={{ color: 'inherit' }}>
            {server.lastCrash.report ? 'Crash report' : 'Záznamy'}
          </a>
        </div>
      ) : (
        (s === 'crashed' || s === 'error') && server.lastError && <div className="banner error">{server.lastError}</div>
      )}

      <nav className="tabs" aria-label="Sekce serveru">
        {TABS.map((t) =>
          t.phase ? (
            <button key={t.id} type="button" className="tab" disabled title={`Přijde ve fázi ${t.phase}`}>
              {t.label}
              <span className="soon">fáze {t.phase}</span>
            </button>
          ) : (
            <a key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} href={href({ page: 'server', id: server.id, tab: t.id })}>
              {t.label}
            </a>
          ),
        )}
      </nav>

      {tab === 'nastaveni' && <Settings key={server.id} server={server} system={system} />}
      {tab === 'hraci' && <PlayersTab server={server} />}
      {tab === 'moznosti' && <OptionsTab server={server} />}
      {tab === 'zaznamy' && <LogsTab server={server} />}
      {tab === 'soubory' && <FilesTab key={file ?? ''} server={server} openFile={file} />}
      {tab === 'svety' && <WorldsTab server={server} />}
      {tab === 'mody' && <ModsTab key={server.id} server={server} />}
      {tab === 'grafy' && <GraphsTab key={server.id} server={server} />}
      {tab === 'planovac' && <ScheduleTab key={server.id} server={server} />}
      {tab === 'sit' && <NetworkTab key={server.id} server={server} />}
      {!['nastaveni', 'hraci', 'moznosti', 'zaznamy', 'soubory', 'svety', 'mody', 'grafy', 'planovac', 'sit'].includes(tab) && (
        <div className="row">
          <Console server={server} />
          <Metrics server={server} />
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Smazat server ${server.name}?`}
          text={
            <>
              Smaže se celá složka serveru včetně světa a nastavení. <strong style={{ color: 'var(--text)' }}>Nejde to vrátit.</strong>
            </>
          }
          confirmLabel="Smazat natrvalo"
          danger
          busy={busy}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </main>
  );
}
