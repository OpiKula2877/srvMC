// Routes for signing in, panel accounts and access from the home network.
import os from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthInfo, PanelRole, PanelUser } from '@srvmc/shared';
import { UserError } from '../providers/types.ts';
import { UserStore } from '../users.ts';
import { t } from '@srvmc/shared';

export const SESSION_COOKIE = 'srvmc_session';

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** IPv4 addresses of this computer's network cards (for "open the panel on your phone"). */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const ROLES = ['owner', 'admin', 'moderator', 'starter'];
const userBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 32 },
    password: { type: 'string', maxLength: 200 },
    role: { type: 'string', enum: ROLES },
    servers: { anyOf: [{ type: 'string', enum: ['all'] }, { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 64 } }] },
  },
} as const;

/** Failed sign-ins per address; ten in 15 minutes and the address waits. */
const failures = new Map<string, { count: number; since: number }>();

function tooMany(ip: string): boolean {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 15 * 60_000) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 10;
}

function fail(ip: string): void {
  const f = failures.get(ip) ?? { count: 0, since: Date.now() };
  f.count++;
  failures.set(ip, f);
}

export function registerUserRoutes(app: FastifyInstance, users: UserStore, port: () => number, principalOf: (req: FastifyRequest) => PanelUser | null): void {
  const me = (req: FastifyRequest): AuthInfo => {
    const user = principalOf(req);
    const owner = user?.role === 'owner';
    return {
      user,
      authRequired: users.hasUsers,
      local: user?.id === 'local',
      lan: { enabled: users.lan, addresses: owner ? lanAddresses().map((a) => `http://${a}:${port()}`) : [] },
    };
  };

  const setCookie = (reply: FastifyReply, token: string, maxAge: number) =>
    reply.header('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);

  app.get('/api/auth/me', (req) => me(req));

  app.post<{ Body: { name: string; password: string } }>(
    '/api/auth/login',
    { schema: { body: { type: 'object', required: ['name', 'password'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 } } } } },
    async (req, reply) => {
      const ip = req.socket.remoteAddress ?? '?';
      if (tooMany(ip)) return reply.code(429).send({ error: t('Too many wrong attempts. Try again in 15 minutes.') });
      const user = await users.verify(req.body.name, req.body.password);
      if (!user) {
        fail(ip);
        return reply.code(401).send({ error: t('Wrong name or password.') });
      }
      failures.delete(ip);
      setCookie(reply, await users.startSession(user.id), UserStore.sessionMaxAge);
      return { ...me(req), user, local: false };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    await users.endSession(readCookie(req, SESSION_COOKIE));
    setCookie(reply, '', 0);
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>(
    '/api/auth/password',
    { schema: { body: { type: 'object', required: ['current', 'next'], additionalProperties: false, properties: { current: { type: 'string', maxLength: 200 }, next: { type: 'string', maxLength: 200 } } } } },
    async (req, reply) => {
      const user = principalOf(req);
      if (!user || user.id === 'local') throw new UserError(t('The password changes for a signed-in account.'));
      if (!(await users.verify(user.name, req.body.current))) return reply.code(401).send({ error: t('The current password is wrong.') });
      await users.update(user.id, { password: req.body.next });
      // A password change signs out everywhere; this browser gets a fresh session.
      setCookie(reply, await users.startSession(user.id), UserStore.sessionMaxAge);
      return { ok: true };
    },
  );

  app.get('/api/users', () => users.list());
  app.post<{ Body: { name: string; password: string; role: PanelRole; servers?: 'all' | string[] } }>(
    '/api/users',
    { schema: { body: { ...userBody, required: ['name', 'password', 'role'] } } },
    (req) => users.create(req.body),
  );
  app.patch<{ Params: { id: string }; Body: { name?: string; password?: string; role?: PanelRole; servers?: 'all' | string[] } }>('/api/users/:id', { schema: { body: userBody } }, (req) =>
    users.update(req.params.id, req.body),
  );
  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    if (principalOf(req)?.id === req.params.id) throw new UserError(t('You cannot delete your own account here.'));
    await users.remove(req.params.id);
    reply.code(204);
  });

  app.put<{ Body: { enabled: boolean } }>(
    '/api/panel/lan',
    { schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } } },
    async (req) => {
      await users.setLan(req.body.enabled);
      return { ...me(req), restartNeeded: true };
    },
  );
}
