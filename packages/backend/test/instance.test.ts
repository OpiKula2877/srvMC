import { describe, expect, it } from 'vitest';
import { isDoneLine, levelOf, parsePlayerEvent } from '../src/instance.ts';

describe('console parsing', () => {
  it('detects the ready line of Paper and vanilla', () => {
    expect(isDoneLine('[14:02:19 INFO]: Done (7.912s)! For help, type "help"')).toBe(true);
    expect(isDoneLine('[14:02:19] [Server thread/INFO]: Done (12,5s)! For help, type "help"')).toBe(true);
    expect(isDoneLine('[14:02:19 INFO]: Preparing level "world"')).toBe(false);
  });

  it('tracks joins and leaves in both formats', () => {
    expect(parsePlayerEvent('[14:05:40 INFO]: Steve_CZ joined the game')).toEqual({ join: 'Steve_CZ' });
    expect(parsePlayerEvent('[14:05:40] [Server thread/INFO]: Alex left the game')).toEqual({ leave: 'Alex' });
    expect(parsePlayerEvent('[14:12:33 INFO]: <Alex> Steve joined the game')).toEqual({});
    expect(parsePlayerEvent('[17:53:13] [Server thread/INFO]: System chat: OpiKula joined the game')).toEqual({ join: 'OpiKula' });
    expect(parsePlayerEvent('[17:38:12] [Server thread/INFO]: System chat: OpiKula left the game')).toEqual({ leave: 'OpiKula' });
    expect(parsePlayerEvent('[12:56:10] [Server thread/INFO] [minecraft/MinecraftServer]: Notch joined the game')).toEqual({ join: 'Notch' });
    expect(isDoneLine('[12:56:01] [Server thread/INFO] [minecraft/DedicatedServer]: Done (21.304s)! For help, type "help"')).toBe(true);
  });

  it('classifies log levels', () => {
    expect(levelOf('[14:10:02 WARN]: Can\'t keep up!')).toBe('warn');
    expect(levelOf('[14:40:12 ERROR]: Could not pass event')).toBe('error');
    expect(levelOf('java.lang.NullPointerException')).toBe('error');
    expect(levelOf('\tat net.minecraft.Server.run(Server.java:10)')).toBe('error');
    expect(levelOf('[14:02:11 INFO]: Loading properties')).toBe('info');
  });
});
