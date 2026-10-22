import { useEffect, useMemo, useState } from 'react';
import { editionOf, SERVER_TYPES, serverTypeInfo, type BuildInfo, type GameVersion, MODPACK_SOURCES, type ModpackHit, type ModpackSource, type ModpackVersion, type ServerType, type SystemInfo, locale, t } from '@srvmc/shared';
import { api } from '../api.ts';
import { CurseForgeKey } from './tabs/CurseForgeKey.tsx';
import { RamPicker, Toggle } from '../components/Controls.tsx';
import { Dropdown } from '../components/Dropdown.tsx';
import { Icon, Spinner } from '../components/Icon.tsx';
import { useToast } from '../components/Overlays.tsx';
import { gb } from '../format.ts';
import { upsertServer } from '../live.ts';
import { href, navigate } from '../router.ts';

const SOURCES: Partial<Record<ServerType, string>> = {
  vanilla: t('piston-data.mojang.com (official Mojang)'),
  paper: 'fill.papermc.io (PaperMC)',
  purpur: 'api.purpurmc.org',
  spigot: t('hub.spigotmc.org – BuildTools, built on your computer'),
  fabric: 'meta.fabricmc.net + Mojang',
  quilt: 'meta.quiltmc.org – Quilt installer',
  forge: 'maven.minecraftforge.net – Forge installer',
  neoforge: 'maven.neoforged.net – NeoForge installer',
  arclight: 'GitHub IzzelAliz/Arclight',
  modpack: 'Modrinth, CurseForge, Technic',
  bedrock: t('minecraft.net (official Bedrock Dedicated Server)'),
  'bedrock-preview': 'minecraft.net (Bedrock Preview)',
  hytale: t('hytale-downloader by Hypixel Studios'),
};

const PACK_LOADERS: Record<string, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const compact = new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 });

function SourceTabs({ source, onChange }: { source: ModpackSource; onChange: (s: ModpackSource) => void }) {
  return (
    <div className="seg" role="tablist" aria-label={t('Where the modpack comes from')}>
      {MODPACK_SOURCES.map((s) => (
        <button key={s.id} type="button" role="tab" className="seg-btn" aria-selected={source === s.id} onClick={() => onChange(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

function ModpackPicker({ pack, onPick, versionId, onVersion }: { pack: ModpackHit | null; onPick: (p: ModpackHit) => void; versionId?: string; onVersion: (id: string | undefined) => void }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [packs, setPacks] = useState<ModpackHit[] | null>(null);
  const [versions, setVersions] = useState<ModpackVersion[] | null>(null);
  const [source, setSource] = useState<ModpackSource>('modrinth');
  const [cfKey, setCfKey] = useState<boolean | null>(null);
  const needsKey = source === 'curseforge' && cfKey === false;

  useEffect(() => {
    api
      .curseForge()
      .then((s) => setCfKey(s.keySet))
      .catch(() => setCfKey(false));
  }, []);

  useEffect(() => {
    if (needsKey || (source === 'curseforge' && cfKey === null)) return;
    let live = true;
    setPacks(null);
    const timer = setTimeout(
      () =>
        void api
          .searchModpacks(query.trim(), 0, source)
          .then((list) => live && setPacks(list))
          .catch((err: Error) => {
            if (!live) return;
            setPacks([]);
            toast('error', t('Modpack search failed'), err.message);
          }),
      query ? 350 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, source, needsKey, cfKey, toast]);

  useEffect(() => {
    if (!pack) return;
    let live = true;
    setVersions(null);
    onVersion(undefined);
    api
      .modpackVersions(pack.id)
      .then((list) => {
        if (!live) return;
        // Technic does not say the loader up front; srvMC finds it in the pack.
        const usable = list.filter((v) => v.loaders.length === 0 || v.loaders.some((l) => PACK_LOADERS[l]));
        setVersions(usable);
        onVersion(usable[0]?.id);
      })
      .catch((err: Error) => live && toast('error', t('Could not load the modpack versions'), err.message));
    return () => {
      live = false;
    };
  }, [pack, toast, onVersion]);

  const versionOptions = (versions ?? []).map((v) => ({
    value: v.id,
    label: [v.versionNumber, v.gameVersions.join(', '), v.loaders.map((l) => PACK_LOADERS[l]).filter(Boolean).join(', '), v.serverPack && t('server pack')].filter(Boolean).join(' · '),
  }));

  if (needsKey) {
    return (
      <>
        <SourceTabs source={source} onChange={setSource} />
        <CurseForgeKey onSaved={() => setCfKey(true)} />
      </>
    );
  }

  return (
    <>
      <SourceTabs source={source} onChange={setSource} />
      <label className="searchbox" style={{ minHeight: 44 }}>
        <Icon name="search" size={18} />
        <span className="sr-only">{t('Search modpacks')}</span>
        <input value={query} maxLength={100} placeholder={t('e.g. Cobblemon, All the Mods…')} onChange={(e) => setQuery(e.target.value)} />
        {packs === null && <Spinner size={16} />}
      </label>
      <div className="stack" style={{ gap: 6, maxHeight: 360, overflowY: 'auto' }}>
        {packs?.length === 0 && <span className="muted">{t('Nothing found.')}</span>}
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
                {t('{author} · {n} downloads', { author: p.author, n: compact.format(p.downloads) })}
              </span>
            </span>
          </button>
        ))}
      </div>
      {pack && <Dropdown label={t('Version – {name}', { name: pack.title })} value={versionId} options={versionOptions} onChange={onVersion} loading={versions === null} searchable mono />}
      {pack && versions?.length === 0 && <div className="banner error">{t('This modpack has no version for Fabric, Quilt, Forge or NeoForge.')}</div>}
    </>
  );
}

const NOTES: Partial<Record<ServerType, string>> = {
  spigot: t('Spigot has no official download. BuildTools compiles it the first time in 10–30 minutes (it gets Git and a JDK by itself). Further servers of the same version are ready at once.'),
  forge: t('The installer downloads the Forge libraries. The first start takes longer.'),
  neoforge: t('The installer downloads the NeoForge libraries. The first start takes longer.'),
  arclight: t('Arclight runs mods and Bukkit plugins together. It downloads its libraries on the first start.'),
  quilt: t('Quilt also runs most Fabric mods.'),
  modpack: t("srvMC downloads the modpack's loader and only the mods the server needs. Mods only for players (shaders, minimaps…) are left out."),
  bedrock: t('For phones, consoles and Minecraft for Windows. Players need the same game version.'),
  'bedrock-preview': t('Only for players with the Minecraft Preview app. The regular game cannot join a Preview server.'),
  hytale: t('Experimental (Hytale is in Early Access). During the download and after the first start you sign in to a Hytale account that owns the game.'),
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

  const finalName = name.trim() || (isPack ? (pack?.title ?? 'Modpack') : editionOf(type) === 'hytale' ? t('Hytale server') : `${info.name} ${version ?? ''}`.trim());
  const canCreate = eula && !busy && (isPack ? !!pack && !!packVersion : !!version && !!build);

  const create = async () => {
    const v = isPack ? pack?.id : version;
    const b = isPack ? packVersion : build;
    if (!v) return;
    setBusy(true);
    try {
      const server = await api.create({ name: finalName.slice(0, 48), type, version: v, build: b, port, ramMaxMb: ramMb, eulaAccepted: eula, startAfterInstall: startAfter });
      upsertServer(server);
      toast('info', t('The server is being prepared'), t('Downloading files from the official sources.'));
      navigate({ page: 'server', id: server.id, tab: 'konzole' });
    } catch (err) {
      toast('error', t('Could not create the server'), (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="main">
      <header className="section-head">
        <div className="stack" style={{ gap: 8 }}>
          <a href={href({ page: 'overview' })} className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', fontSize: 13, minHeight: 32 }}>
            <Icon name="back" size={16} />
            {t('Back to servers')}
          </a>
          <h1 className="h1">{t('New server')}</h1>
        </div>
        <ol className="steps">
          <li className="done">{t('1 Type')}</li>
          <li className={(isPack ? packVersion : version) ? 'done' : ''}>{t('2 Version')}</li>
          <li className={eula ? 'done' : ''}>{t('3 Settings')}</li>
          <li>{t('4 Download and start')}</li>
        </ol>
      </header>

      <div className="row">
        <div className="col-main">
          <section className="card stack" aria-labelledby="h-typ" style={{ gap: 16 }}>
            <h2 id="h-typ" className="h2">
              {t('1. Server type')}
            </h2>
            <div className="grid-auto" style={{ ['--min' as string]: '170px', gap: 10 }}>
              {SERVER_TYPES.map((st) => (
                <button key={st.id} type="button" className="type-btn" aria-pressed={st.id === type} disabled={!st.available} onClick={() => setType(st.id)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="swatch" style={{ background: st.color }} />
                    <span style={{ fontWeight: 600 }}>{st.name}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          {isPack ? (
            <section className="card stack" aria-labelledby="h-verze" style={{ gap: 16 }}>
              <h2 id="h-verze" className="h2">
                2. Modpack
              </h2>
              <ModpackPicker pack={pack} onPick={setPack} versionId={packVersion} onVersion={setPackVersion} />
            </section>
          ) : (
            <section className="card stack" aria-labelledby="h-verze" style={{ gap: 16 }}>
              <div className="section-head">
                <h2 id="h-verze" className="h2">
                  {t('2. Version – {name}', { name: info.name })}
                </h2>
                {edition === 'java' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, color: 'var(--text-2)' }}>
                    <input type="checkbox" className="check" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
                    {t('Show snapshots and test versions')}
                  </label>
                )}
              </div>
              {loadError && <div className="banner error">{t('Could not load the version list: {error}. Check the internet connection.', { error: loadError })}</div>}
              <div className="grid-auto" style={{ ['--min' as string]: '240px', gap: 14 }}>
                <Dropdown
                  label={edition === 'hytale' ? t('Hytale version') : t('Minecraft version')}
                  value={version}
                  options={edition === 'hytale' ? versionOptions.map((o) => ({ ...o, label: t('Latest') })) : versionOptions}
                  onChange={setVersion}
                  loading={!versions && !loadError}
                  searchable={edition === 'java'}
                  mono
                />
                <Dropdown label={edition === 'hytale' ? t('Channel') : edition === 'bedrock' ? t('Build') : 'Build / loader'} value={build} options={buildOptions} onChange={setBuild} loading={!!version && !builds && !loadError} />
              </div>
            </section>
          )}

          <section className="card stack" aria-labelledby="h-nast" style={{ gap: 18 }}>
            <h2 id="h-nast" className="h2">
              {t('3. Settings')}
            </h2>
            <div className="grid-auto" style={{ ['--min' as string]: '220px', gap: 14 }}>
              <label className="field">
                <span className="label">{t('Server name')}</span>
                <input className="input" value={name} maxLength={48} placeholder={finalName} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Port</span>
                <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </label>
            </div>
            {edition !== 'bedrock' && <RamPicker id="ram" label={t('RAM for the server')} valueMb={ramMb} maxMb={maxMb} onChange={setRamMb} />}
            <Toggle label={t('Start the server right after installing')} checked={startAfter} onChange={setStartAfter} />
          </section>
        </div>

        <aside className="col-side card stack" aria-label={t('Summary')} style={{ gap: 18 }}>
          <h2 className="h2">{t('What gets downloaded')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isPack && pack?.iconUrl ? (
              <img src={pack.iconUrl} alt="" width={40} height={40} style={{ borderRadius: 8, flex: 'none', objectFit: 'cover' }} />
            ) : (
              <span style={{ width: 40, height: 40, borderRadius: 8, background: info.color, flex: 'none' }} />
            )}
            <div className="stack" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{isPack ? (pack?.title ?? 'Modpack') : `${info.name} ${version ?? '…'}`}</span>
              <span className="muted small">{t('source: {source}', { source: SOURCES[type] ?? '–' })}</span>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--text-2)' }}>
            {edition === 'bedrock' ? (
              <>
                <li>{t('Bedrock server (zip) with an MD5 check')}</li>
                <li>{t('No Java – it runs as its own program')}</li>
                <li>
                  {t('server.properties with port {port} (TCP) and UDP {from}–{to}', { port, from: port, to: port + 19 })}
                </li>
              </>
            ) : edition === 'hytale' ? (
              <>
                <li>{t('hytale-downloader with a verified signature')}</li>
                <li>{t('Server and Assets.zip after signing in to Hytale')}</li>
                <li>{t('Java 25 (Temurin) and UDP port {port}', { port })}</li>
              </>
            ) : (
              <>
                <li>{isPack ? t("The modpack's loader and server mods with SHA checks") : t('The server file with a SHA check')}</li>
                <li>{t('The right Java (Temurin), only when it is missing')}</li>
                <li>{t('eula.txt and server.properties with port {port}', { port })}</li>
              </>
            )}
          </ul>
          {NOTES[type] && <div className="banner info">{NOTES[type]}</div>}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: 'var(--text-2)' }}>
            <input type="checkbox" className="check" checked={eula} onChange={(e) => setEula(e.target.checked)} style={{ marginTop: 1 }} />
            {edition === 'hytale' ? (
              <span>
                {t('I agree to the terms of')}{' '}
                <a href="https://hytale.com" target="_blank" rel="noreferrer">
                  Hytale
                </a>{' '}
                {t('and I have an account that owns the game')}
              </span>
            ) : (
              <span>
                {t('I agree to the')}{' '}
                <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                  Minecraft EULA
                </a>
                {edition === 'bedrock' && (
                  <>
                    {' '}
                    {t('and')}{' '}
                    <a href="https://go.microsoft.com/fwlink/?LinkId=521839" target="_blank" rel="noreferrer">
                      {t('privacy policy')}
                    </a>
                  </>
                )}
              </span>
            )}
          </label>
          <button type="button" className="btn primary" style={{ minHeight: 48, fontSize: 15, fontWeight: 700 }} disabled={!canCreate} onClick={create}>
            {busy ? <Spinner /> : null}
            {t('Create and download')}
          </button>
          {isPack && ramMb < 4096 && <div className="banner info">{t('Modpacks usually need at least 4–6 GB of RAM.')}</div>}
          {system && edition !== 'bedrock' && ramMb > system.freeMemMb && (
            <div className="banner info">{t('Only {ram} of RAM is free now. The server will start, but Windows may slow down.', { ram: gb(system.freeMemMb) })}</div>
          )}
        </aside>
      </div>
    </main>
  );
}
