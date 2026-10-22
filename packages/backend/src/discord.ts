// Discord notifications through a channel webhook: start, stop, crash, joins and leaves.
// The webhook URL works as a password for the channel, so it is stored sealed.
import { DISCORD_EVENTS, type DiscordEvent } from '@srvmc/shared';
import type { ServerInstance } from './instance.ts';
import type { ServerManager } from './manager.ts';
import { UserError } from './providers/types.ts';
import { seal, unseal, type SecretBox } from './secrets.ts';
import { t } from '@srvmc/shared';

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;

const COLORS: Record<DiscordEvent | 'test', number> = {
  start: 0x5bd27a,
  stop: 0x6b747e,
  crash: 0xff6b6b,
  join: 0x6aa9ff,
  leave: 0x9aa3ad,
  sleep: 0xb89bd9,
  test: 0x5bd27a,
};

export function checkWebhook(url: string): string {
  const u = url.trim();
  if (!WEBHOOK_RE.test(u)) throw new UserError(t('Paste the webhook address from Discord (Edit Channel → Integrations → Webhooks → Copy Webhook URL).'));
  return u;
}

/** Discord's embed: title, text, color; mentions are switched off so names cannot ping anyone. */
export function embed(server: string, kind: DiscordEvent | 'test', text: string, at = new Date()) {
  return {
    username: 'srvMC',
    allowed_mentions: { parse: [] },
    embeds: [{ title: server.slice(0, 200), description: text.slice(0, 2000), color: COLORS[kind], timestamp: at.toISOString() }],
  };
}

export class DiscordService {
  private readonly queue = new Map<string, { body: unknown; url: string }[]>();
  private readonly busy = new Set<string>();
  private readonly prev = new Map<string, string>();
  /** Servers the supervisor is putting to sleep: their next stop is reported as sleep. */
  private readonly asleep = new Set<string>();

  constructor(
    private readonly manager: ServerManager,
    private readonly box?: SecretBox,
  ) {
    for (const inst of manager.all()) this.attach(inst);
    manager.on('added', (inst: ServerInstance) => this.attach(inst));
  }

  private attach(inst: ServerInstance): void {
    const id = inst.cfg.id;
    this.prev.set(id, inst.status);
    inst.on('sleep', () => this.asleep.add(id));
    inst.on('status', () => {
      const before = this.prev.get(id);
      const now = inst.status;
      if (before === now) return;
      this.prev.set(id, now);
      if (now === 'running' && before === 'starting') this.notify(inst, 'start', t('The server is running. Players can join on port {port}.', { port: inst.cfg.port }));
      else if (now === 'stopped' && (before === 'stopping' || before === 'running')) {
        const slept = this.asleep.delete(id);
        this.notify(inst, slept ? 'sleep' : 'stop', slept ? `${t('Nobody played, the server fell asleep.')}${inst.cfg.wakeOnJoin ? ` ${t('It wakes up when someone joins.')}` : ''}` : t('The server is stopped.'));
      }
      else if (now === 'crashed') {
        // The crash analysis lands a moment after the status.
        setTimeout(() => this.notify(inst, 'crash', inst.lastCrash ? t('The server crashed: {summary}', { summary: inst.lastCrash.summary }) : t('The server crashed.')), 2500).unref();
      }
    });
    inst.on('player', (what: 'join' | 'leave', name: string) =>
      this.notify(inst, what, what === 'join' ? t('**{name}** joined ({n} online).', { name, n: inst.players.size }) : t('**{name}** left ({n} online).', { name, n: inst.players.size })),
    );
  }

  private webhookOf(inst: ServerInstance): string | null {
    return unseal(this.box, inst.cfg.discord?.webhook);
  }

  private notify(inst: ServerInstance, kind: DiscordEvent, text: string): void {
    const cfg = inst.cfg.discord;
    if (!cfg?.events.includes(kind)) return;
    const url = this.webhookOf(inst);
    if (url) this.enqueue(inst.cfg.id, url, embed(inst.cfg.name, kind, text));
  }

  private enqueue(id: string, url: string, body: unknown): void {
    const q = this.queue.get(id) ?? [];
    // A flood of joins must not pile up forever; Discord allows about 30 messages a minute.
    if (q.length >= 20) q.shift();
    q.push({ url, body });
    this.queue.set(id, q);
    void this.drain(id);
  }

  private async drain(id: string): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      for (let item = this.queue.get(id)?.shift(); item; item = this.queue.get(id)?.shift()) {
        const res = await post(item.url, item.body);
        if (res.status === 429) {
          const wait = Math.min(60_000, (Number(res.headers.get('retry-after')) || 2) * 1000);
          this.queue.get(id)?.unshift(item);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          await new Promise((r) => setTimeout(r, 1100));
        }
      }
    } catch {
      // Discord unreachable: notifications are best effort.
    } finally {
      this.busy.delete(id);
    }
  }

  async configure(id: string, input: { webhook?: string; events: string[] }): Promise<void> {
    const inst = this.manager.get(id);
    const events = [...new Set(input.events)].filter((e): e is DiscordEvent => (DISCORD_EVENTS as readonly string[]).includes(e));
    const current = inst.cfg.discord?.webhook;
    const webhook = input.webhook ? seal(this.box, checkWebhook(input.webhook)) : current;
    if (!webhook) throw new UserError(t('Paste the webhook address from Discord.'));
    await this.manager.saveConfig(id, (cfg) => {
      cfg.discord = { webhook, events };
    });
  }

  async remove(id: string): Promise<void> {
    await this.manager.saveConfig(id, (cfg) => {
      cfg.discord = undefined;
    });
  }

  async test(id: string): Promise<void> {
    const inst = this.manager.get(id);
    const url = this.webhookOf(inst);
    if (!url) throw new UserError(t('Save a webhook first.'));
    const res = await post(url, embed(inst.cfg.name, 'test', t('A test message from srvMC. Notifications work.'))).catch(() => null);
    if (!res) throw new UserError(t('Discord is not answering.'));
    if (res.status === 401 || res.status === 404) throw new UserError(t('Discord does not know the webhook – maybe it was deleted. Create a new one and paste it again.'));
    if (!res.ok) throw new UserError(t('Discord refused the message (HTTP {status}).', { status: res.status }));
  }
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}
