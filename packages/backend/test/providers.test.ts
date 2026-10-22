import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgeLaunchArgs, parseRunScript, platformArgs } from '../src/installer.ts';
import { parseArclightReleases } from '../src/providers/arclight.ts';
import { neoForgeGameVersion } from '../src/providers/forge.ts';
import { spigotJava } from '../src/providers/spigot.ts';
import { compareVersions } from '../src/providers/types.ts';

describe('version helpers', () => {
  it('sorts dotted versions numerically', () => {
    const list = ['1.21.9', '1.21.10', '26.1', '1.8.9', '26.1.2', '1.21'];
    expect([...list].sort(compareVersions)).toEqual(['1.8.9', '1.21', '1.21.9', '1.21.10', '26.1', '26.1.2']);
  });

  it('maps NeoForge versions to the game version', () => {
    expect(neoForgeGameVersion('21.1.172')).toBe('1.21.1');
    expect(neoForgeGameVersion('21.0.167')).toBe('1.21');
    expect(neoForgeGameVersion('20.4.237')).toBe('1.20.4');
    expect(neoForgeGameVersion('20.2.3-beta')).toBe('1.20.2');
    expect(neoForgeGameVersion('26.3.0.95')).toBe('26.3');
    expect(neoForgeGameVersion('26.1.2.11')).toBe('26.1.2');
    expect(neoForgeGameVersion('47.1.0')).toBe(null);
  });

  it('keeps the Spigot Java version inside what BuildTools accepts', () => {
    expect(spigotJava(25, [65, 69])).toBe(25);
    expect(spigotJava(17, [65, 69])).toBe(21);
    expect(spigotJava(8, undefined)).toBe(8);
  });
});

describe('Forge launch', () => {
  it('reads the launch arguments from run.bat and run.sh', () => {
    expect(parseRunScript('@echo off\nREM Forge\njava @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt %*\npause\n')).toEqual([
      '@libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt',
    ]);
    expect(parseRunScript('#!/usr/bin/env sh\njava @user_jvm_args.txt -jar forge-1.20.4-49.0.3-shim.jar "$@"\n')).toEqual(['-jar', 'forge-1.20.4-49.0.3-shim.jar']);
    expect(parseRunScript('java -Xmx4G -Xms4G @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.172/win_args.txt nogui %*')).toEqual([
      '@libraries/net/neoforged/neoforge/21.1.172/win_args.txt',
    ]);
    expect(parseRunScript('echo nothing here')).toBeNull();
    // Forge 26.x: a Java check with the shim first, the real launch after it.
    const forge26 = [
      '@echo off',
      'java -jar forge-26.3-66.0.13-shim.jar --onlyCheckJava',
      'if %ERRORLEVEL% NEQ 0 (',
      '    goto :exit',
      ')',
      'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/26.3-66.0.13/win_args.txt %*',
      ':exit',
      'pause',
    ].join('\r\n');
    expect(parseRunScript(forge26)).toEqual(['@libraries/net/minecraftforge/forge/26.3-66.0.13/win_args.txt']);
    expect(parseRunScript('java -jar forge-26.3-66.0.13-shim.jar --onlyCheckJava || exit 1\njava @user_jvm_args.txt @libraries/net/minecraftforge/forge/26.3-66.0.13/unix_args.txt "$@"')).toEqual([
      '@libraries/net/minecraftforge/forge/26.3-66.0.13/unix_args.txt',
    ]);
  });

  it('switches the args file to the current OS', () => {
    expect(platformArgs(['@libraries/x/win_args.txt'], 'linux')).toEqual(['@libraries/x/unix_args.txt']);
    expect(platformArgs(['@libraries/x/unix_args.txt'], 'win32')).toEqual(['@libraries/x/win_args.txt']);
    expect(platformArgs(['-jar', 'server.jar'], 'linux')).toEqual(['-jar', 'server.jar']);
  });

  describe('detection after install', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'srvmc-forge-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('uses the run script when there is one', async () => {
      await writeFile(path.join(dir, 'run.bat'), 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt %*\r\n');
      await writeFile(path.join(dir, 'run.sh'), 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt "$@"\n');
      const args = await forgeLaunchArgs(dir, 'forge');
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/^@libraries\/net\/minecraftforge\/forge\/1\.20\.1-47\.3\.0\/(win|unix)_args\.txt$/);
    });

    it('falls back to the Forge jar on old versions', async () => {
      await mkdir(path.join(dir, 'libraries'));
      await writeFile(path.join(dir, 'forge-1.12.2-14.23.5.2860-installer.jar'), '');
      await writeFile(path.join(dir, 'forge-1.12.2-14.23.5.2860.jar'), '');
      await writeFile(path.join(dir, 'minecraft_server.1.12.2.jar'), '');
      expect(await forgeLaunchArgs(dir, 'forge')).toEqual(['-jar', 'forge-1.12.2-14.23.5.2860.jar']);
    });

    it('fails clearly when nothing is launchable', async () => {
      await expect(forgeLaunchArgs(dir, 'neoforge')).rejects.toThrow(/nothing found/);
    });
  });
});

describe('Arclight releases', () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}`, size: 1, digest: 'sha256:abc' });
  it('parses assets into loader, game version and Arclight version, newest first', () => {
    const builds = parseArclightReleases([
      { tag_name: 'FeudalKings/1.0.1', prerelease: false, draft: false, published_at: '2025-07-16T00:00:00Z', assets: [asset('arclight-fabric-1.21.1-1.0.1-8ec9529.jar'), asset('arclight-neoforge-1.21.1-1.0.1-8ec9529.jar')] },
      { tag_name: 'Group/1.0.0-SNAPSHOT', prerelease: true, draft: false, published_at: '2026-09-22T00:00:00Z', assets: [asset('arclight-neoforge-1.21.11-1.0.0-SNAPSHOT-8a57510.jar'), asset('README.md')] },
      { tag_name: 'draft', prerelease: false, draft: true, published_at: '2026-10-01T00:00:00Z', assets: [asset('arclight-forge-1.21.1-9.9.9.jar')] },
    ]);
    expect(builds.map((b) => [b.loader, b.mc, b.version, b.prerelease])).toEqual([
      ['neoforge', '1.21.11', '1.0.0-SNAPSHOT-8a57510', true],
      ['neoforge', '1.21.1', '1.0.1-8ec9529', false],
      ['fabric', '1.21.1', '1.0.1-8ec9529', false],
    ]);
  });
});
