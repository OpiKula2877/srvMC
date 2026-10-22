import type { ManualDownload } from '@srvmc/shared';
import { Icon, Spinner } from './Icon.tsx';
import { t } from '@srvmc/shared';

/** Files the user downloads on their website; srvMC picks each one up from the Downloads folder. */
export function ManualList({ items, onCancel }: { items: ManualDownload[]; onCancel?: () => void }) {
  const left = items.filter((i) => !i.done).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="banner info" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <Spinner size={16} />
        <span style={{ flex: 1, minWidth: 200 }}>
          {left === 1 ? t('One file can only be downloaded from its website. Click Download, the file is saved to Downloads and srvMC picks it up by itself.') : t('{n} files can only be downloaded from their website. Click Download, each file is saved to Downloads and srvMC picks it up by itself.', { n: left })}
        </span>
        {onCancel && (
          <button type="button" className="btn sm" onClick={onCancel}>
            {t('Cancel')}
          </button>
        )}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((i) => (
          <li key={i.id} className="card tight" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{i.title}</span>
              <span className="muted small mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {i.fileName}
              </span>
            </div>
            {i.done ? (
              <span className="pill" style={{ background: 'var(--green-soft)', color: 'var(--green-text)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="check" size={14} />
                {t('Picked up')}
              </span>
            ) : (
              <a className="btn sm primary" href={i.url} target="_blank" rel="noreferrer">
                {t('Download')}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
