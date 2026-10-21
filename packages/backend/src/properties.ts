// Reading and writing Java .properties files (server.properties) without losing comments or order.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function unescape(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
    if (esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc === 'n') return '\n';
    if (esc === 't') return '\t';
    if (esc === 'r') return '\r';
    return esc;
  });
}

export function escapeValue(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code > 0x7e || code < 0x20) {
      // Minecraft writes non-ASCII as \uXXXX; surrogate pairs become two escapes.
      for (const unit of ch.split('')) out += `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return out;
}

function splitLine(line: string): [string, string] | null {
  const trimmed = line.trimStart();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;
  const m = /^((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(trimmed) ?? /^((?:\\.|[^=:\s\\])+)$/.exec(trimmed);
  if (!m) return null;
  return [unescape(m[1]!), unescape(m[2] ?? '')];
}

export function parseProperties(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const kv = splitLine(line);
    if (kv) map.set(kv[0], kv[1]);
  }
  return map;
}

/** Replaces values of existing keys in place and appends new keys at the end. */
export function updateProperties(text: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const out = lines.map((line) => {
    const kv = splitLine(line);
    if (!kv || !pending.has(kv[0])) return line;
    const value = pending.get(kv[0])!;
    pending.delete(kv[0]);
    return `${kv[0]}=${escapeValue(value)}`;
  });
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of pending) out.push(`${key}=${escapeValue(value)}`);
  return `${out.join('\n')}\n`;
}

export async function readServerProperties(dir: string): Promise<{ values: Map<string, string>; exists: boolean }> {
  try {
    return { values: parseProperties(await readFile(path.join(dir, 'server.properties'), 'utf8')), exists: true };
  } catch {
    return { values: new Map(), exists: false };
  }
}

export async function updateServerProperties(dir: string, updates: Record<string, string>): Promise<void> {
  const file = path.join(dir, 'server.properties');
  const current = await readFile(file, 'utf8').catch(() => '');
  const tmp = `${file}.srvmc-tmp`;
  await writeFile(tmp, updateProperties(current, updates), 'utf8');
  await rename(tmp, file);
}
