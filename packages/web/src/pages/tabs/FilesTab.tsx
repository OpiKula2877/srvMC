import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { DirListing, FileEntry, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { MenuButton, Progress, Toggle } from '../../components/Controls.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, PromptDialog, useToast } from '../../components/Overlays.tsx';
import { bytes, dateTime } from '../../format.ts';
import { t } from '@srvmc/shared';

const TEXT_EXT = /\.(properties|ya?ml|json5?|txt|toml|cfg|conf|ini|log|md|csv|mcmeta|sk|js|xml|bat|sh|cmd|lang|secret|snbt)$/i;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');

interface Editing {
  path: string;
  content: string;
  original: string;
}

interface Upload {
  id: number;
  name: string;
  pct: number;
  error?: string;
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

function Editor({ server, editing, onChange, onClose, onSaved }: { server: ServerInfo; editing: Editing; onChange: (c: string) => void; onClose: () => void; onSaved: (c: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const gutterRef = useRef<HTMLDivElement>(null);
  const dirty = editing.content !== editing.original;
  const lineCount = editing.content.split('\n').length;

  const save = async () => {
    setBusy(true);
    try {
      await api.saveFile(server.id, editing.path, editing.content);
      onSaved(editing.content);
      toast('ok', t('File saved'), editing.path);
    } catch (err) {
      toast('error', t('Saving failed'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty) void save();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      onChange(`${editing.content.slice(0, a)}  ${editing.content.slice(b)}`);
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
    }
  };

  return (
    <section className="stack" aria-label={t('Editing {path}', { path: editing.path })} style={{ gap: 12 }}>
      <div className="section-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span className="mono" style={{ fontWeight: 600, wordBreak: 'break-all' }}>
            {editing.path}
          </span>
          {dirty && <span className="pill" style={{ background: 'var(--amber-soft)', color: 'var(--amber-text)' }}>{t('unsaved')}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn ghost" onClick={() => (dirty ? setConfirmClose(true) : onClose())}>
            {t('Close')}
          </button>
          <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <Spinner size={16} /> : null}
            {t('Save')}
            <span className="mono small" style={{ opacity: 0.7 }}>
              Ctrl+S
            </span>
          </button>
        </div>
      </div>
      <div className="editor">
        <div className="gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
        </div>
        <textarea
          aria-label={t('Content of {path}', { path: editing.path })}
          spellCheck={false}
          value={editing.content}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      {server.status === 'running' && <div className="banner info">{t('The server is running. Config changes usually take effect after a restart.')}</div>}
      {confirmClose && (
        <ConfirmDialog title={t('Close without saving?')} text={t('The changes to the file are lost.')} confirmLabel={t('Close')} danger onConfirm={onClose} onCancel={() => setConfirmClose(false)} />
      )}
    </section>
  );
}

export function FilesTab({ server, openFile }: { server: ServerInfo; openFile?: string }) {
  const toast = useToast();
  const [dir, setDir] = useState(openFile ? parentOf(openFile) : '');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadId = useRef(1);
  const running = server.status === 'running' || server.status === 'starting' || server.status === 'stopping';

  const load = useCallback(
    (path: string) =>
      api
        .files(server.id, path)
        .then((l) => {
          setListing(l);
          setSelected(new Set());
        })
        .catch((err: Error) => {
          toast('error', t('Could not open the folder'), err.message);
          if (path) setDir('');
        }),
    [server.id, toast],
  );

  useEffect(() => {
    void load(dir);
  }, [dir, load]);

  const openText = useCallback(
    async (path: string) => {
      try {
        const f = await api.fileContent(server.id, path);
        setEditing({ path: f.path, content: f.content, original: f.content });
      } catch (err) {
        toast('error', t('The file cannot be opened'), (err as Error).message);
      }
    },
    [server.id, toast],
  );

  useEffect(() => {
    if (openFile) void openText(openFile);
  }, [openFile, openText]);

  const uploadFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const id = uploadId.current++;
      setUploads((u) => [...u, { id, name: file.name, pct: 0 }]);
      try {
        await api.upload(server.id, dir, file, overwrite, (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))));
        setUploads((u) => u.filter((x) => x.id !== id));
      } catch (err) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: (err as Error).message } : x)));
      }
    }
    await load(dir);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  };

  const act = async (label: string, fn: () => Promise<unknown>, okText?: string) => {
    try {
      await fn();
      if (okText) toast('ok', okText);
      await load(dir);
    } catch (err) {
      toast('error', label, (err as Error).message);
    }
  };

  if (editing) {
    return (
      <Editor
        server={server}
        editing={editing}
        onChange={(content) => setEditing({ ...editing, content })}
        onSaved={(content) => setEditing({ ...editing, content, original: content })}
        onClose={() => {
          setEditing(null);
          void load(dir);
        }}
      />
    );
  }

  const crumbs = dir ? dir.split('/') : [];
  const entries = listing?.entries ?? [];
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.name));

  return (
    <section className="stack" aria-label={t('Server files')} style={{ gap: 14 }}>
      <div className="section-head">
        <nav className="crumbs" aria-label={t('Path')}>
          <button type="button" onClick={() => setDir('')}>
            server
          </button>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'contents' }}>
              <span className="sep">/</span>
              <button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {selected.size > 0 && (
            <a
              className="btn sm"
              style={{ minHeight: 40 }}
              href={
                selected.size === 1 && entries.find((e) => selected.has(e.name))?.type === 'file'
                  ? api.fileDownloadUrl(server.id, join(dir, [...selected][0]!))
                  : api.filesZipUrl(server.id, [...selected].map((n) => join(dir, n)))
              }
              download
            >
              <Icon name="download" size={15} />
              {t('Download selected ({n})', { n: selected.size })}
            </a>
          )}
          {selected.size > 0 && (
            <button type="button" className="btn sm danger" style={{ minHeight: 40 }} disabled={running} onClick={() => setDeleting([...selected].map((n) => join(dir, n)))}>
              <Icon name="trash" size={15} />
              {t('Delete selected ({n})', { n: selected.size })}
            </button>
          )}
          <button type="button" className="btn sm" style={{ minHeight: 40 }} disabled={!dir} onClick={() => setDir(parentOf(dir))}>
            <Icon name="back" size={15} />
            {t('Up')}
          </button>
          <button type="button" className="btn sm" style={{ minHeight: 40 }} onClick={() => setMkdirOpen(true)}>
            <Icon name="plus" size={15} />
            {t('New folder')}
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files)} />
          <button type="button" className="btn sm primary" style={{ minHeight: 40 }} onClick={() => fileInput.current?.click()}>
            {t('Upload files')}
          </button>
        </div>
      </div>

      {running && <div className="banner info">{t('The server is running – deleting and renaming are locked so the world does not break. You can edit and upload.')}</div>}

      <div
        className={`card dropzone${dragOver ? ' over' : ''}`}
        style={{ padding: 0 }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th scope="col" style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    className="check"
                    aria-label={t('Select all')}
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())}
                  />
                </th>
                <th scope="col">{t('Name')}</th>
                <th scope="col" className="num">
                  {t('Size')}
                </th>
                <th scope="col">{t('Modified')}</th>
                <th scope="col" className="num">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!listing && (
                <tr>
                  <td colSpan={5}>
                    <Spinner />
                  </td>
                </tr>
              )}
              {listing && entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ padding: '24px 12px' }}>
                    {t('Empty folder. Drop files here or use Upload.')}
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const path = join(dir, e.name);
                const isZip = e.type === 'file' && /\.zip$/i.test(e.name);
                return (
                  <tr key={e.name}>
                    <td>
                      <input
                        type="checkbox"
                        className="check"
                        aria-label={t('Select {name}', { name: e.name })}
                        checked={selected.has(e.name)}
                        onChange={(ev) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (ev.target.checked) next.add(e.name);
                            else next.delete(e.name);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="file-name"
                        onClick={() => {
                          if (e.type === 'dir') setDir(path);
                          else if (TEXT_EXT.test(e.name) || e.size < 64 * 1024) void openText(path);
                          else window.location.href = api.fileDownloadUrl(server.id, path);
                        }}
                      >
                        <span className={`ic${e.type === 'dir' ? ' dir' : ''}`}>{e.type === 'dir' ? <FolderIcon /> : <FileIcon />}</span>
                        <span style={{ wordBreak: 'break-all' }}>{e.name}</span>
                      </button>
                    </td>
                    <td className="num muted">{e.type === 'dir' ? '' : bytes(e.size)}</td>
                    <td className="muted small">{dateTime(e.mtime)}</td>
                    <td className="num">
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {e.type === 'file' && (
                          <a className="btn icon sm" href={api.fileDownloadUrl(server.id, path)} aria-label={t('Download {name}', { name: e.name })} download>
                            <Icon name="download" size={15} />
                          </a>
                        )}
                        <MenuButton
                          label={t('Actions for {name}', { name: e.name })}
                          items={[
                            {
                              label: e.type === 'dir' ? t('Download as zip') : t('Download'),
                              onClick: () => {
                                window.location.href = e.type === 'dir' ? api.filesZipUrl(server.id, [path]) : api.fileDownloadUrl(server.id, path);
                              },
                            },
                            ...(e.type === 'file' && (TEXT_EXT.test(e.name) || e.size < 64 * 1024) ? [{ label: t('Edit'), onClick: () => void openText(path) }] : []),
                            ...(isZip ? [{ label: t('Unzip here'), onClick: () => void act(t('Unzipping failed'), () => api.unzip(server.id, path), t('Unzipped')) }] : []),
                            ...(running
                              ? []
                              : [
                                  { label: t('Rename'), onClick: () => setRenaming(e) },
                                  { label: t('Delete'), color: 'var(--red-text)', onClick: () => setDeleting([path]) },
                                ]),
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ maxWidth: 360 }}>
        <Toggle label={t('Overwrite existing files when uploading')} checked={overwrite} onChange={setOverwrite} />
      </div>

      {uploads.length > 0 && (
        <div className="card tight uploads" aria-live="polite">
          {uploads.map((u) => (
            <div key={u.id} className="stack" style={{ gap: 6, fontSize: 13 }}>
              <div className="kv">
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {u.name}
                </span>
                {u.error ? (
                  <button type="button" className="btn ghost sm" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                    {t('Close')}
                  </button>
                ) : (
                  <span>{u.pct} %</span>
                )}
              </div>
              {u.error ? <span className="field-error">{u.error}</span> : <Progress pct={u.pct} />}
            </div>
          ))}
        </div>
      )}

      {mkdirOpen && (
        <PromptDialog
          title={t('New folder')}
          label={t('Folder name')}
          initial=""
          confirmLabel={t('Create')}
          onCancel={() => setMkdirOpen(false)}
          onConfirm={(name) => {
            setMkdirOpen(false);
            void act(t('Could not create the folder'), () => api.mkdir(server.id, join(dir, name)));
          }}
        />
      )}
      {renaming && (
        <PromptDialog
          title={t('Rename {name}', { name: renaming.name })}
          label={t('New name')}
          initial={renaming.name}
          confirmLabel={t('Rename')}
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            const from = join(dir, renaming.name);
            setRenaming(null);
            if (name !== renaming.name) void act(t('Renaming failed'), () => api.rename(server.id, from, join(dir, name)));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={deleting.length === 1 ? t('Delete {name}?', { name: deleting[0]!.split('/').pop() ?? '' }) : t('Delete {n} items?', { n: deleting.length })}
          text={t("It moves to srvMC's trash (the trash folder in srvMC's data). You can bring it back from there by hand.")}
          confirmLabel={t('Move to trash')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const paths = deleting;
            setDeleting(null);
            void act(t('Deleting failed'), () => api.deleteFiles(server.id, paths), t('Moved to trash'));
          }}
        />
      )}
    </section>
  );
}
