import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setLang, t } from '@srvmc/shared';
import { CS } from '../../shared/src/i18n.cs.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await sources(abs, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.startsWith('i18n')) out.push(abs);
  }
  return out;
}

describe('translations', () => {
  afterEach(() => setLang('en'));

  it('fills placeholders and falls back to English', () => {
    expect(t('Port {port} is taken by another program.', { port: 25565 })).toBe('Port 25565 is taken by another program.');
    setLang('cs');
    expect(t('Port {port} is taken by another program.', { port: 25565 })).toBe('Port 25565 je obsazený jiným programem.');
    expect(t('A text nobody translated')).toBe('A text nobody translated');
  });

  it('has a Czech text for every English text in the code', async () => {
    const files = [
      ...(await sources(path.join(ROOT, 'packages/web/src'))),
      ...(await sources(path.join(ROOT, 'packages/backend/src'))),
      ...(await sources(path.join(ROOT, 'apps/desktop/src'))),
    ];
    const missing = new Set<string>();
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // t('…') / tr('…') with a plain literal as the first argument.
      for (const m of text.matchAll(/(?<![\w.$])(?:t|tr)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
        const en = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
        if (/[a-z]/i.test(en) && !(en in CS)) missing.add(`${path.relative(ROOT, file)}: ${en}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
