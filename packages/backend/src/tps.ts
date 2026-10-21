// Ticks per second, read with a console command whose answer srvMC keeps out of the console.
import type { ServerConfig } from '@srvmc/shared';
import { effectiveType } from './content.ts';
import { compareVersions } from './providers/types.ts';

export interface TpsProbe {
  command: string;
  /** Every line of the answer (hidden from the console). */
  answer: RegExp;
  /** TPS from one answer line, or null when that line does not carry it. */
  parse(line: string): number | null;
}

const num = (s: string) => Number(s.replace(',', '.'));
const cap = (tps: number) => Math.round(Math.min(20, Math.max(0, tps)) * 10) / 10;

/** Bukkit family: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0" (Paper marks capped values with *). */
export const BUKKIT_TPS: TpsProbe = {
  command: 'tps',
  answer: /TPS from last 1m, 5m, 15m:/,
  parse(line) {
    const m = /TPS from last 1m, 5m, 15m: \*?(\d+(?:[.,]\d+)?)/.exec(line);
    return m ? cap(num(m[1]!)) : null;
  },
};

/** Forge and NeoForge: one line per dimension and an "Overall" line, in an older and a newer wording. */
export function forgeTps(command: string): TpsProbe {
  return {
    command,
    answer: /\b(Overall|Dim)\b[^:]*:.*TPS/,
    parse(line) {
      const m = /Overall\s*:\s*(?:.*Mean TPS: (\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?) TPS)/.exec(line);
      return m ? cap(num(m[1] ?? m[2]!)) : null;
    },
  };
}

/** Vanilla 1.20.3+ (also Fabric, Quilt): "/tick query" reports the average milliseconds per tick. */
export const TICK_QUERY: TpsProbe = {
  command: 'tick query',
  answer: /The game is (running normally|frozen|sprinting)|Target tick rate: |Average time per tick: |Percentiles: P50/,
  parse(line) {
    const m = /Average time per tick: (\d+(?:[.,]\d+)?)\s*ms/.exec(line);
    if (!m) return null;
    const mspt = num(m[1]!);
    return cap(mspt > 50 ? 1000 / mspt : 20);
  },
};

const numeric = (v: string) => /^\d+\.\d+(\.\d+)?$/.test(v);

export function tpsProbeFor(cfg: Pick<ServerConfig, 'type' | 'modpack' | 'build' | 'version'>): TpsProbe | null {
  const type = effectiveType(cfg);
  switch (type) {
    case 'paper':
    case 'purpur':
    case 'spigot':
    case 'arclight':
      return BUKKIT_TPS;
    case 'forge':
      return forgeTps('forge tps');
    case 'neoforge':
      // NeoForge renamed its command when it split from Forge (Minecraft 1.20.2).
      return forgeTps(numeric(cfg.version) && compareVersions(cfg.version, '1.20.2') < 0 ? 'forge tps' : 'neoforge tps');
    case 'vanilla':
    case 'fabric':
    case 'quilt':
      return numeric(cfg.version) && compareVersions(cfg.version, '1.20.3') >= 0 ? TICK_QUERY : null;
    default:
      return null;
  }
}
