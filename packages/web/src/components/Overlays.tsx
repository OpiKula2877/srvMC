import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { t } from '@srvmc/shared';

type ToastKind = 'ok' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string;
}

const COLORS: Record<ToastKind, string> = { ok: 'var(--green)', error: 'var(--red)', info: 'var(--blue)' };

const ToastContext = createContext<(kind: ToastKind, title: string, text?: string) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, title: string, text?: string) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { id, kind, title, text }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className="toast" role="status">
            <span className="dot" style={{ background: COLORS[item.kind] }} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{item.title}</span>
              {item.text && <span className="muted" style={{ fontSize: 13 }}>{item.text}</span>}
            </span>
            <button type="button" className="btn ghost icon sm" aria-label={t('Close notification')} onClick={() => dismiss(item.id)}>
              <Icon name="close" size={14} strokeWidth={2.4} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function PromptDialog(props: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, like a file manager does.
    const dot = props.initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
  }, [props.initial]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) props.onConfirm(value.trim());
        }}
        onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
      >
        <h2 id="prompt-title" style={{ fontSize: 18, fontWeight: 600 }}>
          {props.title}
        </h2>
        <label className="field">
          <span className="label">{props.label}</span>
          <input ref={inputRef} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={props.onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {props.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog(props: {
  title: string;
  text: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onCancel]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 id="dlg-title" style={{ fontSize: 18, fontWeight: 600 }}>
          {props.title}
        </h2>
        <div className="muted" style={{ lineHeight: 1.5 }}>
          {props.text}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" ref={cancelRef} onClick={props.onCancel}>
            {props.cancelLabel ?? t('Cancel')}
          </button>
          <button
            type="button"
            className={`btn ${props.danger ? '' : 'primary'}`}
            style={props.danger ? { background: '#e5484d', borderColor: '#e5484d', color: '#fff', fontWeight: 600 } : undefined}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
