// Panel accounts: users with roles, scrypt password hashes, cookie sessions. Without any account the
// panel works as before (this computer only); the first account (an owner) turns sign-in on.
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { PanelRole, PanelUser } from '@srvmc/shared';
import { UserError } from './providers/types.ts';
import { t } from '@srvmc/shared';

const ROLES: PanelRole[] = ['owner', 'admin', 'moderator', 'starter'];
const NAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;
const SESSION_DAYS = 30;
// scrypt cost: ~50 ms per check on a desktop CPU, 32 MB memory.
const N = 2 ** 15;

interface StoredUser extends PanelUser {
  hash: string;
}

interface Session {
  userId: string;
  expires: number;
}

interface Data {
  users: StoredUser[];
  sessions: Record<string, Session>;
  lan?: boolean;
}

function derive(password: string, salt: Buffer, n = N): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !n || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await derive(password, Buffer.from(salt, 'base64'), Number(n));
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha = (token: string) => createHash('sha256').update(token).digest('hex');

export function checkPassword(password: string): void {
  if (password.length < 8 || password.length > 200) throw new UserError(t('The password must have at least 8 characters.'));
}

const strip = (u: StoredUser): PanelUser => ({ id: u.id, name: u.name, role: u.role, servers: u.servers, createdAt: u.createdAt });

export class UserStore {
  private data: Data = { users: [], sessions: {} };
  private writing: Promise<void> = Promise.resolve();
  // A fake hash for unknown names, so a wrong name takes as long as a wrong password.
  private dummy = '';

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as Data;
      this.data.users ??= [];
      this.data.sessions ??= {};
    } catch {
      this.data = { users: [], sessions: {} };
    }
    this.dummy = await hashPassword(randomBytes(12).toString('hex'));
    const now = Date.now();
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.expires < now) delete this.data.sessions[k];
  }

  private save(): Promise<void> {
    const body = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await writeFile(`${this.file}.tmp`, body, { encoding: 'utf8', mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.writing;
  }

  get hasUsers(): boolean {
    return this.data.users.length > 0;
  }

  get lan(): boolean {
    return !!this.data.lan && this.hasUsers;
  }

  async setLan(enabled: boolean): Promise<void> {
    if (enabled && !this.hasUsers) throw new UserError(t('Network access can only be turned on with accounts – otherwise anyone on the network could control the panel.'));
    this.data.lan = enabled;
    await this.save();
  }

  list(): PanelUser[] {
    return this.data.users.map(strip);
  }

  get(id: string): PanelUser | null {
    const u = this.data.users.find((x) => x.id === id);
    return u ? strip(u) : null;
  }

  private validate(input: { name?: string; role?: PanelRole; servers?: 'all' | string[] }, exceptId?: string): void {
    if (input.name !== undefined) {
      if (!NAME_RE.test(input.name)) throw new UserError(t('Name: 2–32 characters, letters, digits, dot, dash, underscore.'));
      if (this.data.users.some((u) => u.id !== exceptId && u.name.toLowerCase() === input.name!.toLowerCase())) throw new UserError(t('Another account already has this name.'));
    }
    if (input.role !== undefined && !ROLES.includes(input.role)) throw new UserError(t('Unknown role.'));
    if (input.servers !== undefined && input.servers !== 'all' && !(Array.isArray(input.servers) && input.servers.every((s) => typeof s === 'string' && s.length < 64))) {
      throw new UserError(t('Invalid server list.'));
    }
  }

  async create(input: { name: string; password: string; role: PanelRole; servers?: 'all' | string[] }): Promise<PanelUser> {
    const name = input.name.trim();
    // The very first account is always an owner, so somebody can manage accounts.
    const role = this.hasUsers ? input.role : 'owner';
    this.validate({ name, role, servers: input.servers });
    checkPassword(input.password);
    const user: StoredUser = {
      id: randomUUID(),
      name,
      role,
      servers: role === 'owner' || role === 'admin' ? 'all' : (input.servers ?? []),
      createdAt: Date.now(),
      hash: await hashPassword(input.password),
    };
    this.data.users.push(user);
    await this.save();
    return strip(user);
  }

  private owners(): StoredUser[] {
    return this.data.users.filter((u) => u.role === 'owner');
  }

  async update(id: string, patch: { name?: string; role?: PanelRole; servers?: 'all' | string[]; password?: string }): Promise<PanelUser> {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) throw new UserError(t('The account does not exist.'));
    this.validate(patch, id);
    if (patch.role && patch.role !== 'owner' && u.role === 'owner' && this.owners().length === 1) throw new UserError(t('The last owner must stay an owner.'));
    if (patch.name !== undefined) u.name = patch.name.trim();
    if (patch.role !== undefined) u.role = patch.role;
    if (patch.servers !== undefined) u.servers = patch.servers;
    if (u.role === 'owner' || u.role === 'admin') u.servers = 'all';
    if (patch.password !== undefined) {
      checkPassword(patch.password);
      u.hash = await hashPassword(patch.password);
      this.revokeUser(id);
    }
    await this.save();
    return strip(u);
  }

  async remove(id: string): Promise<void> {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) throw new UserError(t('The account does not exist.'));
    if (u.role === 'owner' && this.owners().length === 1) throw new UserError(t('The last owner cannot be deleted.'));
    this.data.users = this.data.users.filter((x) => x.id !== id);
    this.revokeUser(id);
    await this.save();
  }

  /** The user for a name and password, or null. Takes the same time for unknown names. */
  async verify(name: string, password: string): Promise<PanelUser | null> {
    const u = this.data.users.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    const ok = await verifyPassword(password, u?.hash ?? this.dummy);
    return u && ok ? strip(u) : null;
  }

  async startSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    this.data.sessions[sha(token)] = { userId, expires: Date.now() + SESSION_DAYS * 86_400_000 };
    await this.save();
    return token;
  }

  session(token: string | undefined): PanelUser | null {
    if (!token) return null;
    const s = this.data.sessions[sha(token)];
    if (!s || s.expires < Date.now()) return null;
    return this.get(s.userId);
  }

  async endSession(token: string | undefined): Promise<void> {
    if (!token) return;
    delete this.data.sessions[sha(token)];
    await this.save();
  }

  private revokeUser(userId: string): void {
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.userId === userId) delete this.data.sessions[k];
  }

  /** Drops a deleted server from every account that listed it. */
  async forgetServer(id: string): Promise<void> {
    let changed = false;
    for (const u of this.data.users) {
      if (Array.isArray(u.servers) && u.servers.includes(id)) {
        u.servers = u.servers.filter((s) => s !== id);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  static readonly sessionMaxAge = SESSION_DAYS * 86_400;
}
