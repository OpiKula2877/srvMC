// srvMC Login: password login for paid and unpaid accounts on every Java server, vanilla too.
// The proxy (proxy.ts) owns the server's public port and catches the login commands; the Minecraft
// server itself moves to an internal port on 127.0.0.1. Players wait in a limbo until they log in.
import { editionOf, t, type ServerConfig } from '@srvmc/shared';
import { fetchOk } from '../http.ts';
import type { ServerInstance } from '../instance.ts';
import type { ServerManager } from '../manager.ts';
import { isPortFree } from '../net.ts';
import { readServerProperties, updateServerProperties } from '../properties.ts';
import { atLeast, entityAnswer, hasLimboPack, limboKind, modeArg, parseNumbers, parseString, tellraw, VOID_DIM, writeLimboPack } from './limbo.ts';
import { LoginProxy, type JoinDecision, type Session } from './proxy.ts';
import { checkPassword, hashPassword, LoginStore, type Place } from './store.ts';

const LOGIN_TIMEOUT = 60_000;
const REMIND_EVERY = 10_000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;
const PW_MIN = 4;
const PW_MAX = 64;

export function loginSupported(cfg: Pick<ServerConfig, 'type'>): boolean {
  return editionOf(cfg.type) === 'java' && cfg.type !== 'velocity';
}

interface Waiting {
  session: Session;
  timers: NodeJS.Timeout[];
  /** Set once the player stood in the limbo, so a quick leave keeps the saved place. */
  inLimbo: boolean;
}

interface Live {
  proxy: LoginProxy;
  backendPort: number;
  waiting: Map<string, Waiting>;
  fails: Map<string, { n: number; until: number }>;
}

export class LoginService {
  private readonly live = new Map<string, Live>();
  private readonly stores = new Map<string, LoginStore>();

  constructor(private readonly manager: ServerManager) {
    for (const inst of manager.all()) this.attach(inst);
    manager.on('added', (inst: ServerInstance) => this.attach(inst));
    manager.addStartGuard((inst) => this.beforeStart(inst));
  }

  instance(id: string): ServerInstance {
    return this.manager.get(id);
  }

  store(inst: ServerInstance): LoginStore {
    let s = this.stores.get(inst.cfg.id);
    if (!s) {
      s = new LoginStore(inst.dir);
      this.stores.set(inst.cfg.id, s);
    }
    return s;
  }

  private enabled(inst: ServerInstance): boolean {
    return !!inst.cfg.srvmcLogin && loginSupported(inst.cfg) && !inst.cfg.behindProxy;
  }

  private attach(inst: ServerInstance): void {
    inst.on('status', () => {
      if (inst.running && this.enabled(inst) && !this.live.has(inst.cfg.id)) void this.openProxy(inst);
    });
    inst.on('exit', () => this.closeProxy(inst));
    inst.on('player', (what: 'join' | 'leave', name: string) => {
      if (what === 'join') void this.onJoinLine(inst, name);
    });
  }

  /** Moves the Minecraft server to an internal port (or back) and writes the limbo pack. */
  private async beforeStart(inst: ServerInstance): Promise<void> {
    if (!loginSupported(inst.cfg) || !inst.cfg.installed) return;
    const { values } = await readServerProperties(inst.dir);
    if (!this.enabled(inst)) {
      // Login was switched off: the server takes its public port again.
      if (inst.cfg.loginBackendPort) {
        await updateServerProperties(inst.dir, { 'server-port': String(inst.cfg.port), 'server-ip': inst.cfg.behindProxy ? '127.0.0.1' : '' });
        await this.manager.saveConfig(inst.cfg.id, (cfg) => {
          cfg.loginBackendPort = undefined;
        });
      }
      return;
    }
    let backend = inst.cfg.loginBackendPort;
    if (!backend || backend === inst.cfg.port || !(await isPortFree(backend, '127.0.0.1'))) backend = await this.freeBackendPort(inst);
    if (values.get('server-port') !== String(backend) || values.get('server-ip') !== '127.0.0.1') {
      await updateServerProperties(inst.dir, { 'server-port': String(backend), 'server-ip': '127.0.0.1' });
    }
    if (backend !== inst.cfg.loginBackendPort) {
      await this.manager.saveConfig(inst.cfg.id, (cfg) => {
        cfg.loginBackendPort = backend;
      });
    }
    if (limboKind(inst.cfg.version) === 'void') await writeLimboPack(inst.dir, inst.cfg.version);
  }

  private async freeBackendPort(inst: ServerInstance): Promise<number> {
    const taken = new Set(this.manager.all().flatMap((i) => [i.cfg.port, i.cfg.loginBackendPort ?? 0, i.cfg.geyserPort ?? 0, i.cfg.bluemapPort ?? 0]));
    for (let p = 35565; p < 36565; p++) if (!taken.has(p) && (await isPortFree(p, '127.0.0.1'))) return p;
    throw new Error(t('No free internal port for srvMC Login.'));
  }

  private async openProxy(inst: ServerInstance): Promise<void> {
    const id = inst.cfg.id;
    const backendPort = inst.cfg.loginBackendPort;
    if (!backendPort) return;
    const live: Live = { proxy: undefined as unknown as LoginProxy, backendPort, waiting: new Map(), fails: new Map() };
    live.proxy = new LoginProxy({
      decide: (name) => this.decide(inst, live, name),
      joined: (s) => this.onSession(inst, live, s),
      chat: (s, text, cmd) => this.onChat(inst, live, s, text, cmd),
      closed: (s) => this.onClosed(live, s),
      warn: (m) => inst.pushLog('warn', m),
    });
    this.live.set(id, live);
    try {
      await live.proxy.listen(inst.cfg.port, backendPort);
      inst.pushLog('system', t('srvMC Login is on: players log in with /register or /login.'));
    } catch (err) {
      this.live.delete(id);
      inst.pushLog('error', t('srvMC Login could not open port {port}: {message}', { port: inst.cfg.port, message: (err as Error).message }));
    }
  }

  private closeProxy(inst: ServerInstance): void {
    const live = this.live.get(inst.cfg.id);
    if (!live) return;
    this.live.delete(inst.cfg.id);
    for (const w of live.waiting.values()) w.timers.forEach(clearTimeout);
    live.proxy.close();
  }

  private async decide(inst: ServerInstance, live: Live, name: string): Promise<JoinDecision> {
    const lock = live.fails.get(name.toLowerCase());
    if (lock && lock.until > Date.now()) return { kind: 'kick', reason: `Too many wrong passwords. Try again in ${Math.ceil((lock.until - Date.now()) / 60_000)} min.` };
    const acc = await this.store(inst).get(name);
    return acc?.autologin ? { kind: 'online' } : { kind: 'pass' };
  }

  private onSession(inst: ServerInstance, live: Live, s: Session): void {
    const key = s.name.toLowerCase();
    if (s.verified) {
      s.loggedIn = true;
      return;
    }
    const w: Waiting = { session: s, timers: [], inLimbo: false };
    live.waiting.set(key, w);
  }

  private onClosed(live: Live, s: Session): void {
    const key = s.name.toLowerCase();
    const w = live.waiting.get(key);
    if (w?.session === s) {
      w.timers.forEach(clearTimeout);
      live.waiting.delete(key);
    }
  }

  private say(inst: ServerInstance, name: string, text: string, color?: string): void {
    inst.sendHidden(tellraw(name, text, color), /^\s*$/);
  }

  /** The server logged the join: into the limbo, or (paid account with autologin) straight in. */
  private async onJoinLine(inst: ServerInstance, name: string): Promise<void> {
    const live = this.live.get(inst.cfg.id);
    const session = live?.proxy.find(name);
    if (!live || !session) {
      // Login is off now (or the player came another way): someone left in the limbo goes back.
      if (!live && loginSupported(inst.cfg) && limboKind(inst.cfg.version) === 'void' && (await hasLimboPack(inst.dir))) await this.rescue(inst, name);
      return;
    }
    if (session.loggedIn) {
      if (session.verified) {
        // Someone who once waited in the limbo and logs in by Mojang now.
        await this.rescue(inst, name);
        this.say(inst, name, 'Logged in with your paid account.', 'green');
      }
      return;
    }
    const w = live.waiting.get(name.toLowerCase());
    if (!w) return;
    await this.enterLimbo(inst, name);
    w.inLimbo = true;
    const acc = await this.store(inst).get(name);
    const hint = acc ? 'Log in with /login <password>' : 'Register with /register <password> <password>';
    this.say(inst, name, `Welcome! ${hint}`);
    const remind = () => {
      if (live.waiting.get(name.toLowerCase()) !== w) return;
      this.say(inst, name, hint, 'yellow');
      w.timers.push(setTimeout(remind, REMIND_EVERY));
    };
    w.timers.push(setTimeout(remind, REMIND_EVERY));
    w.timers.push(
      setTimeout(() => {
        if (live.waiting.get(name.toLowerCase()) === w) inst.sendHidden(`kick ${name} You did not log in in time.`, /Kicked/);
      }, LOGIN_TIMEOUT),
    );
  }

  private async ask(inst: ServerInstance, name: string, path: string): Promise<string | null> {
    const line = await inst.askHidden(`data get entity ${name} ${path}`, entityAnswer(name), 3000);
    return line ? entityAnswer(name).exec(line)![1]! : null;
  }

  /** Where the player stands now (1.13+, where /data exists). */
  private async place(inst: ServerInstance, name: string): Promise<Place | null> {
    if (!atLeast(inst.cfg.version, 1, 13)) return null;
    const pos = await this.ask(inst, name, 'Pos');
    const rot = await this.ask(inst, name, 'Rotation');
    const dim = atLeast(inst.cfg.version, 1, 16) ? await this.ask(inst, name, 'Dimension') : '"minecraft:overworld"';
    const mode = await this.ask(inst, name, 'playerGameType');
    if (!pos || !dim) return null;
    const [x, y, z] = parseNumbers(pos);
    const [yaw, pitch] = rot ? parseNumbers(rot) : [0, 0];
    if (x === undefined || y === undefined || z === undefined) return null;
    return { dim: parseString(dim), x, y, z, yaw: yaw ?? 0, pitch: pitch ?? 0, mode: mode ? (parseNumbers(mode)[0] ?? 0) : 0 };
  }

  private async enterLimbo(inst: ServerInstance, name: string): Promise<void> {
    const v = inst.cfg.version;
    const store = this.store(inst);
    if (limboKind(v) === 'void') {
      const here = await this.place(inst, name);
      // Someone who left while in the limbo keeps the place from before.
      if (here && here.dim !== VOID_DIM) await store.setPlace(name, here);
      inst.sendHidden(`execute in ${VOID_DIM} run tp ${name} 0 50 0 0 0`, /Teleported|teleported/);
      inst.sendHidden(`gamemode ${modeArg(v, 3)} ${name}`, /game mode|gamemode/i);
      return;
    }
    // Before 1.16.2: stay in place, blind and unable to move.
    const effect = atLeast(v, 1, 13) ? (e: string, amp: number) => `effect give ${name} minecraft:${e} 1000000 ${amp} true` : (e: string, amp: number) => `effect ${name} minecraft:${e} 1000000 ${amp} true`;
    for (const [e, amp] of [
      ['blindness', 1],
      ['slowness', 255],
      ['mining_fatigue', 255],
      ['resistance', 255],
      ['weakness', 255],
    ] as const) {
      inst.sendHidden(effect(e, amp), /effect|Applied|Given/i);
    }
  }

  private async leaveLimbo(inst: ServerInstance, name: string): Promise<void> {
    const v = inst.cfg.version;
    if (limboKind(v) === 'void') return this.rescue(inst, name, true);
    inst.sendHidden(atLeast(v, 1, 13) ? `effect clear ${name}` : `effect ${name} clear`, /effect|Removed/i);
  }

  /** Back to the saved place; without one (or when the player is not in the limbo) nothing happens unless `force`. */
  private async rescue(inst: ServerInstance, name: string, force = false): Promise<void> {
    const v = inst.cfg.version;
    if (!force) {
      const dim = await this.ask(inst, name, 'Dimension');
      if (!dim || parseString(dim) !== VOID_DIM) return;
    }
    const p = await this.store(inst).getPlace(name);
    if (p && p.dim !== VOID_DIM) {
      inst.sendHidden(`execute in ${p.dim} run tp ${name} ${p.x} ${p.y} ${p.z} ${p.yaw} ${p.pitch}`, /Teleported|teleported/);
      inst.sendHidden(`gamemode ${modeArg(v, p.mode)} ${name}`, /game mode|gamemode/i);
    } else {
      // No saved place: the console stands at the world spawn.
      inst.sendHidden(`execute in minecraft:overworld run tp ${name} ~ ~ ~`, /Teleported|teleported/);
      inst.sendHidden(`gamemode ${modeArg(v, 0)} ${name}`, /game mode|gamemode/i);
    }
  }

  private finishLogin(inst: ServerInstance, live: Live, s: Session, text: string): void {
    const key = s.name.toLowerCase();
    const w = live.waiting.get(key);
    w?.timers.forEach(clearTimeout);
    live.waiting.delete(key);
    live.fails.delete(key);
    s.loggedIn = true;
    void this.leaveLimbo(inst, s.name);
    this.say(inst, s.name, text, 'green');
    void this.store(inst).update(s.name, (a) => {
      a.lastLogin = Date.now();
    });
  }

  /** Every chat line and command of a player behind the proxy. True: srvMC took it. */
  private onChat(inst: ServerInstance, live: Live, s: Session, text: string, isCommand: boolean): boolean {
    const [word = '', ...args] = text.trim().split(/\s+/);
    const cmd = isCommand ? word.toLowerCase() : '';
    const handled = ['register', 'reg', 'login', 'l', 'log', 'changepassword', 'changepw', 'autologin'].includes(cmd);
    if (handled) {
      void this.command(inst, live, s, cmd, args).catch((err: Error) => this.say(inst, s.name, `Something went wrong: ${err.message}`, 'red'));
      return true;
    }
    if (!s.loggedIn) {
      void this.store(inst)
        .get(s.name)
        .then((acc) => this.say(inst, s.name, acc ? 'Log in first: /login <password>' : 'Register first: /register <password> <password>', 'red'));
      return true;
    }
    return false;
  }

  private async command(inst: ServerInstance, live: Live, s: Session, cmd: string, args: string[]): Promise<void> {
    const store = this.store(inst);
    const name = s.name;
    const acc = await store.get(name);
    const say = (t: string, c?: string) => this.say(inst, name, t, c);
    switch (cmd) {
      case 'register':
      case 'reg': {
        if (s.loggedIn) return say('You are logged in already.');
        if (acc) return say('This name is registered already. Log in with /login <password>', 'red');
        const [pw, again] = args;
        if (!pw || !again) return say('Use /register <password> <password>', 'red');
        if (pw !== again) return say('The two passwords are not the same.', 'red');
        if (pw.length < PW_MIN || pw.length > PW_MAX) return say(`The password needs ${PW_MIN} to ${PW_MAX} characters.`, 'red');
        await store.create(name, pw);
        inst.pushLog('system', t('srvMC Login: {name} registered.', { name }));
        return this.finishLogin(inst, live, s, 'Registered and logged in. Paid account? /autologin on skips the password next time.');
      }
      case 'login':
      case 'l':
      case 'log': {
        if (s.loggedIn) return say('You are logged in already.');
        if (!acc) return say('Register first: /register <password> <password>', 'red');
        const [pw] = args;
        if (!pw) return say('Use /login <password>', 'red');
        if (!(await checkPassword(pw, acc.password))) {
          const key = name.toLowerCase();
          const f = live.fails.get(key) ?? { n: 0, until: 0 };
          f.n++;
          live.fails.set(key, f);
          if (f.n >= MAX_FAILS) {
            f.until = Date.now() + LOCK_MS;
            f.n = 0;
            inst.pushLog('warn', t('srvMC Login: {name} typed a wrong password {n} times and is locked out for 5 minutes.', { name, n: MAX_FAILS }));
            inst.sendHidden(`kick ${name} Too many wrong passwords. Try again in 5 minutes.`, /Kicked/);
            return;
          }
          return say(`Wrong password (${MAX_FAILS - f.n} tries left).`, 'red');
        }
        return this.finishLogin(inst, live, s, 'Logged in. Have fun!');
      }
      case 'changepassword':
      case 'changepw': {
        if (!s.loggedIn || !acc) return say('Log in first.', 'red');
        const [old, next] = args;
        if (!old || !next) return say('Use /changepassword <old password> <new password>', 'red');
        if (!(await checkPassword(old, acc.password))) return say('The old password is wrong.', 'red');
        if (next.length < PW_MIN || next.length > PW_MAX) return say(`The password needs ${PW_MIN} to ${PW_MAX} characters.`, 'red');
        const hash = await hashPassword(next);
        await store.update(name, (a) => {
          a.password = hash;
        });
        return say('Password changed.', 'green');
      }
      case 'autologin': {
        if (!s.loggedIn || !acc) return say('Log in first.', 'red');
        const on = args[0]?.toLowerCase();
        if (on !== 'on' && on !== 'off') return say(`Use /autologin <on|off> (now ${acc.autologin ? 'on' : 'off'})`, 'red');
        if (on === 'on') {
          if (!(await paidName(name))) return say('No paid Minecraft account has this name, so autologin cannot check it.', 'red');
          await store.update(name, (a) => {
            a.autologin = true;
          });
          return say('Autologin is on. From the next join Mojang checks your account and no password is needed. Only the paid account can join with this name now.', 'green');
        }
        await store.update(name, (a) => {
          a.autologin = false;
        });
        return say('Autologin is off. You log in with your password again.', 'green');
      }
    }
  }

  /** For the panel: accounts with their state. */
  async accounts(inst: ServerInstance): Promise<{ name: string; createdAt: number; lastLogin?: number; autologin: boolean; online: boolean }[]> {
    const live = this.live.get(inst.cfg.id);
    return (await this.store(inst).list()).map((a) => ({
      name: a.name,
      createdAt: a.createdAt,
      lastLogin: a.lastLogin,
      autologin: !!a.autologin,
      online: !!live?.proxy.find(a.name)?.loggedIn,
    }));
  }
}

/** Is there a paid Minecraft account with this name? */
async function paidName(name: string): Promise<boolean> {
  try {
    await fetchOk(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
