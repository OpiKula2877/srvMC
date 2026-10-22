// Accounts of srvMC Login, one file per server (.srvmc-login.json): password hashes (scrypt), the
// autologin switch for paid accounts, and where each player stood before the login limbo.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const FILE = '.srvmc-login.json';

export interface Place {
  dim: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Game mode number (0 survival … 3 spectator). */
  mode: number;
}

export interface Account {
  name: string;
  /** "salt:hash", both hex. */
  password: string;
  createdAt: number;
  lastLogin?: number;
  /** Paid account: Mojang checks the player on join and no password is asked. */
  autologin?: boolean;
}

interface Data {
  accounts: Record<string, Account>;
  /** Where each player stood before the limbo, registered or not. */
  places?: Record<string, Place>;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = await scrypt(pw, Buffer.from(salt, 'hex'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

export class LoginStore {
  private data: Promise<Data> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private load(): Promise<Data> {
    this.data ??= readFile(path.join(this.dir, FILE), 'utf8')
      .then((t) => JSON.parse(t) as Data)
      .then((d) => (d && typeof d.accounts === 'object' ? d : { accounts: {} }))
      .catch(() => ({ accounts: {} }));
    return this.data;
  }

  private async save(): Promise<void> {
    const d = await this.load();
    const file = path.join(this.dir, FILE);
    this.saving = this.saving.then(async () => {
      await writeFile(`${file}.tmp`, JSON.stringify(d, null, 1), { encoding: 'utf8', mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return this.saving;
  }

  async get(name: string): Promise<Account | undefined> {
    return (await this.load()).accounts[name.toLowerCase()];
  }

  async list(): Promise<Account[]> {
    return Object.values((await this.load()).accounts).sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name: string, pw: string): Promise<Account> {
    const d = await this.load();
    const acc: Account = { name, password: await hashPassword(pw), createdAt: Date.now() };
    d.accounts[name.toLowerCase()] = acc;
    await this.save();
    return acc;
  }

  async update(name: string, change: (a: Account) => void | Promise<void>): Promise<void> {
    const acc = await this.get(name);
    if (!acc) return;
    await change(acc);
    await this.save();
  }

  async getPlace(name: string): Promise<Place | undefined> {
    return (await this.load()).places?.[name.toLowerCase()];
  }

  async setPlace(name: string, place: Place): Promise<void> {
    const d = await this.load();
    (d.places ??= {})[name.toLowerCase()] = place;
    await this.save();
  }

  async remove(name: string): Promise<void> {
    const d = await this.load();
    delete d.accounts[name.toLowerCase()];
    await this.save();
  }
}
