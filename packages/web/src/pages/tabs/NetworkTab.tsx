import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DomainCheck, DomainTarget, NetworkOverview, PortCheck, ServerInfo, ServerNetwork } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { clock } from '../../format.ts';

const TARGETS: { value: DomainTarget; label: string }[] = [
  { value: 'playit', label: 'playit.gg tunel' },
  { value: 'ip', label: 'Moje veřejná IP' },
  { value: 'duckdns', label: 'DuckDNS adresa' },
];

function CopyAddress({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="address">
      <span>{value}</span>
      <button
        type="button"
        className="btn icon sm"
        aria-label={`Kopírovat ${value}`}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast('ok', 'Zkopírováno', value);
        }}
      >
        <Icon name="copy" size={16} />
      </button>
    </div>
  );
}

function Tile({ label, value, tone, children }: { label: string; value: string; tone?: 'ok' | 'warn'; children?: ReactNode }) {
  return (
    <div className="card tight stack" style={{ gap: 6 }}>
      <span className="muted small">{label}</span>
      <span style={{ fontFamily: 'var(--display)', fontSize: 20, fontWeight: 600, color: tone === 'ok' ? 'var(--green-text)' : tone === 'warn' ? 'var(--amber-text)' : 'var(--text)', wordBreak: 'break-all' }}>{value}</span>
      {children}
    </div>
  );
}

function Method({ title, tag, active, children }: { title: string; tag: string; active?: boolean; children: ReactNode }) {
  return (
    <article className="card stack" style={{ gap: 12, background: active ? '#18301f' : undefined, borderColor: active ? '#2f6b42' : undefined }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>{title}</h3>
        <span className="pill" style={active ? { background: 'var(--green-soft)', color: 'var(--green-text)' } : { background: 'var(--raised)', color: 'var(--text-2)' }}>
          {tag}
        </span>
      </div>
      {children}
    </article>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

export function NetworkTab({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const [net, setNet] = useState<NetworkOverview | null>(null);
  const [srv, setSrv] = useState<ServerNetwork | null>(null);
  const [check, setCheck] = useState<PortCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [mode, setMode] = useState<'duckdns' | 'own'>('own');
  const [duckName, setDuckName] = useState('');
  const [duckToken, setDuckToken] = useState('');
  const [zone, setZone] = useState('');
  const [sub, setSub] = useState('');
  const [target, setTarget] = useState<DomainTarget>('playit');
  const [domainCheck, setDomainCheck] = useState<DomainCheck | null>(null);

  const load = useCallback(async () => {
    try {
      const [n, s] = await Promise.all([api.network(), api.serverNetwork(server.id)]);
      setNet(n);
      setSrv(s);
    } catch (err) {
      toast('error', 'Síť se nepodařilo načíst', (err as Error).message);
    }
  }, [server.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fill the domain form once from what is saved.
  useEffect(() => {
    if (!srv?.domain) return;
    setZone((z) => z || srv.domain!.zone);
    setSub((v) => v || srv.domain!.sub);
    setTarget(srv.domain.target);
  }, [srv?.domain]);

  // Linking playit or a fresh tunnel changes on its own; look again often until it settles.
  const waiting = net?.playit.status === 'claiming' || net?.playit.status === 'starting' || !!srv?.playit?.pending;
  useEffect(() => {
    const timer = setInterval(() => void load(), waiting ? 3000 : 60_000);
    return () => clearInterval(timer);
  }, [load, waiting]);

  const run = async <T,>(key: string, fn: () => Promise<T>, done?: (v: T) => void, ok?: string) => {
    setBusy(key);
    try {
      const v = await fn();
      done?.(v);
      if (ok) toast('ok', ok);
    } catch (err) {
      toast('error', 'Nepovedlo se', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!net || !srv) return <Spinner />;

  const port = srv.port;
  const java = srv.edition === 'java';
  const hytale = srv.edition === 'hytale';
  const udp = srv.udpRange ? `${srv.udpRange[0]}–${srv.udpRange[1]}` : null;
  // Java leaves out the default port; Bedrock and Hytale players type it in a field of its own.
  const withPort = (host: string) => (java && port === 25565 ? host : `${host}:${port}`);
  const playit = net.playit;
  const tunnel = srv.playit;
  const portTone = check ? (check.open ? 'ok' : 'warn') : undefined;

  return (
    <div className="stack" style={{ gap: 20 }}>
      {server.behindProxy && <div className="banner info">Server je za proxy a přímo se k němu připojit nejde. Hráčům dej adresu proxy – tunel, port a doménu nastav u ní.</div>}
      <section aria-label="Stav sítě" className="grid-auto" style={{ ['--min' as string]: '200px', gap: 12 }}>
        <Tile label="Adresa v síti doma" value={net.lanIp ?? '–'} />
        <Tile label="Veřejná IP" value={net.publicIp ?? '–'} />
        <Tile label={`Port ${port}${hytale ? ' (UDP)' : ''} z internetu`} value={!java ? 'neověřitelné' : check ? (check.open ? 'otevřený' : 'zavřený') : 'neověřeno'} tone={portTone}>
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy || !net.publicIp || !java} onClick={() => void run('check', () => api.checkPort(server.id), setCheck)}>
            {busy === 'check' ? <Spinner size={14} /> : null}
            Ověřit
          </button>
        </Tile>
        <Tile label="CGNAT u poskytovatele" value={net.cgnat === null ? 'nezjištěno' : net.cgnat ? 'ano' : 'ne'} tone={net.cgnat ? 'warn' : net.cgnat === false ? 'ok' : undefined} />
      </section>

      <section className="stack" aria-labelledby="h-ways" style={{ gap: 12 }}>
        <div className="section-head">
          <h2 id="h-ways" className="h2">
            Jak se k tobě hráči připojí
          </h2>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void run('refresh', () => api.refreshNetwork(), setNet)}>
            {busy === 'refresh' ? <Spinner size={14} /> : <Icon name="restart" size={14} />}
            Zjistit znovu
          </button>
        </div>
        <div className="grid-auto" style={{ ['--min' as string]: '290px', gap: 14 }}>
          <Method title="Jen doma (LAN)" tag="bez nastavení">
            {net.lanIp ? <CopyAddress value={withPort(net.lanIp)} /> : <span className="muted">Počítač teď není v síti.</span>}
            {net.lanIp && srv.geyserPort && (
              <>
                <span className="muted small">Bedrock hráči (Geyser, UDP):</span>
                <CopyAddress value={`${net.lanIp}:${srv.geyserPort}`} />
              </>
            )}
          </Method>

          <Method title="Zdarma přes playit.gg" tag={tunnel && !tunnel.pending ? 'aktivní' : net.cgnat ? 'doporučeno' : 'bez routeru'} active={!!tunnel && !tunnel.pending && playit.status === 'running'}>
            {playit.status === 'off' && (
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('playit', () => api.connectPlayit(), (p) => setNet({ ...net, playit: p }))}>
                Propojit účet playit.gg
              </button>
            )}
            {playit.status === 'claiming' && playit.claimUrl && (
              <>
                <a className="btn primary" href={playit.claimUrl} target="_blank" rel="noreferrer">
                  Otevřít playit.gg a schválit
                </a>
                <span className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Spinner size={14} /> Čekám na schválení
                </span>
              </>
            )}
            {playit.status === 'error' && <div className="banner error">{playit.error}</div>}
            {(playit.status === 'starting' || playit.status === 'running') &&
              (tunnel ? (
                tunnel.pending ? (
                  <span className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Spinner size={14} /> Tunel se připravuje
                  </span>
                ) : (
                  <CopyAddress value={tunnel.address} />
                )
              ) : hytale ? (
                <span className="muted small">Pro Hytale vytvoř na playit.gg tunel UDP na port {port} ručně.</span>
              ) : !java ? (
                <span className="muted small">playit.gg zatím nový Bedrock (NetherNet) neumí.</span>
              ) : (
                <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('tunnel', () => api.createTunnel(server.id), setSrv, 'Tunel vytvořen')}>
                  {busy === 'tunnel' ? <Spinner size={14} /> : null}
                  Vytvořit tunel pro tento server
                </button>
              ))}
            {playit.status === 'starting' && !tunnel && <span className="muted small">Spouštím program playit…</span>}
            {tunnel?.disabled && <div className="banner error">{tunnel.disabled}</div>}
            {playit.status !== 'off' && (
              <button
                type="button"
                className="btn ghost sm"
                style={{ alignSelf: 'flex-start' }}
                disabled={!!busy}
                onClick={() => void run('playit-off', () => api.disconnectPlayit(), (p) => setNet({ ...net, playit: p }))}
              >
                {playit.status === 'claiming' ? 'Zrušit' : playit.status === 'error' ? 'Začít znovu' : 'Odpojit playit.gg'}
              </button>
            )}
          </Method>

          <Method title="Vlastní IP a otevřený port" tag="nejrychlejší ping" active={srv.upnp.mapped || !!check?.open}>
            {net.publicIp && <CopyAddress value={withPort(net.publicIp)} />}
            {net.publicIp && srv.geyserPort && <CopyAddress value={`${net.publicIp}:${srv.geyserPort}`} />}
            {net.cgnat && <div className="banner error">Poskytovatel sdílí veřejnou IP s dalšími (CGNAT). Otevřený port tady nepomůže – použij playit.gg.</div>}
            {srv.upnp.enabled ? (
              <>
                {srv.upnp.mapped ? <div className="banner ok">Port {port} je na routeru otevřený (UPnP).</div> : <div className="banner error">{srv.upnp.error ?? 'Router port neotevřel.'}</div>}
                <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void run('upnp', () => api.setUpnp(server.id, false), setSrv, 'Port na routeru zavřen')}>
                  Zavřít port
                </button>
              </>
            ) : net.upnp ? (
              <button type="button" className="btn" disabled={!!busy} onClick={() => void run('upnp', () => api.setUpnp(server.id, true), setSrv, 'Port na routeru otevřen')}>
                {busy === 'upnp' ? <Spinner size={14} /> : null}
                Otevřít port automaticky
              </button>
            ) : (
              <span className="muted small">Router neodpovídá na UPnP.</span>
            )}
            <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} aria-expanded={manual} onClick={() => setManual((v) => !v)}>
              {manual ? 'Skrýt ruční postup' : 'Otevřít port ručně'}
            </button>
            {manual && (
              <Steps
                items={[
                  <>
                    Otevři správu routeru, obvykle <span className="mono">http://192.168.1.1</span> nebo <span className="mono">http://192.168.0.1</span>.
                  </>,
                  'Najdi „Přesměrování portů“, „Port forwarding“ nebo „Virtuální server“.',
                  <>
                    Přidej pravidlo: {srv.protocol}, port <span className="mono">{port}</span>
                    {udp && (
                      <>
                        {' '}
                        a druhé: UDP, porty <span className="mono">{udp}</span>
                      </>
                    )}
                    {srv.geyserPort && (
                      <>
                        {' '}
                        a pro Bedrock hráče TCP i UDP <span className="mono">{srv.geyserPort}</span>
                      </>
                    )} → <span className="mono">{net.lanIp ?? 'IP tohoto počítače'}</span>, port <span className="mono">{port}</span>.
                  </>,
                  'Ulož a klikni nahoře na Ověřit.',
                ]}
              />
            )}
          </Method>
        </div>
      </section>

      <section className="card stack" aria-labelledby="h-domain" style={{ gap: 16 }}>
        <div className="section-head">
          <h2 id="h-domain" className="h2">
            Doména
          </h2>
          <div className="seg" role="tablist" aria-label="Druh domény">
            <button type="button" role="tab" className="seg-btn" aria-selected={mode === 'duckdns'} onClick={() => setMode('duckdns')}>
              Zdarma (DuckDNS)
            </button>
            <button type="button" role="tab" className="seg-btn" aria-selected={mode === 'own'} onClick={() => setMode('own')}>
              Vlastní doména
            </button>
          </div>
        </div>

        {mode === 'duckdns' ? (
          net.duckdns.configured ? (
            <div className="stack" style={{ gap: 10, maxWidth: 520 }}>
              <CopyAddress value={withPort(`${net.duckdns.domain}.duckdns.org`)} />
              {net.duckdns.error ? (
                <div className="banner error">{net.duckdns.error}</div>
              ) : (
                <span className="muted small">
                  Vede na tvoji veřejnou IP{net.duckdns.lastUpdate ? `, aktualizováno ${clock(net.duckdns.lastUpdate)}` : ''}. Port musí být otevřený.
                </span>
              )}
              <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void run('duck', () => api.removeDuckDns(), (d) => setNet({ ...net, duckdns: d }))}>
                Odebrat DuckDNS
              </button>
            </div>
          ) : (
            <div className="row">
              <form
                className="col-main stack"
                style={{ gap: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('duck', () => api.setDuckDns(duckName, duckToken), (d) => setNet({ ...net, duckdns: d }), 'DuckDNS nastaveno');
                }}
              >
                <div className="grid-auto" style={{ ['--min' as string]: '220px', gap: 12 }}>
                  <label className="field">
                    <span className="label">Subdoména</span>
                    <span className="unit-input" style={{ width: '100%' }}>
                      <input value={duckName} maxLength={63} placeholder="muj-server" style={{ textAlign: 'left' }} onChange={(e) => setDuckName(e.target.value)} />
                      <span>.duckdns.org</span>
                    </span>
                  </label>
                  <label className="field">
                    <span className="label">Token</span>
                    <input className="input mono" type="password" autoComplete="off" value={duckToken} maxLength={64} onChange={(e) => setDuckToken(e.target.value)} />
                  </label>
                </div>
                <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!!busy || !duckName.trim() || !duckToken.trim()}>
                  {busy === 'duck' ? <Spinner size={14} /> : null}
                  Uložit
                </button>
              </form>
              <div className="col-side">
                <Steps
                  items={[
                    <>
                      Přihlas se na{' '}
                      <a href="https://www.duckdns.org" target="_blank" rel="noreferrer">
                        duckdns.org
                      </a>
                      .
                    </>,
                    'Přidej subdoménu (např. muj-server).',
                    'Zkopíruj token z horní části stránky sem.',
                  ]}
                />
              </div>
            </div>
          )
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <form
              className="grid-auto"
              style={{ ['--min' as string]: '200px', gap: 12, alignItems: 'end' }}
              onSubmit={(e) => {
                e.preventDefault();
                setDomainCheck(null);
                void run('domain', () => api.setDomain(server.id, { zone, sub, target }), setSrv, 'Doména uložena');
              }}
            >
              <label className="field">
                <span className="label">Tvoje doména</span>
                <input className="input mono" value={zone} maxLength={253} placeholder="mojedomena.cz" onChange={(e) => setZone(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Subdoména pro server</span>
                <input className="input mono" value={sub} maxLength={63} placeholder="survival" onChange={(e) => setSub(e.target.value)} />
              </label>
              <Dropdown label="Kam vede" value={target} options={TARGETS} onChange={(v) => setTarget(v as DomainTarget)} searchable={false} />
              <button type="submit" className="btn primary" disabled={!!busy || !zone.trim()}>
                Uložit
              </button>
            </form>

            {srv.domain ? (
              <>
                {srv.records.length === 0 ? (
                  <div className="banner info">{srv.domain.target === 'playit' ? 'Nejdřív vytvoř tunel playit.gg pro tento server.' : 'Nejdřív nastav DuckDNS.'}</div>
                ) : (
                  <>
                    <span className="label">Záznamy, které přidáš u svého registrátora</span>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Typ</th>
                            <th>Název</th>
                            <th>Hodnota</th>
                            <th aria-label="Kopírovat" />
                          </tr>
                        </thead>
                        <tbody>
                          {srv.records.map((r) => {
                            const live = domainCheck?.records.find((x) => x.record.name === r.name && x.record.type === r.type);
                            return (
                              <tr key={`${r.type}${r.name}`}>
                                <td className="mono">{r.type}</td>
                                <td className="mono">{r.name}</td>
                                <td className="mono" style={{ wordBreak: 'break-all' }}>
                                  {r.value}
                                  {live && !live.ok && <div style={{ color: 'var(--amber-text)', fontSize: 12 }}>teď: {live.found ?? 'nenalezeno'}</div>}
                                </td>
                                <td style={{ width: 48 }}>
                                  <button
                                    type="button"
                                    className="btn icon sm"
                                    aria-label={`Kopírovat hodnotu ${r.type} ${r.name}`}
                                    onClick={() => {
                                      void navigator.clipboard.writeText(r.value);
                                      toast('ok', 'Zkopírováno', r.value);
                                    }}
                                  >
                                    <Icon name="copy" size={15} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <span className="muted small">{java ? 'SRV záznam umožní adresu bez portu.' : `${hytale ? 'Hytale' : 'Bedrock'} SRV záznamy nečte – hráči zadají i port ${port}.`}</span>
                  </>
                )}
                {domainCheck && <div className={`banner ${domainCheck.ok ? 'ok' : 'error'}`}>{domainCheck.message}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button type="button" className="btn" disabled={!!busy || srv.records.length === 0} onClick={() => void run('verify', () => api.checkDomain(server.id), setDomainCheck)}>
                    {busy === 'verify' ? <Spinner size={14} /> : null}
                    Ověřit
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!!busy}
                    onClick={() =>
                      void run(
                        'domain',
                        () => api.removeDomain(server.id),
                        (s) => {
                          setSrv(s);
                          setDomainCheck(null);
                        },
                      )
                    }
                  >
                    Odebrat doménu
                  </button>
                </div>
              </>
            ) : (
              <Steps
                items={[
                  'Kup doménu u registrátora (např. Wedos, Forpsi, Cloudflare).',
                  'V jeho administraci otevři správu DNS záznamů.',
                  'Tady vyplň doménu a ulož – ukážu záznamy, které tam přidáš.',
                  'Počkej 5 až 60 minut, než se změna projeví.',
                  'Klikni na Ověřit.',
                ]}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
