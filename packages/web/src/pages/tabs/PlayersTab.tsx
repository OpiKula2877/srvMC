import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PlayerEntry, PlayerListKind, PlayersInfo, ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { MenuButton, Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { nameColor } from '../../format.ts';
import { href } from '../../router.ts';

interface ListMeta {
  label: string;
  title: string;
  hint: string;
  placeholder: string;
  button: string;
  danger?: boolean;
  remove: string;
  withReason?: boolean;
}

const LISTS: Record<PlayerListKind, ListMeta> = {
  whitelist: { label: 'Bílá listina', title: 'Bílá listina', hint: 'Když je zapnutá, připojí se jen hráči z tohoto seznamu.', placeholder: 'Jméno hráče, např. Steve_CZ', button: 'Přidat', remove: 'Odebrat' },
  ops: { label: 'Operátoři', title: 'Operátoři', hint: 'Mohou používat příkazy. Úroveň 4 = všechna práva.', placeholder: 'Jméno hráče', button: 'Udělat operátorem', remove: 'Odebrat OP' },
  bans: { label: 'Zablokovaní hráči', title: 'Zablokovaní hráči', hint: 'Tito hráči se nepřipojí.', placeholder: 'Jméno hráče', button: 'Zablokovat', danger: true, remove: 'Odblokovat', withReason: true },
  ips: { label: 'Zablokované IP', title: 'Zablokované IP adresy', hint: 'Blokuje všechny účty z této adresy.', placeholder: 'IP adresa, např. 203.0.113.7', button: 'Zablokovat IP', danger: true, remove: 'Odblokovat', withReason: true },
};

const LEVELS = [
  { value: '4', label: '4 – všechna práva', hint: 'včetně stop a správy operátorů' },
  { value: '3', label: '3 – správa hráčů', hint: 'kick, ban, op' },
  { value: '2', label: '2 – příkazy hry', hint: 'gamemode, tp, give' },
  { value: '1', label: '1 – jen obejít ochranu spawnu' },
];

function sub(kind: PlayerListKind, p: PlayerEntry): string {
  if (kind === 'ops') return `úroveň ${p.level ?? 4}`;
  if (kind === 'bans' || kind === 'ips') return p.reason ?? '';
  return p.uuid ? p.uuid.slice(0, 13) + '…' : '';
}

export function PlayersTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [info, setInfo] = useState<PlayersInfo | null>(null);
  const [kind, setKind] = useState<PlayerListKind>('whitelist');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [level, setLevel] = useState('4');
  const [busy, setBusy] = useState(false);
  const running = server.status === 'running';
  const meta = LISTS[kind];

  const load = useCallback(() => api.players(server.id).then(setInfo).catch((err: Error) => toast('error', 'Hráče se nepodařilo načíst', err.message)), [server.id, toast]);

  // Reload when the server starts or stops and when someone joins or leaves.
  useEffect(() => {
    void load();
  }, [load, server.status, server.players.length]);

  const run = async (label: string, fn: () => Promise<PlayersInfo | void>) => {
    setBusy(true);
    try {
      const next = await fn();
      if (next) setInfo(next);
      else await load();
      return true;
    } catch (err) {
      toast('error', label, (err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await run('Nepodařilo se přidat', () =>
      api.addPlayer(server.id, kind, { name: name.trim(), reason: meta.withReason ? reason || undefined : undefined, level: kind === 'ops' ? Number(level) : undefined }),
    );
    if (ok) {
      toast('ok', `${name.trim()} přidán`, meta.label);
      setName('');
      setReason('');
    }
  };

  const playerAction = (player: string, action: 'op' | 'kick' | 'ban' | 'whitelist') => {
    if (action === 'kick') return void run('Vyhození selhalo', () => api.kick(server.id, player));
    const list: PlayerListKind = action === 'op' ? 'ops' : action === 'ban' ? 'bans' : 'whitelist';
    void run('Akce selhala', () => api.addPlayer(server.id, list, { name: player })).then((ok) => ok && toast('ok', `${player}: hotovo`, LISTS[list].label));
  };

  const rows = info?.[kind] ?? [];

  return (
    <div className="row">
      <section className="col-main" aria-label="Seznamy hráčů">
        <div className="seg" role="tablist" aria-label="Seznam">
          {(Object.keys(LISTS) as PlayerListKind[]).map((k) => (
            <button key={k} type="button" role="tab" className="seg-btn" aria-selected={k === kind} onClick={() => setKind(k)}>
              {LISTS[k].label}
              <span className="count">{info ? info[k].length : '–'}</span>
            </button>
          ))}
        </div>

        <div className="card stack" style={{ gap: 16 }}>
          <div className="section-head">
            <div className="stack" style={{ gap: 4 }}>
              <h2 className="h2">{meta.title}</h2>
              <p className="muted" style={{ fontSize: 13 }}>
                {meta.hint}
              </p>
            </div>
            {kind === 'whitelist' && info && (
              <div style={{ minWidth: 240 }}>
                <Toggle
                  label="Bílá listina zapnutá"
                  checked={info.whitelistEnabled}
                  disabled={busy || !server.installed}
                  onChange={(v) => void run('Přepnutí selhalo', () => api.setWhitelist(server.id, v))}
                />
              </div>
            )}
          </div>

          <form onSubmit={add} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '2 1 220px' }}>
              <span className="sr-only">{kind === 'ips' ? 'IP adresa' : 'Jméno hráče'}</span>
              <input className="input" value={name} placeholder={meta.placeholder} maxLength={kind === 'ips' ? 45 : 16} onChange={(e) => setName(e.target.value)} />
            </label>
            {meta.withReason && (
              <label className="field" style={{ flex: '2 1 200px' }}>
                <span className="sr-only">Důvod</span>
                <input className="input" value={reason} placeholder="Důvod (nepovinné)" maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </label>
            )}
            {kind === 'ops' && !running && (
              <div style={{ flex: '1 1 220px' }}>
                <Dropdown value={level} options={LEVELS} onChange={setLevel} searchable={false} />
              </div>
            )}
            <button type="submit" className={`btn ${meta.danger ? 'danger' : 'primary'}`} disabled={busy || !name.trim() || !server.installed}>
              {busy ? <Spinner size={16} /> : null}
              {meta.button}
            </button>
          </form>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{kind === 'ips' ? 'IP adresa' : 'Hráč'}</th>
                  <th scope="col">{kind === 'ops' ? 'Úroveň' : kind === 'whitelist' ? 'UUID' : 'Důvod'}</th>
                  <th scope="col">{kind === 'bans' || kind === 'ips' ? 'Od' : ''}</th>
                  <th scope="col" className="num">
                    Akce
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <span className="who">
                        <span className="head" style={{ background: kind === 'ips' ? '#4a525c' : nameColor(p.name) }} aria-hidden="true">
                          {kind === 'ips' ? '#' : p.name.charAt(0).toUpperCase()}
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ fontWeight: 500 }}>{p.name}</span>
                          {server.players.includes(p.name) && <span className="sub" style={{ color: 'var(--green-text)' }}>online</span>}
                        </span>
                      </span>
                    </td>
                    <td className="muted" style={kind === 'whitelist' ? { fontFamily: 'var(--mono)', fontSize: 12 } : undefined}>
                      {sub(kind, p)}
                    </td>
                    <td className="muted small">{kind === 'bans' || kind === 'ips' ? (p.created?.slice(0, 16) ?? '') : ''}</td>
                    <td className="num">
                      <button type="button" className="btn sm" disabled={busy} onClick={() => void run('Odebrání selhalo', () => api.removePlayer(server.id, kind, p.name))}>
                        {meta.remove}
                      </button>
                    </td>
                  </tr>
                ))}
                {info && rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted" style={{ padding: '18px 10px' }}>
                      Seznam je prázdný.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <aside className="col-side" aria-label="Online hráči">
        <div className="card stack" style={{ gap: 12 }}>
          <h2 className="h2" style={{ fontSize: 16 }}>
            Online teď ({server.players.length})
          </h2>
          {server.players.length === 0 && <span className="muted small">{running ? 'Nikdo nehraje.' : 'Server neběží.'}</span>}
          {server.players.map((p) => (
            <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="head" style={{ background: nameColor(p), width: 34, height: 34 }} aria-hidden="true">
                {p.charAt(0).toUpperCase()}
              </span>
              <span style={{ flex: 1, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p}</span>
              <MenuButton
                label={`Akce s hráčem ${p}`}
                items={[
                  { label: 'Udělat operátorem', hint: 'op', onClick: () => playerAction(p, 'op') },
                  { label: 'Přidat na bílou listinu', hint: 'whitelist', onClick: () => playerAction(p, 'whitelist') },
                  { label: 'Vyhodit', hint: 'kick', color: 'var(--amber-text)', onClick: () => playerAction(p, 'kick') },
                  { label: 'Zablokovat', hint: 'ban', color: 'var(--red-text)', onClick: () => playerAction(p, 'ban') },
                ]}
              />
            </div>
          ))}
        </div>
        <div className="banner info">
          Když server běží, panel pošle příkaz do konzole (whitelist add, op, ban). Když neběží, upraví soubory whitelist.json, ops.json a banned-players.json.
        </div>
        {info && !info.onlineMode && (
          <div className="banner error">
            Ověřování účtů je vypnuté – kdokoli se může přihlásit pod cizím jménem. Používej bílou listinu.{' '}
            <a href={href({ page: 'server', id: server.id, tab: 'moznosti' })}>Změnit v Možnostech</a>
          </div>
        )}
      </aside>
    </div>
  );
}
