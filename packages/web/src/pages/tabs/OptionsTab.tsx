import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ampToSection,
  MC_COLORS,
  parseMotd,
  PROPERTY_DEFS,
  PROPERTY_GROUPS,
  sectionToAmp,
  type AuthMode,
  type AuthState,
  type PropertyDef,
  type ServerInfo,
} from '@srvmc/shared';
import { api } from '../../api.ts';
import { Stepper } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { href } from '../../router.ts';

const DARK_CODES = new Set(['0', '1', '4', '5', '8']);

async function toServerIcon(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const side = Math.min(bmp.width, bmp.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 64, 64);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Obrázek se nepodařilo převést.'))), 'image/png'));
}

/** Minecraft draws every glyph twice: the shadow is the text color at a quarter brightness. */
function shadowOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const q = (shift: number) => ((n >> shift) & 255) >> 2;
  return `2px 2px 0 rgb(${q(16)}, ${q(8)}, ${q(0)})`;
}

function MotdLine({ text }: { text: string }) {
  const segs = parseMotd(text);
  return (
    <div className="line">
      {segs.length === 0 ? ' ' : null}
      {segs.map((s, i) => (
        <span
          key={i}
          style={{
            color: s.color,
            textShadow: shadowOf(s.color),
            fontWeight: s.bold ? 700 : 400,
            fontStyle: s.italic ? 'italic' : 'normal',
            textDecoration: [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
          }}
        >
          {s.obfuscated ? s.text.replace(/\S/g, '▒') : s.text}
        </span>
      ))}
    </div>
  );
}

function PropertyControl({ def, value, onChange }: { def: PropertyDef; value: string; onChange: (v: string) => void }) {
  if (def.type === 'bool') {
    return <input type="checkbox" className="toggle" aria-label={def.label} checked={value === 'true'} onChange={(e) => onChange(String(e.target.checked))} />;
  }
  if (def.type === 'enum') {
    return <Dropdown value={value} options={def.options ?? []} onChange={onChange} searchable={false} />;
  }
  if (def.type === 'int') {
    return <Stepper label={def.label} value={Number(value)} min={def.min} max={def.max} onChange={(n) => onChange(String(n))} />;
  }
  return <input className="input" aria-label={def.label} value={value} onChange={(e) => onChange(e.target.value)} />;
}

const AUTH_CHOICES: { mode: AuthMode; label: string; danger?: boolean }[] = [
  { mode: 'online', label: 'Jen placené účty' },
  { mode: 'hybrid', label: 'Placené i neplacené (s heslem)' },
  { mode: 'offline', label: 'I neplacené, bez ochrany', danger: true },
];

function AuthCard({ server, onChanged }: { server: ServerInfo; onChanged: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<AuthState | null>(null);
  const [pending, setPending] = useState<AuthMode | null>(null);
  const stopped = server.status === 'stopped' || server.status === 'crashed' || server.status === 'error';
  const plugins = !['fabric', 'quilt'].includes(server.type === 'modpack' ? (server.modpack?.loader ?? '') : server.type);

  useEffect(() => {
    api
      .auth(server.id)
      .then(setState)
      .catch((err: Error) => toast('error', 'Nepodařilo se zjistit přihlašování', err.message));
  }, [server.id, toast]);

  const choose = async (mode: AuthMode) => {
    if (mode === state?.mode) return;
    setPending(mode);
    try {
      setState(await api.setAuth(server.id, mode));
      onChanged();
      if (mode === 'hybrid') {
        toast('ok', 'Placené i neplacené účty', plugins ? 'Hráč si při prvním připojení nastaví heslo. Kdo má placený účet, napíše jednou /premium a dál se přihlásí sám.' : 'Neplacení si při prvním připojení nastaví heslo, placení se přihlásí sami.');
      } else {
        toast('ok', mode === 'online' ? 'Jen placené účty' : 'Kdokoli bez ověření');
      }
    } catch (err) {
      toast('error', 'Přihlašování se nepodařilo změnit', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="col-side card stack" aria-labelledby="h-ucty" style={{ gap: 12 }}>
      <div className="section-head">
        <h2 id="h-ucty" className="h2">
          Kdo se může připojit
        </h2>
        {(state === null || pending) && <Spinner size={16} />}
      </div>
      {!stopped && <div className="banner info">Mění se u vypnutého serveru.</div>}
      {AUTH_CHOICES.map((c) => {
        const unsupported = c.mode === 'hybrid' && state !== null && !state.hybridSupported;
        return (
          <button
            key={c.mode}
            type="button"
            className={`choice${c.danger ? ' danger' : ''}`}
            aria-pressed={state?.mode === c.mode}
            disabled={state === null || !!pending || !stopped || unsupported}
            title={unsupported ? 'Jde na Paper, Purpur, Spigot, Fabric a Quilt' : undefined}
            onClick={() => void choose(c.mode)}
          >
            <span className="title">
              <span className="radio" />
              {c.label}
            </span>
          </button>
        );
      })}
      {state?.mode === 'offline' && <div className="banner error">Bez ověřování si někdo může vzít jméno operátora. Zapni bílou listinu a dávej OP opatrně.</div>}
    </section>
  );
}

export function OptionsTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [iconVersion, setIconVersion] = useState(() => Date.now());
  const [hasIcon, setHasIcon] = useState(true);
  const [target, setTarget] = useState<0 | 1>(0);
  const lineRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];
  const fileRef = useRef<HTMLInputElement>(null);
  const running = server.status === 'running' || server.status === 'starting';

  useEffect(() => {
    api
      .properties(server.id)
      .then((r) => setValues(r.values))
      .catch((err: Error) => toast('error', 'Nastavení se nepodařilo načíst', err.message));
  }, [server.id, toast]);

  const value = (key: string): string => edits[key] ?? values?.[key] ?? PROPERTY_DEFS.find((d) => d.key === key)?.default ?? '';
  const set = (key: string, v: string) =>
    setEdits((e) => {
      const next = { ...e, [key]: v };
      if ((values?.[key] ?? PROPERTY_DEFS.find((d) => d.key === key)?.default) === v) delete next[key];
      return next;
    });

  const motdLines = value('motd').split('\n');
  const lines: [string, string] = [sectionToAmp(motdLines[0] ?? ''), sectionToAmp(motdLines.slice(1).join(' '))];
  const setLine = (i: 0 | 1, text: string) => {
    const next: [string, string] = [...lines];
    next[i] = text;
    set('motd', next[1] ? `${ampToSection(next[0])}\n${ampToSection(next[1])}` : ampToSection(next[0]));
  };
  const insertCode = (code: string) => {
    const el = lineRefs[target]?.current;
    const text = lines[target];
    const at = el?.selectionStart ?? text.length;
    setLine(target, `${text.slice(0, at)}&${code}${text.slice(at)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + 2, at + 2);
    });
  };

  const onIcon = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.uploadIcon(server.id, await toServerIcon(file));
      setHasIcon(true);
      setIconVersion(Date.now());
      toast('ok', 'Ikona nahrána', running ? 'Hráči ji uvidí po restartu serveru.' : undefined);
    } catch (err) {
      toast('error', 'Ikonu se nepodařilo nahrát', (err as Error).message);
    }
  };

  const save = async (restart: boolean) => {
    setBusy(true);
    try {
      const r = await api.saveProperties(server.id, edits);
      setValues(r.values);
      setEdits({});
      if (restart) {
        await api.action(server.id, 'restart');
        toast('ok', 'Uloženo, server se restartuje');
      } else {
        toast('ok', 'Uloženo', running ? 'Změny se projeví po restartu serveru.' : undefined);
      }
    } catch (err) {
      toast('error', 'Uložení selhalo', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const visible = (d: PropertyDef) => !d.managed && (!q || d.label.toLowerCase().includes(q) || d.key.includes(q));
  const unknownKeys = useMemo(
    () => Object.keys(values ?? {}).filter((k) => !PROPERTY_DEFS.some((d) => d.key === k) && (!q || k.includes(q))).sort(),
    [values, q],
  );
  const changed = Object.keys(edits).length;

  if (!values) {
    return (
      <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Spinner /> Načítám nastavení…
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row">
        <section className="col-main card stack" aria-labelledby="h-motd" style={{ gap: 16 }}>
          <h2 id="h-motd" className="h2">
            Jak server vypadá v seznamu
          </h2>

          <div className="mc-entry" aria-label="Náhled v seznamu serverů">
            <div className="icon">
              {hasIcon ? <img src={api.iconUrl(server.id, iconVersion)} width={64} height={64} alt="" onError={() => setHasIcon(false)} /> : '?'}
            </div>
            <div className="lines">
              <span className="line name">{server.name}</span>
              <MotdLine text={lines[0]} />
              <MotdLine text={lines[1]} />
            </div>
          </div>

          <div className="grid-auto" style={{ ['--min' as string]: '260px', gap: 12 }}>
            {([0, 1] as const).map((i) => (
              <label key={i} className="field">
                <span className="label">Řádek {i + 1}</span>
                <input
                  ref={lineRefs[i]}
                  className="input mono"
                  value={lines[i]}
                  maxLength={120}
                  onFocus={() => setTarget(i)}
                  onChange={(e) => setLine(i, e.target.value)}
                />
              </label>
            ))}
          </div>
          <div className="palette">
            <span className="muted" style={{ fontSize: 13, marginRight: 4 }}>
              Vložit do řádku {target + 1}:
            </span>
            {Object.entries(MC_COLORS).map(([code, color]) => (
              <button key={code} type="button" title={`&${code}`} aria-label={`Barva &${code}`} style={{ background: color, color: DARK_CODES.has(code) ? '#fff' : '#000' }} onClick={() => insertCode(code)}>
                {code}
              </button>
            ))}
            <button type="button" title="&l" aria-label="Tučně &l" style={{ background: 'var(--surface-2)' }} onClick={() => insertCode('l')}>
              B
            </button>
            <button type="button" title="&o" aria-label="Kurzíva &o" style={{ background: 'var(--surface-2)', fontStyle: 'italic' }} onClick={() => insertCode('o')}>
              I
            </button>
            <button type="button" title="&r" aria-label="Zrušit formát &r" style={{ background: 'var(--surface-2)' }} onClick={() => insertCode('r')}>
              R
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void onIcon(e.target.files?.[0])} />
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              <Icon name="folder" size={17} />
              Nahrát ikonu (oříznu na 64×64)
            </button>
            {hasIcon && (
              <button
                type="button"
                className="btn ghost"
                onClick={() =>
                  void api
                    .deleteIcon(server.id)
                    .then(() => setHasIcon(false))
                    .catch((err: Error) => toast('error', 'Ikonu se nepodařilo smazat', err.message))
                }
              >
                Odebrat ikonu
              </button>
            )}
          </div>
        </section>

        <AuthCard server={server} onChanged={() => void api.properties(server.id).then((r) => setValues(r.values))} />
      </div>

      <section className="card stack" aria-labelledby="h-props" style={{ gap: 16 }}>
        <div className="section-head">
          <h2 id="h-props" className="h2">
            server.properties
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <label className="searchbox">
              <Icon name="search" size={16} />
              <span className="sr-only">Hledat vlastnost</span>
              <input value={filter} placeholder="Hledat vlastnost…" onChange={(e) => setFilter(e.target.value)} />
            </label>
            <a className="btn sm" style={{ minHeight: 40 }} href={href({ page: 'server', id: server.id, tab: 'soubory', file: 'server.properties' })}>
              Upravit jako soubor
            </a>
          </div>
        </div>

        <div className="grid-auto" style={{ ['--min' as string]: '420px', gap: '8px 32px', alignItems: 'start' }}>
          {PROPERTY_GROUPS.filter((g) => g.id !== 'ostatni').map((g) => {
            const defs = PROPERTY_DEFS.filter((d) => d.group === g.id && visible(d));
            if (defs.length === 0) return null;
            return (
              <div key={g.id} className="stack" style={{ gap: 0 }}>
                <h3 className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', margin: '8px 0 2px' }}>
                  {g.label}
                </h3>
                {defs.map((d) => (
                  <div key={d.key} className="prop-row">
                    <div className="meta">
                      <span style={{ fontWeight: 500 }}>
                        {d.label}
                        {edits[d.key] !== undefined && <span className="changed-dot"> •</span>}
                      </span>
                      <span className="key">{d.key}</span>
                    </div>
                    <div className="control">
                      <PropertyControl def={d} value={value(d.key)} onChange={(v) => set(d.key, v)} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {unknownKeys.length > 0 && (
            <div className="stack" style={{ gap: 0 }}>
              <h3 className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', margin: '8px 0 2px' }}>
                Ostatní
              </h3>
              {unknownKeys.map((k) => (
                <div key={k} className="prop-row">
                  <div className="meta">
                    <span className="key" style={{ color: 'var(--text)', fontSize: 13 }}>
                      {k}
                      {edits[k] !== undefined && <span className="changed-dot"> •</span>}
                    </span>
                  </div>
                  <div className="control">
                    <input className="input mono" aria-label={k} value={value(k)} onChange={(e) => set(k, e.target.value)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {changed > 0 && (
        <div className="savebar" role="region" aria-label="Neuložené změny">
          <span className="grow">
            {changed} {changed === 1 ? 'neuložená změna' : changed < 5 ? 'neuložené změny' : 'neuložených změn'}
            {running ? '. Projeví se po restartu.' : '.'}
          </span>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setEdits({})}>
            Zahodit
          </button>
          <button type="button" className={`btn ${running ? '' : 'primary'}`} disabled={busy} onClick={() => void save(false)}>
            Uložit
          </button>
          {running && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save(true)}>
              Uložit a restartovat
            </button>
          )}
        </div>
      )}
    </div>
  );
}
