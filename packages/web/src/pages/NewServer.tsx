import { useEffect, useMemo, useState } from 'react';
import { SERVER_TYPES, serverTypeInfo, type BuildInfo, type GameVersion, type ServerType, type SystemInfo } from '@srvmc/shared';
import { api } from '../api.ts';
import { RamPicker, Toggle } from '../components/Controls.tsx';
import { Dropdown } from '../components/Dropdown.tsx';
import { Icon, Spinner } from '../components/Icon.tsx';
import { useToast } from '../components/Overlays.tsx';
import { gb } from '../format.ts';
import { upsertServer } from '../live.ts';
import { href, navigate } from '../router.ts';

const SOURCES: Partial<Record<ServerType, string>> = {
  vanilla: 'piston-data.mojang.com (oficiální Mojang)',
  paper: 'fill.papermc.io (PaperMC)',
  purpur: 'api.purpurmc.org',
  spigot: 'hub.spigotmc.org – BuildTools, sestaví se u tebe',
  fabric: 'meta.fabricmc.net + Mojang',
  quilt: 'meta.quiltmc.org – Quilt installer',
  forge: 'maven.minecraftforge.net – Forge installer',
  neoforge: 'maven.neoforged.net – NeoForge installer',
  arclight: 'GitHub IzzelAliz/Arclight',
};

const NOTES: Partial<Record<ServerType, string>> = {
  spigot: 'Spigot nemá oficiální stažení. BuildTools ho poprvé kompiluje 10–30 minut (stáhne si Git i JDK sám). Další servery stejné verze už jsou hned.',
  forge: 'Instalátor stáhne knihovny Forge. První spuštění trvá déle.',
  neoforge: 'Instalátor stáhne knihovny NeoForge. První spuštění trvá déle.',
  arclight: 'Arclight umí mody i Bukkit pluginy zároveň. Při prvním startu si stáhne knihovny.',
  quilt: 'Quilt umí i většinu Fabric modů.',
};

export function NewServer({ system }: { system: SystemInfo | null }) {
  const toast = useToast();
  const [type, setType] = useState<ServerType>('paper');
  const [snapshots, setSnapshots] = useState(false);
  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [version, setVersion] = useState<string>();
  const [builds, setBuilds] = useState<BuildInfo[] | null>(null);
  const [build, setBuild] = useState<string>();
  const [name, setName] = useState('');
  const [port, setPort] = useState(25565);
  const [ramMb, setRamMb] = useState(4096);
  const [startAfter, setStartAfter] = useState(true);
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  const info = serverTypeInfo(type);
  // Leave 2 GB for Windows; never more than 32 GB (Java gets slower with huge heaps).
  const maxMb = Math.max(1024, Math.min(32768, Math.floor(((system?.totalMemMb ?? 16384) - 2048) / 256) * 256));

  useEffect(() => {
    void api.suggestPort().then((r) => setPort(r.port)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (system) setRamMb((m) => Math.min(m, maxMb));
  }, [system, maxMb]);

  useEffect(() => {
    let live = true;
    setVersions(null);
    setLoadError(undefined);
    api
      .versions(type, snapshots)
      .then((list) => {
        if (!live) return;
        setVersions(list);
        setVersion((v) => (v && list.some((x) => x.id === v) ? v : (list.find((x) => x.type === 'release') ?? list[0])?.id));
      })
      .catch((err: Error) => live && setLoadError(err.message));
    return () => {
      live = false;
    };
  }, [type, snapshots]);

  useEffect(() => {
    if (!version) return;
    let live = true;
    setBuilds(null);
    setBuild(undefined);
    api
      .builds(type, version)
      .then((list) => {
        if (!live) return;
        setBuilds(list);
        setBuild((list.find((b) => b.channel === 'stable') ?? list[0])?.id);
      })
      .catch((err: Error) => live && setLoadError(err.message));
    return () => {
      live = false;
    };
  }, [type, version]);

  const versionOptions = useMemo(() => (versions ?? []).map((v) => ({ value: v.id, label: v.id })), [versions]);
  const buildOptions = useMemo(() => (builds ?? []).map((b) => ({ value: b.id, label: b.label })), [builds]);

  const finalName = name.trim() || `${info.name} ${version ?? ''}`.trim();
  const canCreate = eula && !!version && !!build && !busy;

  const create = async () => {
    if (!version) return;
    setBusy(true);
    try {
      const server = await api.create({ name: finalName, type, version, build, port, ramMaxMb: ramMb, eulaAccepted: eula, startAfterInstall: startAfter });
      upsertServer(server);
      toast('info', 'Server se připravuje', 'Stahuji soubory z oficiálních zdrojů.');
      navigate({ page: 'server', id: server.id, tab: 'konzole' });
    } catch (err) {
      toast('error', 'Server se nepodařilo vytvořit', (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="main">
      <header className="section-head">
        <div className="stack" style={{ gap: 8 }}>
          <a href={href({ page: 'overview' })} className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', fontSize: 13, minHeight: 32 }}>
            <Icon name="back" size={16} />
            Zpět na servery
          </a>
          <h1 className="h1">Nový server</h1>
        </div>
        <ol className="steps">
          <li className="done">1 Typ</li>
          <li className={version ? 'done' : ''}>2 Verze</li>
          <li className={eula ? 'done' : ''}>3 Nastavení</li>
          <li>4 Stažení a start</li>
        </ol>
      </header>

      <div className="row">
        <div className="col-main">
          <section className="card stack" aria-labelledby="h-typ" style={{ gap: 16 }}>
            <h2 id="h-typ" className="h2">
              1. Typ serveru
            </h2>
            <div className="grid-auto" style={{ ['--min' as string]: '170px', gap: 10 }}>
              {SERVER_TYPES.map((t) => (
                <button key={t.id} type="button" className="type-btn" aria-pressed={t.id === type} disabled={!t.available} onClick={() => setType(t.id)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="swatch" style={{ background: t.color }} />
                    <span style={{ fontWeight: 600 }}>{t.name}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="card stack" aria-labelledby="h-verze" style={{ gap: 16 }}>
            <div className="section-head">
              <h2 id="h-verze" className="h2">
                2. Verze – {info.name}
              </h2>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, color: 'var(--text-2)' }}>
                <input type="checkbox" className="check" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
                Zobrazit snapshoty a testovací verze
              </label>
            </div>
            {loadError && <div className="banner error">Nepodařilo se načíst seznam verzí: {loadError}. Zkontroluj připojení k internetu.</div>}
            <div className="grid-auto" style={{ ['--min' as string]: '240px', gap: 14 }}>
              <Dropdown label="Verze Minecraftu" value={version} options={versionOptions} onChange={setVersion} loading={!versions && !loadError} searchable mono />
              <Dropdown label="Build / loader" value={build} options={buildOptions} onChange={setBuild} loading={!!version && !builds && !loadError} />
            </div>
          </section>

          <section className="card stack" aria-labelledby="h-nast" style={{ gap: 18 }}>
            <h2 id="h-nast" className="h2">
              3. Nastavení
            </h2>
            <div className="grid-auto" style={{ ['--min' as string]: '220px', gap: 14 }}>
              <label className="field">
                <span className="label">Název serveru</span>
                <input className="input" value={name} maxLength={48} placeholder={finalName} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Port</span>
                <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </label>
            </div>
            <RamPicker id="ram" label="RAM pro server" valueMb={ramMb} maxMb={maxMb} onChange={setRamMb} />
            <Toggle label="Po instalaci server rovnou spustit" checked={startAfter} onChange={setStartAfter} />
          </section>
        </div>

        <aside className="col-side card stack" aria-label="Shrnutí" style={{ gap: 18 }}>
          <h2 className="h2">Co se stáhne</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 40, height: 40, borderRadius: 8, background: info.color, flex: 'none' }} />
            <div className="stack" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>
                {info.name} {version ?? '…'}
              </span>
              <span className="muted small">zdroj: {SOURCES[type] ?? '–'}</span>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--text-2)' }}>
            <li>Serverový soubor s kontrolou SHA</li>
            <li>Správná Java (Temurin), jen když ještě chybí</li>
            <li>eula.txt a server.properties s portem {port}</li>
          </ul>
          {NOTES[type] && <div className="banner info">{NOTES[type]}</div>}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: 'var(--text-2)' }}>
            <input type="checkbox" className="check" checked={eula} onChange={(e) => setEula(e.target.checked)} style={{ marginTop: 1 }} />
            <span>
              Souhlasím s{' '}
              <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                Minecraft EULA
              </a>
            </span>
          </label>
          <button type="button" className="btn primary" style={{ minHeight: 48, fontSize: 15, fontWeight: 700 }} disabled={!canCreate} onClick={create}>
            {busy ? <Spinner /> : null}
            Vytvořit a stáhnout
          </button>
          {system && ramMb > system.freeMemMb && (
            <div className="banner info">Teď je volných jen {gb(system.freeMemMb)} RAM. Server se spustí, ale Windows může zpomalit.</div>
          )}
        </aside>
      </div>
    </main>
  );
}
