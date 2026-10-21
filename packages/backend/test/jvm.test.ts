import { describe, expect, it } from 'vitest';
import { buildJvmArgs, splitJvmArgs } from '../src/jvm.ts';

describe('JVM arguments', () => {
  it('sets heap and Aikar flags for a normal server', () => {
    const args = buildJvmArgs({ ramMinMb: 1024, ramMaxMb: 6144, jvmFlags: 'aikar', extraJvmArgs: '' });
    expect(args.slice(0, 2)).toEqual(['-Xms1024M', '-Xmx6144M']);
    expect(args).toContain('-XX:+UseG1GC');
    expect(args).toContain('-XX:G1HeapRegionSize=8M');
    expect(args).not.toContain('-XX:+AlwaysPreTouch');
    expect(args).toContain('-Dfile.encoding=UTF-8');
  });

  it('uses the large-heap variant above 12 GB and pre-touches a fixed heap', () => {
    const args = buildJvmArgs({ ramMinMb: 16384, ramMaxMb: 16384, jvmFlags: 'aikar', extraJvmArgs: '' });
    expect(args).toContain('-XX:G1HeapRegionSize=16M');
    expect(args).toContain('-XX:+AlwaysPreTouch');
  });

  it('never lets the minimum exceed the maximum', () => {
    const args = buildJvmArgs({ ramMinMb: 8192, ramMaxMb: 2048, jvmFlags: 'default', extraJvmArgs: '' });
    expect(args.slice(0, 2)).toEqual(['-Xms2048M', '-Xmx2048M']);
    expect(args).not.toContain('-XX:+UseG1GC');
  });

  it('splits extra arguments with quotes', () => {
    expect(splitJvmArgs('-Duser.timezone=Europe/Prague "-Dname=a b"')).toEqual(['-Duser.timezone=Europe/Prague', '-Dname=a b']);
  });

  it('rejects arguments that are not JVM options or that srvMC controls', () => {
    expect(() => splitJvmArgs('calc.exe')).toThrow();
    expect(() => splitJvmArgs('-jar other.jar')).toThrow();
    expect(() => splitJvmArgs('-Xmx64G')).toThrow();
  });
});
