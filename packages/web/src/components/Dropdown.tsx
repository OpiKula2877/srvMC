import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon.tsx';
import { t } from '@srvmc/shared';

export interface Option {
  value: string;
  label: string;
  hint?: string;
  swatch?: string;
}

interface Props {
  label?: string;
  value: string | undefined;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Default: on when there are more than 7 options. */
  searchable?: boolean;
  mono?: boolean;
  disabled?: boolean;
  loading?: boolean;
}

/** Custom select: keyboard navigation, type-to-search, closes on outside click or Escape. */
export function Dropdown({ label, value, options, onChange, placeholder, searchable, mono, disabled, loading }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const canSearch = searchable ?? options.length > 7;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q));
  }, [options, query]);

  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Reset search and highlight the current value each time the menu opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    }
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (o: Option) => {
    onChange(o.value);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (filtered.length ? (a + d + filtered.length) % filtered.length : -1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      const o = filtered[active];
      if (o) pick(o);
    }
  };

  return (
    <div className="dd" ref={rootRef} onKeyDown={onKey}>
      {label && (
        <span className="muted" style={{ fontSize: 13 }} id={`${id}-label`}>
          {label}
        </span>
      )}
      <button
        type="button"
        className="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={label ? `${id}-label` : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={mono ? { fontFamily: 'var(--mono)', fontSize: 13 } : undefined}
      >
        {current?.swatch && <span className="swatch" style={{ width: 10, height: 10, borderRadius: 3, background: current.swatch }} />}
        <span className={`value${current ? '' : ' placeholder'}`}>{loading ? t('Loading…') : (current?.label ?? placeholder ?? t('Choose…'))}</span>
        <span className="dd-chev">
          <Icon name="chevron" size={16} strokeWidth={2.2} />
        </span>
      </button>
      {open && (
        <div className="dd-panel">
          {canSearch && (
            <label className="dd-search">
              <Icon name="search" size={15} />
              <span className="sr-only">{t('Search')}</span>
              <input
                autoFocus
                value={query}
                placeholder={t('Search…')}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
              />
            </label>
          )}
          <div className="dd-list" role="listbox" aria-labelledby={label ? `${id}-label` : undefined} ref={listRef}>
            {filtered.map((o, i) => (
              <button
                type="button"
                key={o.value}
                role="option"
                data-index={i}
                aria-selected={o.value === value}
                className={`dd-opt${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                style={mono ? { fontFamily: 'var(--mono)', fontSize: 13 } : undefined}
              >
                {o.swatch && <span className="swatch" style={{ background: o.swatch }} />}
                <span style={{ flex: 1, minWidth: 0 }}>{o.label}</span>
                {o.value === value && (
                  <span style={{ color: 'var(--green)' }}>
                    <Icon name="check" size={16} strokeWidth={2.6} />
                  </span>
                )}
              </button>
            ))}
            {filtered.length === 0 && <div className="dd-empty">{t('Nothing found')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
