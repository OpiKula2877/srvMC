import type { ManualDownload } from '@srvmc/shared';
import { Icon, Spinner } from './Icon.tsx';

/** Files the user downloads on their website; srvMC picks each one up from the Downloads folder. */
export function ManualList({ items, onCancel }: { items: ManualDownload[]; onCancel?: () => void }) {
  const left = items.filter((i) => !i.done).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="banner info" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <Spinner size={16} />
        <span style={{ flex: 1, minWidth: 200 }}>
          {left === 1 ? 'Jeden soubor' : `${left} souborů`} jde stáhnout jen z webu autora. Klikni na Stáhnout, soubor se uloží do Stažených souborů a srvMC si ho sám vezme.
        </span>
        {onCancel && (
          <button type="button" className="btn sm" onClick={onCancel}>
            Zrušit
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
                Převzato
              </span>
            ) : (
              <a className="btn sm primary" href={i.url} target="_blank" rel="noreferrer">
                Stáhnout
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
