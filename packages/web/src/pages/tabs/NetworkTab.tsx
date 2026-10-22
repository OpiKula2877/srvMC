import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DomainCheck, DomainTarget, NetworkOverview, PortCheck, ServerInfo, ServerNetwork } from '@srvmc/shared';
import { api } from '../../api.ts';
import { Dropdown } from '../../components/Dropdown.tsx';
import { Icon, Spinner } from '../../components/Icon.tsx';
import { useToast } from '../../components/Overlays.tsx';
import { clock } from '../../format.ts';
import { t } from '@srvmc/shared';

const TARGETS: { value: DomainTarget; label: string }[] = [
  { value: 'playit', label: t('playit.gg tunnel') },
  { value: 'ip', label: t('My public IP') },
  { value: 'duckdns', label: t('DuckDNS address') },
];

function CopyAddress({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="address">
      <span>{value}</span>
      <button
        type="button"
        className="btn icon sm"
        aria-label={t('Copy {value}', { value })}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast('ok', t('Copied'), value);
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
      toast('error', t('Could not load the network'), (err as Error).message);
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
      toast('error', t('That did not work'), (err as Error).message);
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
      {server.behindProxy && <div className="banner info">{t("The server is behind a proxy and cannot be joined directly. Give players the proxy's address – set up the tunnel, port and domain there.")}</div>}
      <section aria-label={t('Network status')} className="grid-auto" style={{ ['--min' as string]: '200px', gap: 12 }}>
        <Tile label={t('Home network address')} value={net.lanIp ?? '–'} />
        <Tile label={t('Public IP')} value={net.publicIp ?? '–'} />
        <Tile label={t('Port {port} from the internet', { port: `${port}${hytale ? ' (UDP)' : ''}` })} value={!java ? t('cannot check') : check ? (check.open ? t('open') : t('closed')) : t('not checked')} tone={portTone}>
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy || !net.publicIp || !java} onClick={() => void run('check', () => api.checkPort(server.id), setCheck)}>
            {busy === 'check' ? <Spinner size={14} /> : null}
            {t('Check')}
          </button>
        </Tile>
        <Tile label={t('CGNAT at the provider')} value={net.cgnat === null ? t('unknown') : net.cgnat ? t('yes') : t('no')} tone={net.cgnat ? 'warn' : net.cgnat === false ? 'ok' : undefined} />
      </section>

      <section className="stack" aria-labelledby="h-ways" style={{ gap: 12 }}>
        <div className="section-head">
          <h2 id="h-ways" className="h2">
            {t('How players reach you')}
          </h2>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void run('refresh', () => api.refreshNetwork(), setNet)}>
            {busy === 'refresh' ? <Spinner size={14} /> : <Icon name="restart" size={14} />}
            {t('Check again')}
          </button>
        </div>
        <div className="grid-auto" style={{ ['--min' as string]: '290px', gap: 14 }}>
          <Method title={t('Home only (LAN)')} tag={t('no setup')}>
            {net.lanIp ? <CopyAddress value={withPort(net.lanIp)} /> : <span className="muted">{t('The computer is not on a network now.')}</span>}
            {net.lanIp && srv.geyserPort && (
              <>
                <span className="muted small">{t('Bedrock players (Geyser, UDP):')}</span>
                <CopyAddress value={`${net.lanIp}:${srv.geyserPort}`} />
              </>
            )}
          </Method>

          <Method title={t('Free with playit.gg')} tag={tunnel && !tunnel.pending ? t('active') : net.cgnat ? t('recommended') : t('no router')} active={!!tunnel && !tunnel.pending && playit.status === 'running'}>
            {playit.status === 'off' && (
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('playit', () => api.connectPlayit(), (p) => setNet({ ...net, playit: p }))}>
                {t('Connect a playit.gg account')}
              </button>
            )}
            {playit.status === 'claiming' && playit.claimUrl && (
              <>
                <a className="btn primary" href={playit.claimUrl} target="_blank" rel="noreferrer">
                  {t('Open playit.gg and approve')}
                </a>
                <span className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Spinner size={14} /> {t('Waiting for approval')}
                </span>
              </>
            )}
            {playit.status === 'error' && <div className="banner error">{playit.error}</div>}
            {(playit.status === 'starting' || playit.status === 'running') &&
              (tunnel ? (
                tunnel.pending ? (
                  <span className="muted small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Spinner size={14} /> {t('The tunnel is being set up')}
                  </span>
                ) : (
                  <CopyAddress value={tunnel.address} />
                )
              ) : hytale ? (
                <span className="muted small">{t('For Hytale, create a UDP tunnel to port {port} on playit.gg by hand.', { port })}</span>
              ) : !java ? (
                <span className="muted small">{t('playit.gg does not support the new Bedrock (NetherNet) yet.')}</span>
              ) : (
                <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('tunnel', () => api.createTunnel(server.id), setSrv, t('Tunnel created'))}>
                  {busy === 'tunnel' ? <Spinner size={14} /> : null}
                  {t('Create a tunnel for this server')}
                </button>
              ))}
            {playit.status === 'starting' && !tunnel && <span className="muted small">{t('Starting the playit program…')}</span>}
            {tunnel?.disabled && <div className="banner error">{tunnel.disabled}</div>}
            {playit.status !== 'off' && (
              <button
                type="button"
                className="btn ghost sm"
                style={{ alignSelf: 'flex-start' }}
                disabled={!!busy}
                onClick={() => void run('playit-off', () => api.disconnectPlayit(), (p) => setNet({ ...net, playit: p }))}
              >
                {playit.status === 'claiming' ? t('Cancel') : playit.status === 'error' ? t('Start over') : t('Disconnect playit.gg')}
              </button>
            )}
          </Method>

          <Method title={t('Own IP and an open port')} tag={t('fastest ping')} active={srv.upnp.mapped || !!check?.open}>
            {net.publicIp && <CopyAddress value={withPort(net.publicIp)} />}
            {net.publicIp && srv.geyserPort && <CopyAddress value={`${net.publicIp}:${srv.geyserPort}`} />}
            {net.cgnat && <div className="banner error">{t('The provider shares the public IP with others (CGNAT). An open port will not help here – use playit.gg.')}</div>}
            {srv.upnp.enabled ? (
              <>
                {srv.upnp.mapped ? <div className="banner ok">{t('Port {port} is open on the router (UPnP).', { port })}</div> : <div className="banner error">{srv.upnp.error ?? t('The router did not open the port.')}</div>}
                <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void run('upnp', () => api.setUpnp(server.id, false), setSrv, t('Port closed on the router'))}>
                  {t('Close port')}
                </button>
              </>
            ) : net.upnp ? (
              <button type="button" className="btn" disabled={!!busy} onClick={() => void run('upnp', () => api.setUpnp(server.id, true), setSrv, t('Port opened on the router'))}>
                {busy === 'upnp' ? <Spinner size={14} /> : null}
                {t('Open the port automatically')}
              </button>
            ) : (
              <span className="muted small">{t('The router does not answer UPnP.')}</span>
            )}
            <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} aria-expanded={manual} onClick={() => setManual((v) => !v)}>
              {manual ? t('Hide the manual steps') : t('Open the port by hand')}
            </button>
            {manual && (
              <Steps
                items={[
                  <>
                    {t('Open the router settings, usually')} <span className="mono">http://192.168.1.1</span> {t('or')} <span className="mono">http://192.168.0.1</span>.
                  </>,
                  t('Find "Port forwarding", "Port mapping" or "Virtual server".'),
                  <>
                    {t('Add a rule: {protocol}, port', { protocol: srv.protocol })} <span className="mono">{port}</span>
                    {udp && (
                      <>
                        {' '}
                        {t('and a second one: UDP, ports')} <span className="mono">{udp}</span>
                      </>
                    )}
                    {srv.geyserPort && (
                      <>
                        {' '}
                        {t('and for Bedrock players TCP and UDP')} <span className="mono">{srv.geyserPort}</span>
                      </>
                    )} → <span className="mono">{net.lanIp ?? t('the IP of this computer')}</span>, {t('port')} <span className="mono">{port}</span>.
                  </>,
                  t('Save, then click Check above.'),
                ]}
              />
            )}
          </Method>
        </div>
      </section>

      <section className="card stack" aria-labelledby="h-domain" style={{ gap: 16 }}>
        <div className="section-head">
          <h2 id="h-domain" className="h2">
            {t('Domain')}
          </h2>
          <div className="seg" role="tablist" aria-label={t('Kind of domain')}>
            <button type="button" role="tab" className="seg-btn" aria-selected={mode === 'duckdns'} onClick={() => setMode('duckdns')}>
              {t('Free (DuckDNS)')}
            </button>
            <button type="button" role="tab" className="seg-btn" aria-selected={mode === 'own'} onClick={() => setMode('own')}>
              {t('Own domain')}
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
                  {t('Points to your public IP')}{net.duckdns.lastUpdate ? `, ${t('updated {time}', { time: clock(net.duckdns.lastUpdate) })}` : ''}. {t('The port must be open.')}
                </span>
              )}
              <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void run('duck', () => api.removeDuckDns(), (d) => setNet({ ...net, duckdns: d }))}>
                {t('Remove DuckDNS')}
              </button>
            </div>
          ) : (
            <div className="row">
              <form
                className="col-main stack"
                style={{ gap: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('duck', () => api.setDuckDns(duckName, duckToken), (d) => setNet({ ...net, duckdns: d }), t('DuckDNS set up'));
                }}
              >
                <div className="grid-auto" style={{ ['--min' as string]: '220px', gap: 12 }}>
                  <label className="field">
                    <span className="label">{t('Subdomain')}</span>
                    <span className="unit-input" style={{ width: '100%' }}>
                      <input value={duckName} maxLength={63} placeholder={t('my-server')} style={{ textAlign: 'left' }} onChange={(e) => setDuckName(e.target.value)} />
                      <span>.duckdns.org</span>
                    </span>
                  </label>
                  <label className="field">
                    <span className="label">{t('Token')}</span>
                    <input className="input mono" type="password" autoComplete="off" value={duckToken} maxLength={64} onChange={(e) => setDuckToken(e.target.value)} />
                  </label>
                </div>
                <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!!busy || !duckName.trim() || !duckToken.trim()}>
                  {busy === 'duck' ? <Spinner size={14} /> : null}
                  {t('Save')}
                </button>
              </form>
              <div className="col-side">
                <Steps
                  items={[
                    <>
                      {t('Sign in at')}{' '}
                      <a href="https://www.duckdns.org" target="_blank" rel="noreferrer">
                        duckdns.org
                      </a>
                      .
                    </>,
                    t('Add a subdomain (e.g. my-server).'),
                    t('Copy the token from the top of the page here.'),
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
                void run('domain', () => api.setDomain(server.id, { zone, sub, target }), setSrv, t('Domain saved'));
              }}
            >
              <label className="field">
                <span className="label">{t('Your domain')}</span>
                <input className="input mono" value={zone} maxLength={253} placeholder={t('mydomain.com')} onChange={(e) => setZone(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('Subdomain for the server')}</span>
                <input className="input mono" value={sub} maxLength={63} placeholder="survival" onChange={(e) => setSub(e.target.value)} />
              </label>
              <Dropdown label={t('Points to')} value={target} options={TARGETS} onChange={(v) => setTarget(v as DomainTarget)} searchable={false} />
              <button type="submit" className="btn primary" disabled={!!busy || !zone.trim()}>
                {t('Save')}
              </button>
            </form>

            {srv.domain ? (
              <>
                {srv.records.length === 0 ? (
                  <div className="banner info">{srv.domain.target === 'playit' ? t('Create a playit.gg tunnel for this server first.') : t('Set up DuckDNS first.')}</div>
                ) : (
                  <>
                    <span className="label">{t('Records to add at your registrar')}</span>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>{t('Type')}</th>
                            <th>{t('Name')}</th>
                            <th>{t('Value')}</th>
                            <th aria-label={t('Copy')} />
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
                                  {live && !live.ok && <div style={{ color: 'var(--amber-text)', fontSize: 12 }}>{t('now: {value}', { value: live.found ?? t('not found') })}</div>}
                                </td>
                                <td style={{ width: 48 }}>
                                  <button
                                    type="button"
                                    className="btn icon sm"
                                    aria-label={t('Copy the value of {type} {name}', { type: r.type, name: r.name })}
                                    onClick={() => {
                                      void navigator.clipboard.writeText(r.value);
                                      toast('ok', t('Copied'), r.value);
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
                    <span className="muted small">{java ? t('The SRV record allows an address without a port.') : t('{game} does not read SRV records – players also enter port {port}.', { game: hytale ? 'Hytale' : 'Bedrock', port })}</span>
                  </>
                )}
                {domainCheck && <div className={`banner ${domainCheck.ok ? 'ok' : 'error'}`}>{domainCheck.message}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button type="button" className="btn" disabled={!!busy || srv.records.length === 0} onClick={() => void run('verify', () => api.checkDomain(server.id), setDomainCheck)}>
                    {busy === 'verify' ? <Spinner size={14} /> : null}
                    {t('Check')}
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
                    {t('Remove domain')}
                  </button>
                </div>
              </>
            ) : (
              <Steps
                items={[
                  t('Buy a domain at a registrar (e.g. Namecheap, Porkbun, Cloudflare).'),
                  t('Open the DNS records in its control panel.'),
                  t('Fill in the domain here and save – srvMC shows the records to add there.'),
                  t('Wait 5 to 60 minutes for the change to take effect.'),
                  t('Click Check.'),
                ]}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
