import { describe, expect, it } from 'vitest';
import { escapeValue, parseProperties, updateProperties } from '../src/properties.ts';

describe('server.properties', () => {
  const sample = '#Minecraft server properties\n#Tue Oct 21 2026\nserver-port=25565\nmotd=A Minecraft Server\nwhite-list=false\n';

  it('parses keys and ignores comments', () => {
    const p = parseProperties(sample);
    expect(p.get('server-port')).toBe('25565');
    expect(p.get('motd')).toBe('A Minecraft Server');
    expect(p.size).toBe(3);
  });

  it('updates in place, keeps comments and appends new keys', () => {
    const out = updateProperties(sample, { 'server-port': '25570', 'query.port': '25570' });
    expect(out).toBe('#Minecraft server properties\n#Tue Oct 21 2026\nserver-port=25570\nmotd=A Minecraft Server\nwhite-list=false\nquery.port=25570\n');
  });

  it('round-trips non-ASCII text through \\u escapes', () => {
    const out = updateProperties('', { motd: 'Survival s kamarády §a😀' });
    expect(out).toContain('\\u00e1');
    expect(out).toContain('\\u00a7');
    expect(parseProperties(out).get('motd')).toBe('Survival s kamarády §a😀');
  });

  it('handles empty values and colon separators', () => {
    const p = parseProperties('level-seed=\nrcon.password: secret\n');
    expect(p.get('level-seed')).toBe('');
    expect(p.get('rcon.password')).toBe('secret');
  });

  it('escapes backslashes and newlines', () => {
    expect(escapeValue('a\\b\nc')).toBe('a\\\\b\\nc');
  });
});
