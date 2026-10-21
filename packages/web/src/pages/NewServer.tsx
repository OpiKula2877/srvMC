import { useEffect, useMemo, useState } from 'react';
import { editionOf, SERVER_TYPES, serverTypeInfo, type BuildInfo, type GameVersion, type ModpackHit, type ModpackVersion, type ServerType, type SystemInfo } from '@srvmc/shared';
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
  modpack: 'modrinth.com',
  bedrock: 'minecraft.net (oficiální Bedrock Dedicated Server)',
  'bedrock-preview': 'minecraft.net (Bedrock Preview)',
  hytale: 'hytale-downloader od Hypixel Studios',
};

const PACK_LOADERS: Record<string, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const compact = new Intl.NumberFormat('cs', { notation: 'compact', maximumFractionDigits: 1 });

function ModpackPicker({ pack, onPick, versionId, onVersion }: { pack: ModpackHit | null; onPick: (p: ModpackHit) => void; versionId?: string; onVersion: (id: string | undefined) => void }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [packs, setPacks] = useState<ModpackHit[] | null>(null);
  const [versions, setVersions] = useState<ModpackVersion[] | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        void api
          .searchModpacks(query.trim(), 0)
          .then((list) => live && setPacks(list))
          .catch((err: Error) => live && toast('error', 'Hledání modpacků selhalo', err.message)),
      query ? 350 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, toast]);

  useEffect(() => {
    if (!pack) return;
    let live = true;
    setVersions(null);
    onVersion(undefined);
    api
      .modpackVersions(pack.id)
      .then((list) => {
        if (!live) return;
        const usable = list.filter((v) => v.loaders.some((l) => PACK_LOADERS[l]));
        setVersions(usable);
        onVersion(usable[0]?.id);
      })
      .catch((err: Error) => live && toast('error', 'Verze modpacku se nepodařilo načíst', err.message));
    return () => {
      live = false;
    };
  }, [pack, toast, onVersion]);

  const versionOptions = (versions ?? []).map((v) => ({
    value: v.id,
    label: `${v.versionNumber} · ${v.gameVersions.join(', ')} · ${v.loaders.map((l) => PACK_LOADERS[l]).filter(Boolean).join(', ')}`,
  }));

  return (
    <>
      <label className="searchbox" style={{ minHeight: 44 }}>
        <Icon name="search" size={18} />
        <span className="sr-only">Hledat modpack</span>
        <input value={query} maxLength={100} placeholder="např. Cobblemon, All the Mods…" onChange={(e) => setQuery(e.target.value)} />
        {packs === null && <Spinner size={16} />}
      </label>
      <div className="stack" style={{ gap: 6, maxHeight: 360, overflowY: 'auto' }}>
        {packs?.length === 0 && <span className="muted">Nic jsem nenašel.</span>}
        {packs?.map((p) => (
          <button key={p.id} type="button" className="list-item" aria-current={pack?.id === p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} onClick={() => onPick(p)}>
            {p.iconUrl ? (
              <img src={p.iconUrl} alt="" width={40} height={40} loading="lazy" style={{ borderRadius: 8, flex: 'none', objectFit: 'cover' }} />
            ) : (
              <span style={{ width: 40, height: 40, borderRadius: 8, flex: 'none', background: 'var(--raised)' }} />
            )}
            <span className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{p.title}</span>
              <span className="muted small">
                {p.author} · {compact.format(p.downloads)} stažení
              </span>
            </span>
          </button>
        ))}
      </div>
      {pack && <Dropdown label={`Verze – ${pack.title}`} value={versionId} options={versionOptions} onChange={onVersion} loading={versions === null} searchable mono />}
      {pack && versions?.length === 0 && <div className="banner error">Tenhle modpack nemá verzi pro Fabric, Quilt, Forge ani NeoForge.</div>}
    </>
  );
}

const NOTES: Partial<Record<ServerType, string>> = {
  spigot: 'Spigot nemá oficiální stažení. BuildTools ho poprvé kompiluje 10–30 minut (stáhne si Git i JDK sám). Další servery stejné verze už jsou hned.',
  forge: 'Instalátor stáhne knihovny Forge. První spuštění trvá déle.',
  neoforge: 'Instalátor stáhne knihovny NeoForge. První spuštění trvá déle.',
  arclight: 'Arclight umí mody i Bukkit pluginy zároveň. Při prvním startu si stáhne knihovny.',
  quilt: 'Quilt umí i většinu Fabric modů.',
  modpack: 'Stáhnu loader modpacku a jen mody, které potřebuje server. Mody jen pro hráče (shadery, minimapy…) vynechám.',
  bedrock: 'Pro mobily, konzole a Minecraft for Windows. Hráči musí mít stejnou verzi hry.',
  'bedrock-preview': 'Jen pro hráče s aplikací Minecraft Preview. Běžná hra se na Preview server nepřipojí.',
  hytale: 'Experimentální (Hytale je v Early Access). Při stahování i po prvním startu se přihlásíš k účtu Hytale, který hru vlastní.',
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
  const [pack, setPack] = useState<ModpackHit | null>(null);
  const [packVersion, setPackVersion] = useState<string>();
  const isPack = type === 'modpack';

  const info = serverTypeInfo(type);
  // Leave 2 GB for Windows; never more than 32 GB (Java gets slower with huge heaps).
  const maxMb = Math.max(1024, Math.min(32768, Math.floor(((system?.totalMemMb ?? 16384) - 2048) / 256) * 256));

  const edition = editionOf(type);

  useEffect(() => {
    void api.suggestPort(type).then((r) => setPort(r.port)).catch(() => undefined);
  }, [type]);

  // Hytale needs 4 GB at least; Bedrock is a native program without a Java heap.
  useEffect(() => {
    if (edition === 'hytale') setRamMb((m) => Math.max(m, 4096));
  }, [edition]);

  useEffect(() => {
    if (system) setRamMb((m) => Math.min(m, maxMb));
  }, [system, maxMb]);

  useEffect(() => {
    if (type === 'modpack') return;
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
    if (!version || type === 'modpack') return;
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

  const finalName = name.trim() || (isPack ? (pack?.title ?? 'Modpack') : editionOf(type) === 'hytale' ? 'Hytale server' : `${info.name} ${version ?? ''}`.trim());
  const canCreate = eula && !busy && (isPack ? !!pack && !!packVersion : !!version && !!build);

  const create = async () => {
    const v = isPack ? pack?.id : version;
    const b = isPack ? packVersion : build;
    if (!v) return;
    setBusy(true);
    try {
      const server = await api.create({ name: finalName.slice(0, 48), type, version: v, build: b, port, ramMaxMb: ramMb, eulaAccepted: eula, startAfterInstall: startAfter });
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
          <li className={(isPack ? packVersion : version) ? 'done' : ''}>2 Verze</li>
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

          {isPack ? (
            <section className="card stack" aria-labelledby="h-verze" style={{ gap: 16 }}>
              <h2 id="h-verze" className="h2">
                2. Modpack z Modrinthu
              </h2>
              <ModpackPicker pack={pack} onPick={setPack} versionId={packVersion} onVersion={setPackVersion} />
            </section>
          ) : (
            <section className="card stack" aria-labelledby="h-verze" style={{ gap: 16 }}>
              <div className="section-head">
                <h2 id="h-verze" className="h2">
                  2. Verze – {info.name}
                </h2>
                {edition === 'java' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, color: 'var(--text-2)' }}>
                    <input type="checkbox" className="check" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
                    Zobrazit snapshoty a testovací verze
                  </label>
                )}
              </div>
              {loadError && <div className="banner error">Nepodařilo se načíst seznam verzí: {loadError}. Zkontroluj připojení k internetu.</div>}
              <div className="grid-auto" style={{ ['--min' as string]: '240px', gap: 14 }}>
                <Dropdown
                  label={edition === 'hytale' ? 'Verze Hytale' : 'Verze Minecraftu'}
                  value={version}
                  options={edition === 'hytale' ? versionOptions.map((o) => ({ ...o, label: 'Nejnovější' })) : versionOptions}
                  onChange={setVersion}
                  loading={!versions && !loadError}
                  searchable={edition === 'java'}
                  mono
                />
                <Dropdown label={edition === 'hytale' ? 'Kanál' : edition === 'bedrock' ? 'Sestavení' : 'Build / loader'} value={build} options={buildOptions} onChange={setBuild} loading={!!version && !builds && !loadError} />
              </div>
            </section>
          )}

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
            {edition !== 'bedrock' && <RamPicker id="ram" label="RAM pro server" valueMb={ramMb} maxMb={maxMb} onChange={setRamMb} />}
            <Toggle label="Po instalaci server rovnou spustit" checked={startAfter} onChange={setStartAfter} />
          </section>
        </div>

        <aside className="col-side card stack" aria-label="Shrnutí" style={{ gap: 18 }}>
          <h2 className="h2">Co se stáhne</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isPack && pack?.iconUrl ? (
              <img src={pack.iconUrl} alt="" width={40} height={40} style={{ borderRadius: 8, flex: 'none', objectFit: 'cover' }} />
            ) : (
              <span style={{ width: 40, height: 40, borderRadius: 8, background: info.color, flex: 'none' }} />
            )}
            <div className="stack" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{isPack ? (pack?.title ?? 'Modpack') : `${info.name} ${version ?? '…'}`}</span>
              <span className="muted small">zdroj: {SOURCES[type] ?? '–'}</span>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--text-2)' }}>
            {edition === 'bedrock' ? (
              <>
                <li>Bedrock server (zip) s kontrolou MD5</li>
                <li>Bez Javy – běží jako samostatný program</li>
                <li>
                  server.properties s portem {port} (TCP) a UDP {port}–{port + 19}
                </li>
              </>
            ) : edition === 'hytale' ? (
              <>
                <li>hytale-downloader s ověřeným podpisem</li>
                <li>Server a Assets.zip po přihlášení k účtu Hytale</li>
                <li>Java 25 (Temurin) a UDP port {port}</li>
              </>
            ) : (
              <>
                <li>{isPack ? 'Loader a serverové mody modpacku s kontrolou SHA' : 'Serverový soubor s kontrolou SHA'}</li>
                <li>Správná Java (Temurin), jen když ještě chybí</li>
                <li>eula.txt a server.properties s portem {port}</li>
              </>
            )}
          </ul>
          {NOTES[type] && <div className="banner info">{NOTES[type]}</div>}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: 'var(--text-2)' }}>
            <input type="checkbox" className="check" checked={eula} onChange={(e) => setEula(e.target.checked)} style={{ marginTop: 1 }} />
            {edition === 'hytale' ? (
              <span>
                Souhlasím s podmínkami{' '}
                <a href="https://hytale.com" target="_blank" rel="noreferrer">
                  Hytale
                </a>{' '}
                a mám účet, který hru vlastní
              </span>
            ) : (
              <span>
                Souhlasím s{' '}
                <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                  Minecraft EULA
                </a>
                {edition === 'bedrock' && (
                  <>
                    {' '}
                    a{' '}
                    <a href="https://go.microsoft.com/fwlink/?LinkId=521839" target="_blank" rel="noreferrer">
                      zásadami ochrany osobních údajů
                    </a>
                  </>
                )}
              </span>
            )}
          </label>
          <button type="button" className="btn primary" style={{ minHeight: 48, fontSize: 15, fontWeight: 700 }} disabled={!canCreate} onClick={create}>
            {busy ? <Spinner /> : null}
            Vytvořit a stáhnout
          </button>
          {isPack && ramMb < 4096 && <div className="banner info">Modpacky obvykle potřebují aspoň 4–6 GB RAM.</div>}
          {system && edition !== 'bedrock' && ramMb > system.freeMemMb && (
            <div className="banner info">Teď je volných jen {gb(system.freeMemMb)} RAM. Server se spustí, ale Windows může zpomalit.</div>
          )}
        </aside>
      </div>
    </main>
  );
}
