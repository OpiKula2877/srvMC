import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { editionOf, type PlayerEntry, type PlayerListKind, type PlayersInfo, type ServerInfo } from '@srvmc/shared';
import { api } from '../../api.ts';
import { MenuButton, Toggle } from '../../components/Controls.tsx';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { nameColor } from '../../format.ts';
import { href } from '../../router.ts';
import { t } from '@srvmc/shared';

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
  whitelist: { label: t('Whitelist'), title: t('Whitelist'), hint: t('When on, only players on this list can join.'), placeholder: t('Player name, e.g. Steve'), button: t('Add'), remove: t('Remove') },
  ops: { label: t('Operators'), title: t('Operators'), hint: t('They can use commands. Level 4 = full rights.'), placeholder: t('Player name'), button: t('Make operator'), remove: t('Remove OP') },
  bans: { label: t('Banned players'), title: t('Banned players'), hint: t('These players cannot join.'), placeholder: t('Player name'), button: t('Ban'), danger: true, remove: t('Unban'), withReason: true },
  ips: { label: t('Banned IPs'), title: t('Banned IP addresses'), hint: t('Blocks every account from this address.'), placeholder: t('IP address, e.g. 203.0.113.7'), button: t('Ban IP'), danger: true, remove: t('Unban'), withReason: true },
};

// Bedrock: an allow list and operators; no bans, no permission levels, gamertags with spaces.
const BEDROCK_LISTS: Partial<Record<PlayerListKind, ListMeta>> = {
  whitelist: { label: t('Allow list'), title: t('Allow list'), hint: '', placeholder: t('Xbox gamertag, e.g. Big Steve'), button: t('Add'), remove: t('Remove') },
  ops: { label: t('Operators'), title: t('Operators'), hint: '', placeholder: t('Xbox gamertag'), button: t('Make operator'), remove: t('Remove OP') },
};

const LEVELS = [
  { value: '4', label: t('4 – full rights') },
  { value: '3', label: t('3 – manage players') },
  { value: '2', label: t('2 – game commands') },
  { value: '1', label: t('1 – only bypass spawn protection') },
];

function sub(kind: PlayerListKind, p: PlayerEntry, bedrock: boolean): string {
  if (bedrock) return p.uuid ? `XUID ${p.uuid}` : '';
  if (kind === 'ops') return t('level {n}', { n: p.level ?? 4 });
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
  const edition = editionOf(server.type);
  const bedrock = edition === 'bedrock';
  const lists = (bedrock ? BEDROCK_LISTS : LISTS) as Record<PlayerListKind, ListMeta>;
  const meta = lists[kind] ?? LISTS[kind];

  const load = useCallback(() => api.players(server.id).then(setInfo).catch((err: Error) => toast('error', t('Could not load the players'), err.message)), [server.id, toast]);

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
    const ok = await run(t('Could not add'), () =>
      api.addPlayer(server.id, kind, { name: name.trim(), reason: meta.withReason ? reason || undefined : undefined, level: kind === 'ops' && !bedrock ? Number(level) : undefined }),
    );
    if (ok) {
      toast('ok', t('{name} added', { name: name.trim() }), meta.label);
      setName('');
      setReason('');
    }
  };

  const playerAction = (player: string, action: 'op' | 'kick' | 'ban' | 'whitelist') => {
    if (action === 'kick') return void run(t('Kicking failed'), () => api.kick(server.id, player));
    const list: PlayerListKind = action === 'op' ? 'ops' : action === 'ban' ? 'bans' : 'whitelist';
    void run(t('The action failed'), () => api.addPlayer(server.id, list, { name: player })).then((ok) => ok && toast('ok', t('{name}: done', { name: player }), lists[list].label));
  };

  const rows = info?.[kind] ?? [];

  if (edition === 'hytale') {
    return (
      <div className="empty">
        <span style={{ fontWeight: 600 }}>{t('Manage players of a Hytale server in the console for now')}</span>
        <span className="muted">{t('The online player list and commands (whitelist, op, kick) are in the help: help')}</span>
      </div>
    );
  }

  return (
    <div className="row">
      <section className="col-main" aria-label={t('Player lists')}>
        <div className="seg" role="tablist" aria-label={t('List')}>
          {(Object.keys(lists) as PlayerListKind[]).map((k) => (
            <button key={k} type="button" role="tab" className="seg-btn" aria-selected={k === kind} onClick={() => setKind(k)}>
              {lists[k].label}
              <span className="count">{info ? info[k].length : '–'}</span>
            </button>
          ))}
        </div>

        <div className="card stack" style={{ gap: 16 }}>
          <div className="section-head">
            <h2 className="h2">{meta.title}</h2>
            {kind === 'whitelist' && info && (
              <div style={{ minWidth: 240 }}>
                <Toggle
                  label={bedrock ? t('Allow list on') : t('Whitelist on')}
                  checked={info.whitelistEnabled}
                  disabled={busy || !server.installed}
                  onChange={(v) => void run(t('Switching failed'), () => api.setWhitelist(server.id, v))}
                />
              </div>
            )}
          </div>

          <form onSubmit={add} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '2 1 220px' }}>
              <span className="sr-only">{kind === 'ips' ? t('IP address') : t('Player name')}</span>
              <input className="input" value={name} placeholder={meta.placeholder} maxLength={kind === 'ips' ? 45 : bedrock ? 21 : 16} onChange={(e) => setName(e.target.value)} />
            </label>
            {meta.withReason && (
              <label className="field" style={{ flex: '2 1 200px' }}>
                <span className="sr-only">{t('Reason')}</span>
                <input className="input" value={reason} placeholder={t('Reason (optional)')} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </label>
            )}
            {kind === 'ops' && !running && !bedrock && (
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
                  <th scope="col">{kind === 'ips' ? t('IP address') : t('Player')}</th>
                  <th scope="col">{bedrock ? 'XUID' : kind === 'ops' ? t('Level') : kind === 'whitelist' ? 'UUID' : t('Reason')}</th>
                  <th scope="col">{kind === 'bans' || kind === 'ips' ? 'Od' : ''}</th>
                  <th scope="col" className="num">
                    {t('Actions')}
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
                      {sub(kind, p, bedrock)}
                    </td>
                    <td className="muted small">{kind === 'bans' || kind === 'ips' ? (p.created?.slice(0, 16) ?? '') : ''}</td>
                    <td className="num">
                      <button type="button" className="btn sm" disabled={busy} onClick={() => void run(t('Removing failed'), () => api.removePlayer(server.id, kind, p.name))}>
                        {meta.remove}
                      </button>
                    </td>
                  </tr>
                ))}
                {info && rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted" style={{ padding: '18px 10px' }}>
                      {t('The list is empty.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <aside className="col-side" aria-label={t('Players online')}>
        <div className="card stack" style={{ gap: 12 }}>
          <h2 className="h2" style={{ fontSize: 16 }}>
            {t('Online now ({n})', { n: server.players.length })}
          </h2>
          {server.players.length === 0 && <span className="muted small">{running ? t('Nobody is playing.') : t('The server is not running.')}</span>}
          {server.players.map((p) => (
            <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="head" style={{ background: nameColor(p), width: 34, height: 34 }} aria-hidden="true">
                {p.charAt(0).toUpperCase()}
              </span>
              <span style={{ flex: 1, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p}</span>
              <MenuButton
                label={t('Actions for {name}', { name: p })}
                items={[
                  { label: t('Make operator'), hint: 'op', onClick: () => playerAction(p, 'op') },
                  { label: bedrock ? t('Add to the allow list') : t('Add to the whitelist'), hint: bedrock ? 'allowlist' : 'whitelist', onClick: () => playerAction(p, 'whitelist') },
                  { label: t('Kick'), hint: 'kick', color: 'var(--amber-text)', onClick: () => playerAction(p, 'kick') },
                  ...(bedrock ? [] : [{ label: t('Ban'), hint: 'ban', color: 'var(--red-text)', onClick: () => playerAction(p, 'ban') }]),
                ]}
              />
            </div>
          ))}
        </div>
        {info && !info.onlineMode && (
          <div className="banner error">
            {bedrock ? t('Account checks are off – anyone can join under someone else\'s name. Use the allow list.') : t('Account checks are off – anyone can join under someone else\'s name. Use the whitelist.')}{' '}
            <a href={href({ page: 'server', id: server.id, tab: 'moznosti' })}>{t('Change it in Options')}</a>
          </div>
        )}
      </aside>
    </div>
  );
}
