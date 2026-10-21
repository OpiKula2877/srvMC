// After a crash: read the crash report and the last console lines, name the cause in plain words
// and point at the mods or plugins involved.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CrashInfo, LogLine } from '@srvmc/shared';

interface Known {
  re: RegExp;
  summary: (ctx: { port: number }) => string;
  /** Restarting would hit the same wall again. */
  permanent?: boolean;
}

// First match wins, so the most specific causes come first.
const KNOWN: Known[] = [
  { re: /OutOfMemoryError/, summary: () => 'Serveru došla paměť. Přidej mu RAM v Nastavení.' },
  { re: /FAILED TO BIND TO PORT|Address already in use|BindException/i, summary: ({ port }) => `Port ${port} používá jiný program.`, permanent: true },
  {
    re: /UnsupportedClassVersionError|Unsupported class file major version|compiled by a more recent version of the Java Runtime/,
    summary: () => 'Některý mod nebo plugin potřebuje novější Javu, než tahle verze Minecraftu používá.',
    permanent: true,
  },
  {
    re: /Incompatible mods? found|Mod resolution failed|Missing or unsupported mandatory dependencies|requires (any )?version .* of /i,
    summary: () => 'Mody spolu nesedí nebo některý chybí. V konzoli je, co který potřebuje.',
    permanent: true,
  },
  { re: /Mixin apply (for mod \S+ )?failed|MixinApplyError|InvalidInjectionException|MixinTransformerError/, summary: () => 'Některý mod se nepodařilo načíst (chyba mixinu).', permanent: true },
  { re: /You need to agree to the EULA/, summary: () => 'Chybí souhlas s Minecraft EULA.', permanent: true },
  { re: /Failed to (load|read) level\.dat|Exception reading .*level\.dat/i, summary: () => 'Svět se nepodařilo načíst. Zkus obnovit zálohu.', permanent: true },
  { re: /The server has stopped responding|A single server tick took [\d.,]+ seconds/i, summary: () => 'Server zamrzl a jeho hlídač ho ukončil.' },
];

// Names that show up in stack traces and reports but are the platform, not a suspect.
const PLATFORM = new Set(['minecraft', 'forge', 'neoforge', 'fml', 'fabricloader', 'fabric-loader', 'quilt_loader', 'java', 'mixinextras', 'paper', 'spigot', 'purpur', 'bukkit', 'server', 'mojang']);

function addSuspect(out: string[], raw: string): void {
  const name = raw.trim().replace(/\.jar$/i, '');
  if (!name || name.length > 64 || PLATFORM.has(name.toLowerCase())) return;
  if (/^(paper|purpur|spigot|craftbukkit|server|minecraft_server|forge|neoforge|fabric-server-launch|arclight)[-.\d]/i.test(name)) return;
  if (!out.some((s) => s.toLowerCase() === name.toLowerCase())) out.push(name);
}

/** Mods and plugins a crash report or log points at, most direct evidence first. */
export function findSuspects(text: string): string[] {
  const out: string[] = [];
  // Forge / NeoForge: "Suspected Mods: Create (create), Version: 6.0.0"
  for (const block of text.matchAll(/Suspected Mods?:([^\n]*(?:\n[ \t]+[^\n]+)*)/g)) {
    for (const m of block[1]!.matchAll(/([^\n\t,]+?) \(([\w-]+)\), Version/g)) addSuspect(out, m[1]!);
  }
  for (const m of text.matchAll(/Mixin apply for mod ([\w-]+) failed/gi)) addSuspect(out, m[1]!);
  for (const m of text.matchAll(/ from mod ([\w-]+)/g)) addSuspect(out, m[1]!);
  // Fabric: "- Mod 'Sodium' (sodium) 0.6.0 requires …"
  for (const m of text.matchAll(/- Mod '([^']+)' \([\w-]+\)/g)) addSuspect(out, m[1]!);
  // Bukkit plugins
  for (const m of text.matchAll(/Could not load '?plugins[\\/]([^'\s]+?\.jar)/g)) addSuspect(out, m[1]!);
  for (const m of text.matchAll(/Error occurred while (?:enabling|disabling) (\S+)/g)) addSuspect(out, m[1]!);
  // Stack frames: Paper "~[LuckPerms-5.4.jar:?]", Forge "TRANSFORMER/create@6.0.0/"
  for (const m of text.matchAll(/~\[([^\]:/\\]+\.jar):/g)) addSuspect(out, m[1]!);
  for (const m of text.matchAll(/TRANSFORMER\/([\w-]+)@/g)) addSuspect(out, m[1]!);
  return out.slice(0, 5);
}

const ERROR_LINE = /^\s*(?:Caused by: )?([\w$.]+(?:Exception|Error))(?::\s*(.*))?$/m;

/** The newest crash report written since `since` (ms), if any. */
async function newestReport(dir: string, since: number): Promise<string | null> {
  const folder = path.join(dir, 'crash-reports');
  let best: { name: string; t: number } | null = null;
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith('.txt')) continue;
    const s = await stat(path.join(folder, name)).catch(() => null);
    if (s && s.mtimeMs >= since - 5000 && (!best || s.mtimeMs > best.t)) best = { name, t: s.mtimeMs };
  }
  return best?.name ?? null;
}

/** Error lines plus the unprefixed lines right after them (stack traces, Fabric's mod lists). */
export function errorText(lines: LogLine[]): string {
  const out: string[] = [];
  let inError = false;
  for (const l of lines) {
    inError = l.level === 'error' || (inError && !/^\[/.test(l.text));
    if (inError) out.push(l.text);
  }
  return out.join('\n');
}

/** Exit codes come as unsigned 32-bit numbers on Windows (4294967295 = -1, a forced kill). */
export function exitText(code: number | string | null): string {
  const n = Number(code);
  if (code === null || code === 'SIGKILL' || n === -1 || n === 4294967295) return 'Proces Javy byl násilně ukončen (zvenku, nebo došla paměť počítače).';
  return `Server skončil s kódem ${n > 2 ** 31 ? n - 2 ** 32 : code}.`;
}

export function describeCrash(text: string, ctx: { port: number }): { summary: string; permanent: boolean } | null {
  for (const k of KNOWN) if (k.re.test(text)) return { summary: k.summary(ctx), permanent: !!k.permanent };
  return null;
}

export async function analyzeCrash(input: { dir: string; since: number; log: LogLine[]; port: number; code: number | string | null }): Promise<CrashInfo> {
  const report = await newestReport(input.dir, input.since);
  const reportText = report ? (await readFile(path.join(input.dir, 'crash-reports', report), 'utf8').catch(() => '')).slice(0, 256 * 1024) : '';
  const lines = input.log.filter((l) => l.t >= input.since && l.level !== 'cmd' && l.level !== 'system').slice(-150);
  const tail = lines.map((l) => l.text).join('\n');
  const known = describeCrash(`${reportText}\n${tail}`, { port: input.port });

  let summary = known?.summary;
  if (!summary) {
    const description = /^Description: (.+)$/m.exec(reportText)?.[1]?.trim();
    const error = ERROR_LINE.exec(reportText) ?? ERROR_LINE.exec(errorText(lines));
    const exception = error ? `${error[1]!.split('.').pop()}${error[2] ? `: ${error[2]}` : ''}` : undefined;
    summary = [description, exception].filter(Boolean).join(' · ') || exitText(input.code);
  }
  return {
    at: Date.now(),
    summary: summary.length > 240 ? `${summary.slice(0, 237)}…` : summary,
    // Startup warnings name mods all the time; only errors (and the lines that continue them) count.
    suspects: findSuspects(`${reportText}\n${errorText(lines)}`),
    report: report ?? undefined,
    permanent: known?.permanent || undefined,
  };
}
