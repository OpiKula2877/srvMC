import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { editionOf, type ContentHit, type ContentSource, type ContentTarget, type InstalledContent, type ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Progress, Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { bytes, nameColor } from '../../format.ts';

const SOURCE_LABEL: Record<ContentSource, string> = { modrinth: 'Modrinth', hangar: 'Hangar', spigot: 'SpigotMC' };
const LOADER_LABEL: Record<string, string> = {
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  arclight: 'Arclight',
};

const compact = new Intl.NumberFormat('cs', { notation: 'compact', maximumFractionDigits: 1 });

function ContentIcon({ url, name, size = 52 }: { url?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return <img src={url} alt="" width={size} height={size} loading="lazy" style={{ borderRadius: 10, flex: 'none', objectFit: 'cover', background: 'var(--raised)' }} onError={() => setBroken(true)} />;
  }
  return (
    <div className="tile" style={{ width: size, height: size, background: nameColor(name), fontSize: size * 0.54, borderRadius: 10 }} aria-hidden="true">
      {name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '?'}
    </div>
  );
}

function Result({ hit, busy, onInstall }: { hit: ContentHit; busy: boolean; onInstall: () => void }) {
  const badge = hit.installed
    ? { text: 'Nainstalováno', bg: 'var(--green-soft)', fg: 'var(--green-text)' }
    : hit.clientOnly
      ? { text: 'Jen pro klienta', bg: 'var(--red-soft)', fg: 'var(--red-text)' }
      : !hit.installable
        ? { text: 'Jen z webu autora', bg: 'var(--amber-soft)', fg: 'var(--amber-text)' }
        : null;
  return (
    <li className="card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', borderColor: hit.clientOnly ? '#4a2a2d' : undefined }}>
      <ContentIcon url={hit.iconUrl} name={hit.title} />
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
          <a href={hit.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)', textDecoration: 'none' }}>
            {hit.title}
          </a>
          <span className="muted small">
            {hit.author && `od ${hit.author} · `}
            {compact.format(hit.downloads)} stažení
          </span>
        </div>
        {hit.description && <span style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.45 }}>{hit.description}</span>}
        {badge && (
          <span className="pill" style={{ alignSelf: 'flex-start', background: badge.bg, color: badge.fg }}>
            {badge.text}
          </span>
        )}
      </div>
      {hit.installed ? (
        <button type="button" className="btn" style={{ minWidth: 132 }} disabled>
          <Icon name="check" size={16} />
          Hotovo
        </button>
      ) : hit.installable ? (
        <button type="button" className="btn primary" style={{ minWidth: 132 }} disabled={busy} onClick={onInstall}>
          Nainstalovat
        </button>
      ) : hit.clientOnly ? (
        <button type="button" className="btn" style={{ minWidth: 132 }} disabled>
          Nejde na server
        </button>
      ) : (
        <a className="btn" style={{ minWidth: 132 }} href={hit.url} target="_blank" rel="noreferrer">
          Otevřít web
        </a>
      )}
    </li>
  );
}

function InstalledRow({ item, locked, busy, onToggle, onUpdate, onRemove }: { item: InstalledContent; locked: boolean; busy: boolean; onToggle: (v: boolean) => void; onUpdate: () => void; onRemove: () => void }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--line)', opacity: item.enabled ? 1 : 0.6 }}>
      <ContentIcon url={item.iconUrl} name={item.name} size={36} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.file}>
          {item.name}
        </span>
        <span className="muted small mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.version ?? bytes(item.size)}
          {item.update && <span style={{ color: 'var(--amber-text)' }}> → {item.update.versionNumber}</span>}
        </span>
      </div>
      {item.update && (
        <button type="button" className="btn sm" style={{ background: 'var(--amber-soft)', borderColor: 'transparent', color: 'var(--amber-text)' }} disabled={busy || locked} title={locked ? 'Nejdřív zastav server' : undefined} onClick={onUpdate}>
          Aktualizovat
        </button>
      )}
      <input
        type="checkbox"
        className="toggle"
        aria-label={`${item.enabled ? 'Vypnout' : 'Zapnout'} ${item.name}`}
        checked={item.enabled}
        disabled={busy || locked}
        title={locked ? 'Nejdřív zastav server' : undefined}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <button type="button" className="btn icon sm" style={{ width: 36, minHeight: 36, color: 'var(--red-text)' }} aria-label={`Smazat ${item.name}`} disabled={busy || locked} onClick={onRemove}>
        <Icon name="trash" size={15} />
      </button>
    </li>
  );
}

export function ModsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [targets, setTargets] = useState<ContentTarget[] | null>(null);
  const [folder, setFolder] = useState<string>('');
  const [source, setSource] = useState<ContentSource>('modrinth');
  const [query, setQuery] = useState('');
  const [hideClient, setHideClient] = useState(true);
  const [hits, setHits] = useState<ContentHit[] | null>(null);
  const [more, setMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [items, setItems] = useState<InstalledContent[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<InstalledContent | null>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const running = server.status !== 'stopped' && server.status !== 'crashed' && server.status !== 'error';
  const target = targets?.find((t) => t.folder === folder);
  const loader = server.type === 'modpack' ? (server.modpack?.loader ?? 'modpack') : server.type;
  const noun = target?.kind === 'mod' ? 'mody' : 'pluginy';

  useEffect(() => {
    api
      .contentTargets(server.id)
      .then((t) => {
        setTargets(t);
        setFolder((f) => (t.some((x) => x.folder === f) ? f : (t[0]?.folder ?? '')));
      })
      .catch((err: Error) => toast('error', 'Nepodařilo se načíst, co server podporuje', err.message));
  }, [server.id, toast]);

  const loadInstalled = useCallback(async () => {
    try {
      const list = await api.installed(server.id);
      setItems(list);
      setChecking(true);
      const withUpdates = await api.contentUpdates(server.id).catch(() => null);
      if (withUpdates) setItems(withUpdates);
    } catch (err) {
      toast('error', 'Seznam se nepodařilo načíst', (err as Error).message);
    } finally {
      setChecking(false);
    }
  }, [server.id, toast]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  const search = useCallback(
    async (offset: number) => {
      if (!target) return;
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const page = await api.searchContent(server.id, { source, folder: target.folder, q: query, offset, hideClient });
        if (seq !== searchSeq.current) return;
        setHits((prev) => (offset === 0 ? page : [...(prev ?? []), ...page]));
        setMore(page.length >= 20);
      } catch (err) {
        if (seq === searchSeq.current) toast('error', 'Hledání selhalo', (err as Error).message);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [server.id, target, source, query, hideClient, toast],
  );

  // Typing waits a moment before searching; other filter changes search at once.
  useEffect(() => {
    const t = setTimeout(() => void search(0), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [search, query]);

  useEffect(() => {
    if (target && !target.sources.includes(source)) setSource(target.sources[0]!);
  }, [target, source]);

  const install = async (hit: ContentHit) => {
    if (!target) return;
    setInstalling(hit.id);
    try {
      const r = await api.installContent(server.id, { source: hit.source, id: hit.id, folder: target.folder });
      toast('ok', `Nainstalováno: ${hit.title}`, [r.installed.length > 1 && `Se závislostmi: ${r.installed.slice(1).join(', ')}`, r.skipped.length && `Přeskočeno: ${r.skipped.join(', ')}`, running && 'Projeví se po restartu serveru.'].filter(Boolean).join(' · ') || undefined);
      setHits((h) => h?.map((x) => (x.id === hit.id && x.source === hit.source ? { ...x, installed: true } : x)) ?? null);
      void loadInstalled();
    } catch (err) {
      toast('error', `${hit.title} se nepodařilo nainstalovat`, (err as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast('ok', ok);
      await loadInstalled();
    } catch (err) {
      toast('error', label, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadJar = async (file: File | undefined) => {
    if (!file || !target) return;
    if (!/\.jar$/i.test(file.name)) return toast('error', 'Nahrát jde jen soubor .jar');
    setUpload({ name: file.name, pct: 0 });
    try {
      const r = await api.uploadJar(server.id, target.folder, file, false, (pct) => setUpload({ name: file.name, pct }));
      toast('ok', `Nahráno: ${r.name}${r.version ? ` ${r.version}` : ''}`, running ? 'Projeví se po restartu serveru.' : undefined);
      void loadInstalled();
    } catch (err) {
      toast('error', 'Jar se nepodařilo nahrát', (err as Error).message);
    } finally {
      setUpload(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void uploadJar(e.dataTransfer.files[0]);
  };

  if (targets === null) return <Spinner />;
  if (targets.length === 0) {
    return (
      <div className="empty">
        {editionOf(server.type) === 'java' ? (
          <>
            <span style={{ fontWeight: 600 }}>Vanilla server neumí mody ani pluginy</span>
            <span className="muted">Pro pluginy vytvoř server Paper nebo Purpur, pro mody Fabric, Forge nebo NeoForge.</span>
          </>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>{editionOf(server.type) === 'bedrock' ? 'Add-ony pro Bedrock zatím neumím' : 'Mody pro Hytale zatím neumím'}</span>
            <span className="muted">Můžeš je nahrát ručně v Souborech.</span>
          </>
        )}
      </div>
    );
  }

  const shown = items?.filter((i) => i.folder === folder) ?? null;
  const updates = shown?.filter((i) => i.update).length ?? 0;

  return (
    <div className="row">
      <section className="col-main" aria-labelledby="h-search" style={{ gap: 14 }}>
        <div className="section-head">
          <h2 id="h-search" className="h2">
            Hledat {noun}
          </h2>
          {targets.length > 1 && (
            <div className="seg" role="tablist" aria-label="Co hledat">
              {targets.map((t) => (
                <button key={t.folder} type="button" role="tab" className="seg-btn" aria-selected={t.folder === folder} onClick={() => setFolder(t.folder)}>
                  {t.kind === 'mod' ? 'Mody' : 'Pluginy'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <label className="searchbox" style={{ flex: '3 1 280px', minHeight: 44, background: 'var(--surface)' }}>
            <Icon name="search" size={18} />
            <span className="sr-only">Hledat</span>
            <input value={query} maxLength={100} placeholder={target?.kind === 'mod' ? 'např. lithium, create…' : 'např. luckperms, essentials…'} onChange={(e) => setQuery(e.target.value)} />
            {searching && <Spinner size={16} />}
          </label>
          {target && target.sources.length > 1 && (
            <div style={{ flex: '1 1 180px' }}>
              <Dropdown label="Zdroj" value={source} options={target.sources.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))} onChange={(v) => setSource(v as ContentSource)} searchable={false} />
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="pill" style={{ background: 'var(--green-soft)', color: 'var(--green-text)', padding: '6px 12px', fontSize: 13, fontWeight: 500 }}>
            {LOADER_LABEL[loader] ?? loader} · {server.version}
          </span>
          {source === 'modrinth' && target?.kind === 'mod' && (
            <div style={{ minWidth: 240 }}>
              <Toggle label="Skrýt mody jen pro klienta" checked={hideClient} onChange={setHideClient} />
            </div>
          )}
        </div>

        {hits === null ? (
          <Spinner />
        ) : hits.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <span className="muted">Nic jsem nenašel{query ? ` pro „${query}“` : ''}.</span>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {hits.map((h) => (
              <Result key={`${h.source}:${h.id}`} hit={h} busy={installing !== null || !!server.task} onInstall={() => void install(h)} />
            ))}
          </ul>
        )}
        {installing && (
          <div className="banner info" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Spinner size={16} /> Stahuji a kontroluji závislosti…
          </div>
        )}
        {hits && more && (
          <button type="button" className="btn" style={{ alignSelf: 'center' }} disabled={searching} onClick={() => void search(hits.length)}>
            Načíst další
          </button>
        )}
      </section>

      <aside className="col-side" aria-labelledby="h-inst">
        <div className="card stack" style={{ gap: 12 }}>
          <div className="section-head">
            <h2 id="h-inst" className="h2">
              Nainstalované
            </h2>
            {checking ? (
              <Spinner size={16} />
            ) : updates > 0 ? (
              <span className="pill" style={{ background: 'var(--amber-soft)', color: 'var(--amber-text)' }}>
                {updates === 1 ? '1 aktualizace' : updates < 5 ? `${updates} aktualizace` : `${updates} aktualizací`}
              </span>
            ) : (
              shown && <span className="chip">{shown.length}</span>
            )}
          </div>
          {running && <div className="banner info">Zapínat, aktualizovat a mazat jde po zastavení serveru.</div>}
          {updates > 1 && (
            <button type="button" className="btn primary" disabled={busy || running} onClick={() => void act('Aktualizace selhala', () => api.updateContent(server.id), 'Vše aktualizováno')}>
              Aktualizovat vše
            </button>
          )}
          {shown === null ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <span className="muted small">Zatím nic.</span>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {shown.map((i) => (
                <InstalledRow
                  key={i.file}
                  item={i}
                  locked={running}
                  busy={busy}
                  onToggle={(v) => void act('Změna selhala', () => api.setContentEnabled(server.id, i.folder, i.file, v))}
                  onUpdate={() => void act('Aktualizace selhala', () => api.updateContent(server.id, { folder: i.folder, file: i.file }), `${i.name} aktualizován`)}
                  onRemove={() => setRemove(i)}
                />
              ))}
            </ul>
          )}
        </div>

        <div
          className={`empty dropzone${dragOver ? ' over' : ''}`}
          style={{ padding: 20, gap: 12 }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {upload ? (
            <div className="stack" style={{ width: '100%', gap: 8 }}>
              <span>
                Nahrávám {upload.name} · {upload.pct} %
              </span>
              <Progress pct={upload.pct} />
            </div>
          ) : (
            <>
              <span style={{ fontWeight: 600 }}>Nahrát .jar ručně</span>
              <input ref={fileRef} type="file" accept=".jar" hidden onChange={(e) => void uploadJar(e.target.files?.[0])} />
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                Vybrat soubor
              </button>
            </>
          )}
        </div>
      </aside>

      {remove && (
        <ConfirmDialog
          title={`Smazat ${remove.name}?`}
          text="Jar se přesune do koše srvMC. Jeho nastavení zůstane na serveru."
          confirmLabel="Přesunout do koše"
          danger
          onCancel={() => setRemove(null)}
          onConfirm={() => {
            const r = remove;
            setRemove(null);
            void act('Mazání selhalo', () => api.removeContent(server.id, r.folder, r.file), `${r.name} přesunut do koše`);
          }}
        />
      )}
    </div>
  );
}
