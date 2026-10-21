import { describe, expect, it } from 'vitest';
import { guessJavaMajor, normalizeJavaMajor } from '../src/mojang.ts';
import { isPaperRelease, paperChannel, pickPaperBuild } from '../src/providers/paper.ts';

describe('Java version for a Minecraft version', () => {
  it.each([
    ['26.3', 25],
    ['26.4-snapshot-5', 25],
    ['1.21.11', 21],
    ['1.20.5', 21],
    ['1.20.4', 17],
    ['1.18.2', 17],
    ['1.17.1', 16],
    ['1.16.5', 8],
    ['1.8.9', 8],
  ])('%s needs Java %i', (version, java) => {
    expect(guessJavaMajor(version)).toBe(java);
  });

  it('maps Java 16 to 17, which Temurin ships as a JRE', () => {
    expect(normalizeJavaMajor(16)).toBe(17);
    expect(normalizeJavaMajor(21)).toBe(21);
  });
});

describe('Paper builds', () => {
  const dl = { 'server:default': { name: 'paper.jar', checksums: { sha256: 'x' }, size: 1, url: 'u' } };
  const builds = [
    { id: 207, channel: 'STABLE' as const, downloads: dl },
    { id: 209, channel: 'BETA' as const, downloads: dl },
    { id: 208, channel: 'STABLE' as const, downloads: dl },
  ];

  it('picks the newest stable build by default', () => {
    expect(pickPaperBuild(builds)?.id).toBe(208);
  });

  it('picks the requested build', () => {
    expect(pickPaperBuild(builds, '209')?.id).toBe(209);
    expect(pickPaperBuild(builds, '1')).toBeUndefined();
  });

  it('falls back to the newest build when none is stable', () => {
    expect(pickPaperBuild([{ id: 3, channel: 'ALPHA', downloads: dl }, { id: 4, channel: 'BETA', downloads: dl }])?.id).toBe(4);
  });

  it('classifies versions and channels', () => {
    expect(isPaperRelease('1.21.11')).toBe(true);
    expect(isPaperRelease('1.21.11-rc3')).toBe(false);
    expect(paperChannel('RECOMMENDED')).toBe('stable');
    expect(paperChannel('ALPHA')).toBe('experimental');
  });
});
