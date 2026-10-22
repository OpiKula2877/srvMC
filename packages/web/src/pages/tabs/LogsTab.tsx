import { useEffect, useMemo, useState } from 'react';
import type { LogFileInfo, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { ConfirmDialog, useToast } from '../../components/Overlays.tsx';
import { bytes, dateTime } from '../../format.ts';
import { locale, t } from '@srvmc/shared';

const RENDER_LIMIT = 5000;

function lineClass(line: string): string {
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception\b|^\s+at /.test(line)) return 'lv-error';
  if (/\bWARN(ING)?\b/.test(line)) return 'lv-warn';
  return 'lv-info';
}

export function LogsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [logs, setLogs] = useState<LogFileInfo[] | null>(null);
  const [current, setCurrent] = useState<LogFileInfo | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [deleting, setDeleting] = useState<LogFileInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (l: LogFileInfo) => {
    setBusy(true);
    try {
      await api.deleteLog(server.id, l.kind, l.name);
      toast('ok', t('Log {name} deleted', { name: l.name }));
      setDeleting(null);
      if (current?.name === l.name && current.kind === l.kind) setCurrent(null);
      await refresh();
    } catch (err) {
      toast('error', t('Could not delete the log'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = () =>
    api
      .logs(server.id)
      .then((list) => {
        setLogs(list);
        setCurrent((c) => (c && list.some((l) => l.name === c.name && l.kind === c.kind) ? c : (list.find((l) => l.name === 'latest.log') ?? list[0] ?? null)));
      })
      .catch((err: Error) => toast('error', t('Could not load the logs'), err.message));

  useEffect(() => {
    void refresh();
  }, [server.id]);

  useEffect(() => {
    if (!current) return;
    setText(null);
    api
      .logFile(server.id, current.kind, current.name)
      .then((r) => {
        setText(r.text);
        setTruncated(r.truncated);
      })
      .catch((err: Error) => toast('error', t('Could not open the log'), err.message));
  }, [server.id, current]);

  const matched = useMemo(() => {
    const all = (text ?? '').split(/\r?\n/);
    const q = query.trim().toLowerCase();
    return all.filter((l) => (!q || l.toLowerCase().includes(q)) && (!problemsOnly || lineClass(l) !== 'lv-info'));
  }, [text, query, problemsOnly]);
  // Rendering tens of thousands of rows freezes the window; show the newest part and say so.
  const lines = matched.slice(-RENDER_LIMIT);

  return (
    <div className="row">
      <aside className="card stack" aria-label={t('Log files')} style={{ flex: '1 1 260px', minWidth: 0, gap: 6, padding: 12, maxHeight: 660, overflowY: 'auto' }}>
        <div className="section-head" style={{ padding: '4px 4px 8px' }}>
          <h2 className="h2" style={{ fontSize: 15 }}>
            {t('Logs')}
          </h2>
          <button type="button" className="btn icon sm" aria-label={t('Refresh the list')} onClick={() => void refresh()}>
            <Icon name="restart" size={15} />
          </button>
        </div>
        {logs?.length === 0 && <span className="muted small" style={{ padding: 8 }}>{t('No logs yet. They appear after the first start.')}</span>}
        {logs?.map((l) => (
          <button key={`${l.kind}/${l.name}`} type="button" className="list-item" aria-current={current?.name === l.name && current.kind === l.kind} onClick={() => setCurrent(l)}>
            <span style={{ fontWeight: 500, color: l.kind === 'crash' ? 'var(--red-text)' : 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13, wordBreak: 'break-all' }}>
              {l.kind === 'crash' ? `${t('Crash')}: ` : ''}
              {l.name}
            </span>
            <span className="muted small">
              {dateTime(l.mtime)} · {bytes(l.size)}
            </span>
          </button>
        ))}
      </aside>

      <section className="stack" aria-label={t('Log content')} style={{ flex: '999 1 560px', minWidth: 0, gap: 12 }}>
        <div className="section-head">
          <label className="searchbox" style={{ flex: '1 1 260px' }}>
            <Icon name="search" size={16} />
            <span className="sr-only">{t('Search the log')}</span>
            <input value={query} placeholder={t('Search the log…')} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn sm" aria-pressed={problemsOnly} style={problemsOnly ? { borderColor: 'var(--amber)', color: 'var(--amber-text)', minHeight: 40 } : { minHeight: 40 }} onClick={() => setProblemsOnly((v) => !v)}>
              {t('Warnings and errors only')}
            </button>
            {current && (
              <a className="btn sm" style={{ minHeight: 40 }} href={api.logDownloadUrl(server.id, current.kind, current.name)} download>
                {t('Download')}
              </a>
            )}
            {current && !(server.status !== 'stopped' && current.kind === 'log' && current.name === 'latest.log') && (
              <button type="button" className="btn sm danger" style={{ minHeight: 40 }} onClick={() => setDeleting(current)}>
                <Icon name="trash" size={15} />
                {t('Delete')}
              </button>
            )}
          </div>
        </div>
        {(truncated || matched.length > RENDER_LIMIT) && (
          <div className="banner info">{t('The log is large – showing the last {n} lines. Download it or search to see everything.', { n: Math.min(matched.length, RENDER_LIMIT).toLocaleString(locale()) })}</div>
        )}
        <div className="viewer" role="log" aria-label={current?.name ?? 'Log'}>
          {current && text === null && <Spinner />}
          {text !== null && lines.length === 0 && <span className="muted">{t('Nothing matches the search.')}</span>}
          {text !== null &&
            lines.map((l, i) => (
              <div key={i} className={lineClass(l)}>
                {l || ' '}
              </div>
            ))}
        </div>
      </section>
      {deleting && (
        <ConfirmDialog
          title={t('Delete the log {name}?', { name: deleting.name })}
          text={t('The file is deleted for good.')}
          confirmLabel={t('Delete')}
          danger
          busy={busy}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
