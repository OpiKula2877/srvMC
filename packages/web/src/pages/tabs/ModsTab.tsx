import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  editionOf,
  type ContentHit,
  type ContentSource,
  type ContentTarget,
  type InstalledContent,
  type ManualDownload,
  type ServerInfo,
} from "@srvmc/shared";
import { api } from "../../api.ts";
import { Progress, Toggle } from "../../components/Controls.tsx";
import { AddonCards } from "./AddonCards.tsx";
import { CurseForgeKey } from "./CurseForgeKey.tsx";
import { ManualList } from "../../components/ManualList.tsx";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon, Spinner } from "../../components/Icon.tsx";
import { ConfirmDialog, useToast } from "../../components/Overlays.tsx";
import { bytes, nameColor } from "../../format.ts";
import { locale, t } from "@srvmc/shared";

const SOURCE_LABEL: Record<ContentSource, string> = {
  modrinth: "Modrinth",
  hangar: "Hangar",
  spigot: "SpigotMC",
  curseforge: "CurseForge",
};
const LOADER_LABEL: Record<string, string> = {
  paper: "Paper",
  purpur: "Purpur",
  spigot: "Spigot",
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
  arclight: "Arclight",
};

const compact = new Intl.NumberFormat(locale(), {
  notation: "compact",
  maximumFractionDigits: 1,
});

function ContentIcon({
  url,
  name,
  size = 52,
}: {
  url?: string;
  name: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        style={{
          borderRadius: 10,
          flex: "none",
          objectFit: "cover",
          background: "var(--raised)",
        }}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div
      className="tile"
      style={{
        width: size,
        height: size,
        background: nameColor(name),
        fontSize: size * 0.54,
        borderRadius: 10,
      }}
      aria-hidden="true"
    >
      {name
        .replace(/[^\p{L}\p{N}]/gu, "")
        .charAt(0)
        .toUpperCase() || "?"}
    </div>
  );
}

function Result({
  hit,
  busy,
  onInstall,
}: {
  hit: ContentHit;
  busy: boolean;
  onInstall: () => void;
}) {
  const badge = hit.installed
    ? {
        text: t('Already installed'),
        bg: "var(--green-soft)",
        fg: "var(--green-text)",
      }
    : hit.clientOnly
      ? {
          text: t('Client only'),
          bg: "var(--red-soft)",
          fg: "var(--red-text)",
        }
      : !hit.installable
        ? {
            text: t("Only from the author's website"),
            bg: "var(--amber-soft)",
            fg: "var(--amber-text)",
          }
        : hit.manual
          ? {
              text: t('Manual download from CurseForge'),
              bg: "var(--amber-soft)",
              fg: "var(--amber-text)",
            }
          : null;
  return (
    <li
      className="card"
      style={{
        padding: 16,
        display: "flex",
        flexWrap: "wrap",
        gap: 14,
        alignItems: "center",
        borderColor: hit.clientOnly ? "#4a2a2d" : undefined,
      }}
    >
      <ContentIcon url={hit.iconUrl} name={hit.title} />
      <div
        style={{
          flex: "1 1 260px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "baseline",
          }}
        >
          <a
            href={hit.url}
            target="_blank"
            rel="noreferrer"
            style={{
              fontWeight: 600,
              fontSize: 15,
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            {hit.title}
          </a>
          <span className="muted small">
            {hit.author && `${t('by {author}', { author: hit.author })} · `}
            {t('{n} downloads', { n: compact.format(hit.downloads) })}
          </span>
        </div>
        {hit.description && (
          <span
            style={{ color: "var(--text-2)", fontSize: 13, lineHeight: 1.45 }}
          >
            {hit.description}
          </span>
        )}
        {badge && (
          <span
            className="pill"
            style={{
              alignSelf: "flex-start",
              background: badge.bg,
              color: badge.fg,
            }}
          >
            {badge.text}
          </span>
        )}
      </div>
      {hit.installed ? (
        <button
          type="button"
          className="btn"
          style={{ minWidth: 132 }}
          disabled
        >
          <Icon name="check" size={16} />
          {t('Done')}
        </button>
      ) : hit.installable ? (
        <button
          type="button"
          className="btn primary"
          style={{ minWidth: 132 }}
          disabled={busy}
          onClick={onInstall}
        >
          {t('Install')}
        </button>
      ) : hit.clientOnly ? (
        <button
          type="button"
          className="btn"
          style={{ minWidth: 132 }}
          disabled
        >
          {t('Not for servers')}
        </button>
      ) : (
        <a
          className="btn"
          style={{ minWidth: 132 }}
          href={hit.url}
          target="_blank"
          rel="noreferrer"
        >
          {t('Open website')}
        </a>
      )}
    </li>
  );
}

function InstalledRow({
  item,
  locked,
  busy,
  onToggle,
  onUpdate,
  onRemove,
}: {
  item: InstalledContent;
  locked: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        opacity: item.enabled ? 1 : 0.6,
      }}
    >
      <ContentIcon url={item.iconUrl} name={item.name} size={36} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={item.file}
        >
          {item.name}
        </span>
        <span
          className="muted small mono"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.version ?? bytes(item.size)}
          {item.update && (
            <span style={{ color: "var(--amber-text)" }}>
              {" "}
              → {item.update.versionNumber}
            </span>
          )}
        </span>
      </div>
      {item.update && (
        <button
          type="button"
          className="btn sm"
          style={{
            background: "var(--amber-soft)",
            borderColor: "transparent",
            color: "var(--amber-text)",
          }}
          disabled={busy || locked}
          title={locked ? t('Stop the server first') : undefined}
          onClick={onUpdate}
        >
          {t('Update')}
        </button>
      )}
      <input
        type="checkbox"
        className="toggle"
        aria-label={item.enabled ? t("Turn off {name}", { name: item.name }) : t("Turn on {name}", { name: item.name })}
        checked={item.enabled}
        disabled={busy || locked}
        title={locked ? t('Stop the server first') : undefined}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <button
        type="button"
        className="btn icon sm"
        style={{ width: 36, minHeight: 36, color: "var(--red-text)" }}
        aria-label={t("Delete {name}", { name: item.name })}
        disabled={busy || locked}
        onClick={onRemove}
      >
        <Icon name="trash" size={15} />
      </button>
    </li>
  );
}

export function ModsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [targets, setTargets] = useState<ContentTarget[] | null>(null);
  const [folder, setFolder] = useState<string>("");
  const [source, setSource] = useState<ContentSource>("modrinth");
  const [query, setQuery] = useState("");
  const [hideClient, setHideClient] = useState(true);
  const [hits, setHits] = useState<ContentHit[] | null>(null);
  const [more, setMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [items, setItems] = useState<InstalledContent[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<InstalledContent | null>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(
    null,
  );
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const [cfKey, setCfKey] = useState<boolean | null>(null);
  const [manual, setManual] = useState<ManualDownload[]>([]);

  const running =
    server.status !== "stopped" &&
    server.status !== "crashed" &&
    server.status !== "error";
  const target = targets?.find((tg) => tg.folder === folder);
  const loader =
    server.type === "modpack"
      ? (server.modpack?.loader ?? "modpack")
      : server.type;
  

  useEffect(() => {
    api
      .contentTargets(server.id)
      .then((t) => {
        setTargets(t);
        setFolder((f) =>
          t.some((x) => x.folder === f) ? f : (t[0]?.folder ?? ""),
        );
      })
      .catch((err: Error) =>
        toast(
          "error",
          t('Could not load what the server supports'),
          err.message,
        ),
      );
  }, [server.id, toast]);

  const loadInstalled = useCallback(async () => {
    try {
      const list = await api.installed(server.id);
      setItems(list);
      setChecking(true);
      const withUpdates = await api.contentUpdates(server.id).catch(() => null);
      if (withUpdates) setItems(withUpdates);
    } catch (err) {
      toast("error", t('Could not load the list'), (err as Error).message);
    } finally {
      setChecking(false);
    }
  }, [server.id, toast]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  useEffect(() => {
    api
      .curseForge()
      .then((s) => setCfKey(s.keySet))
      .catch(() => setCfKey(false));
  }, []);

  // Files the user downloads by hand: watched until srvMC has taken them all from Downloads.
  const loadManual = useCallback(
    () =>
      api
        .manualDownloads(server.id)
        .then(setManual)
        .catch(() => undefined),
    [server.id],
  );
  useEffect(() => {
    void loadManual();
  }, [loadManual]);
  const waiting = manual.length;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void loadManual(), 2000);
    return () => clearInterval(t);
  }, [waiting, loadManual]);
  const prevWaiting = useRef(0);
  useEffect(() => {
    if (waiting < prevWaiting.current) void loadInstalled();
    prevWaiting.current = waiting;
  }, [waiting, loadInstalled]);

  const needsKey = source === "curseforge" && cfKey === false;

  const search = useCallback(
    async (offset: number) => {
      if (!target || (source === "curseforge" && !cfKey)) return;
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const page = await api.searchContent(server.id, {
          source,
          folder: target.folder,
          q: query,
          offset,
          hideClient,
        });
        if (seq !== searchSeq.current) return;
        setHits((prev) => (offset === 0 ? page : [...(prev ?? []), ...page]));
        setMore(page.length >= 20);
      } catch (err) {
        if (seq === searchSeq.current)
          toast("error", t('Search failed'), (err as Error).message);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [server.id, target, source, query, hideClient, cfKey, toast],
  );

  // Typing waits a moment before searching; other filter changes search at once.
  useEffect(() => {
    const t = setTimeout(() => void search(0), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [search, query]);

  useEffect(() => {
    if (target && !target.sources.includes(source))
      setSource(target.sources[0]!);
  }, [target, source]);

  const install = async (hit: ContentHit) => {
    if (!target) return;
    setInstalling(hit.id);
    try {
      const r = await api.installContent(server.id, {
        source: hit.source,
        id: hit.id,
        folder: target.folder,
      });
      toast(
        "ok",
        t("Installed: {name}", { name: hit.title }),
        [
          r.manual?.length &&
            t("Download by hand: {list}", { list: r.manual.map((m) => m.title).join(", ") }),
          r.installed.length > 1 &&
            t("With dependencies: {list}", { list: r.installed.slice(1).join(", ") }),
          r.skipped.length && t("Skipped: {list}", { list: r.skipped.join(", ") }),
          running && t('Takes effect after the server restarts.'),
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      );
      setHits(
        (h) =>
          h?.map((x) =>
            x.id === hit.id && x.source === hit.source
              ? { ...x, installed: true }
              : x,
          ) ?? null,
      );
      void loadInstalled();
      if (r.manual?.length) void loadManual();
    } catch (err) {
      toast(
        "error",
        t("Could not install {name}", { name: hit.title }),
        (err as Error).message,
      );
    } finally {
      setInstalling(null);
    }
  };

  const act = async (
    label: string,
    fn: () => Promise<unknown>,
    ok?: string,
  ) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast("ok", ok);
      await loadInstalled();
    } catch (err) {
      toast("error", label, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadJar = async (file: File | undefined) => {
    if (!file || !target) return;
    if (!/\.jar$/i.test(file.name))
      return toast("error", t('Only .jar files can be uploaded'));
    setUpload({ name: file.name, pct: 0 });
    try {
      const r = await api.uploadJar(
        server.id,
        target.folder,
        file,
        false,
        (pct) => setUpload({ name: file.name, pct }),
      );
      toast(
        "ok",
        t("Uploaded: {name}", { name: `${r.name}${r.version ? ` ${r.version}` : ""}` }),
        running ? t('Takes effect after the server restarts.') : undefined,
      );
      void loadInstalled();
    } catch (err) {
      toast("error", t('Could not upload the jar'), (err as Error).message);
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
        {editionOf(server.type) === "java" ? (
          <>
            <span style={{ fontWeight: 600 }}>
              {t('A Vanilla server cannot run mods or plugins')}
            </span>
            <span className="muted">
              {t("For plugins create a Paper or Purpur server, for mods Fabric, Forge or NeoForge.")}
            </span>
          </>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>
              {editionOf(server.type) === "bedrock"
                ? t('Bedrock add-ons are not supported yet')
                : t('Hytale mods are not supported yet')}
            </span>
            <span className="muted">{t('You can upload them by hand in Files.')}</span>
          </>
        )}
      </div>
    );
  }

  const shown = items?.filter((i) => i.folder === folder) ?? null;
  const updates = shown?.filter((i) => i.update).length ?? 0;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <AddonCards server={server} />
      <div className="row">
        <section
          className="col-main"
          aria-labelledby="h-search"
          style={{ gap: 14 }}
        >
          <div className="section-head">
            <h2 id="h-search" className="h2">
              {target?.kind === "mod" ? t("Search mods") : t("Search plugins")}
            </h2>
            {targets.length > 1 && (
              <div className="seg" role="tablist" aria-label={t('What to search')}>
                {targets.map((tg) => (
                  <button
                    key={tg.folder}
                    type="button"
                    role="tab"
                    className="seg-btn"
                    aria-selected={tg.folder === folder}
                    onClick={() => setFolder(tg.folder)}
                  >
                    {tg.kind === "mod" ? t("Mods") : t("Plugins")}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "flex-end",
            }}
          >
            <label
              className="searchbox"
              style={{
                flex: "3 1 280px",
                minHeight: 44,
                background: "var(--surface)",
              }}
            >
              <Icon name="search" size={18} />
              <span className="sr-only">{t('Search')}</span>
              <input
                value={query}
                maxLength={100}
                placeholder={
                  target?.kind === "mod"
                    ? t('e.g. lithium, create…')
                    : t('e.g. luckperms, essentials…')
                }
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching && <Spinner size={16} />}
            </label>
            {target && target.sources.length > 1 && (
              <div style={{ flex: "1 1 180px" }}>
                <Dropdown
                  label={t('Source')}
                  value={source}
                  options={target.sources.map((s) => ({
                    value: s,
                    label: SOURCE_LABEL[s],
                  }))}
                  onChange={(v) => setSource(v as ContentSource)}
                  searchable={false}
                />
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span
              className="pill"
              style={{
                background: "var(--green-soft)",
                color: "var(--green-text)",
                padding: "6px 12px",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {LOADER_LABEL[loader] ?? loader} · {server.version}
            </span>
            {source === "modrinth" && target?.kind === "mod" && (
              <div style={{ minWidth: 240 }}>
                <Toggle
                  label={t('Hide client-only mods')}
                  checked={hideClient}
                  onChange={setHideClient}
                />
              </div>
            )}
          </div>

          {manual.length > 0 && (
            <ManualList
              items={manual}
              onCancel={() =>
                void api.cancelManual(server.id).then(() => loadManual())
              }
            />
          )}

          {needsKey ? (
            <CurseForgeKey
              onSaved={() => {
                setCfKey(true);
              }}
            />
          ) : hits === null ? (
            <Spinner />
          ) : hits.length === 0 ? (
            <div className="empty" style={{ padding: 32 }}>
              <span className="muted">
                {query ? t("Nothing found for \"{query}\".", { query }) : t("Nothing found.")}
              </span>
            </div>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {hits.map((h) => (
                <Result
                  key={`${h.source}:${h.id}`}
                  hit={h}
                  busy={installing !== null || !!server.task}
                  onInstall={() => void install(h)}
                />
              ))}
            </ul>
          )}
          {installing && (
            <div
              className="banner info"
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <Spinner size={16} /> {t("Downloading and checking dependencies…")}
            </div>
          )}
          {hits && more && !needsKey && (
            <button
              type="button"
              className="btn"
              style={{ alignSelf: "center" }}
              disabled={searching}
              onClick={() => void search(hits.length)}
            >
              {t('Load more')}
            </button>
          )}
        </section>

        <aside className="col-side" aria-labelledby="h-inst">
          <div className="card stack" style={{ gap: 12 }}>
            <div className="section-head">
              <h2 id="h-inst" className="h2">
                {t('Installed')}
              </h2>
              {checking ? (
                <Spinner size={16} />
              ) : updates > 0 ? (
                <span
                  className="pill"
                  style={{
                    background: "var(--amber-soft)",
                    color: "var(--amber-text)",
                  }}
                >
                  {updates === 1 ? t("1 update") : t("{n} updates", { n: updates })}
                </span>
              ) : (
                shown && <span className="chip">{shown.length}</span>
              )}
            </div>
            {running && (
              <div className="banner info">
                {t('Turning on, updating and deleting work once the server is stopped.')}
              </div>
            )}
            {updates > 1 && (
              <button
                type="button"
                className="btn primary"
                disabled={busy || running}
                onClick={() =>
                  void act(
                    t('Updating failed'),
                    () => api.updateContent(server.id),
                    t('Everything updated'),
                  )
                }
              >
                {t('Update all')}
              </button>
            )}
            {shown === null ? (
              <Spinner />
            ) : shown.length === 0 ? (
              <span className="muted small">{t('Nothing yet.')}</span>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {shown.map((i) => (
                  <InstalledRow
                    key={i.file}
                    item={i}
                    locked={running}
                    busy={busy}
                    onToggle={(v) =>
                      void act(t('The change failed'), () =>
                        api.setContentEnabled(server.id, i.folder, i.file, v),
                      )
                    }
                    onUpdate={() =>
                      void act(
                        t('Updating failed'),
                        () =>
                          api.updateContent(server.id, {
                            folder: i.folder,
                            file: i.file,
                          }),
                        t("{name} updated", { name: i.name }),
                      )
                    }
                    onRemove={() => setRemove(i)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div
            className={`empty dropzone${dragOver ? " over" : ""}`}
            style={{ padding: 20, gap: 12 }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {upload ? (
              <div className="stack" style={{ width: "100%", gap: 8 }}>
                <span>
                  {t("Uploading {name} · {pct} %", { name: upload.name, pct: upload.pct })}
                </span>
                <Progress pct={upload.pct} />
              </div>
            ) : (
              <>
                <span style={{ fontWeight: 600 }}>{t('Upload a .jar by hand')}</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".jar"
                  hidden
                  onChange={(e) => void uploadJar(e.target.files?.[0])}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                >
                  {t('Choose a file')}
                </button>
              </>
            )}
          </div>
        </aside>

        {remove && (
          <ConfirmDialog
            title={t("Delete {name}?", { name: remove.name })}
            text={t("The jar moves to srvMC's trash. Its settings stay on the server.")}
            confirmLabel={t('Move to trash')}
            danger
            onCancel={() => setRemove(null)}
            onConfirm={() => {
              const r = remove;
              setRemove(null);
              void act(
                t('Deleting failed'),
                () => api.removeContent(server.id, r.folder, r.file),
                t("{name} moved to trash", { name: r.name }),
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
