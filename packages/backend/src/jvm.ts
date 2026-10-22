import type { JvmFlagsPreset } from '@srvmc/shared';

// Aikar's G1 flags (https://docs.papermc.io/paper/aikars-flags), tuned for heaps up to 12 GB.
const AIKAR_BASE = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true',
];

const AIKAR_SMALL = ['-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:InitiatingHeapOccupancyPercent=15'];
const AIKAR_LARGE = ['-XX:G1NewSizePercent=40', '-XX:G1MaxNewSizePercent=50', '-XX:G1HeapRegionSize=16M', '-XX:G1ReservePercent=15', '-XX:InitiatingHeapOccupancyPercent=20'];

// Server output goes through a pipe, not a console, so pin the encoding instead of using the Windows code page.
const ENCODING = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];

export interface JvmOptions {
  ramMinMb: number;
  ramMaxMb: number;
  jvmFlags: JvmFlagsPreset;
  extraJvmArgs: string;
  timezone?: string;
  /** Geyser's Bedrock port; Geyser reads these start arguments ahead of its config. */
  geyserPort?: number;
}

/** Splits user JVM arguments on whitespace, keeping quoted parts together. Every argument must be a JVM option. */
export function splitJvmArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const arg of out) {
    if (!arg.startsWith('-')) throw new Error(`Neplatný JVM argument: ${arg}`);
    if (arg === '-jar' || arg.startsWith('-Xmx') || arg.startsWith('-Xms')) throw new Error(`Argument ${arg} nastavuje srvMC sám.`);
  }
  return out;
}

export function buildJvmArgs(o: JvmOptions): string[] {
  const max = Math.max(512, Math.round(o.ramMaxMb));
  const min = Math.min(max, Math.max(256, Math.round(o.ramMinMb)));
  const args = [`-Xms${min}M`, `-Xmx${max}M`];
  if (o.jvmFlags === 'aikar') {
    args.push(...AIKAR_BASE, ...(max > 12 * 1024 ? AIKAR_LARGE : AIKAR_SMALL));
    // Pre-touching only pays off when the whole heap is reserved up front.
    if (min === max) args.push('-XX:+AlwaysPreTouch');
  }
  args.push(...ENCODING);
  if (o.timezone) args.push(`-Duser.timezone=${o.timezone}`);
  // Bedrock 26.60+ only joins over NetherNet: signaling on TCP and gameplay on UDP, both on this port.
  if (o.geyserPort) args.push('-DgeyserTransport=nethernet', `-DgeyserUdpPort=${o.geyserPort}`);
  args.push(...splitJvmArgs(o.extraJvmArgs));
  return args;
}
