// What the panel knows about server.properties keys. Unknown keys still show up under "Ostatní".

export type PropertyGroup = 'hra' | 'hraci' | 'svet' | 'vykon' | 'resource' | 'ostatni';

export interface PropertyDef {
  key: string;
  label: string;
  group: PropertyGroup;
  type: 'bool' | 'int' | 'enum' | 'string';
  default: string;
  hint?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /** Managed elsewhere in the panel (port, MOTD, online mode); not editable in the list. */
  managed?: boolean;
}

export const PROPERTY_GROUPS: { id: PropertyGroup; label: string }[] = [
  { id: 'hra', label: 'Hra' },
  { id: 'hraci', label: 'Hráči' },
  { id: 'svet', label: 'Svět' },
  { id: 'vykon', label: 'Výkon' },
  { id: 'resource', label: 'Resource pack' },
  { id: 'ostatni', label: 'Ostatní' },
];

export const PROPERTY_DEFS: PropertyDef[] = [
  {
    key: 'gamemode',
    label: 'Herní režim',
    group: 'hra',
    type: 'enum',
    default: 'survival',
    options: [
      { value: 'survival', label: 'Survival' },
      { value: 'creative', label: 'Creative' },
      { value: 'adventure', label: 'Adventure' },
      { value: 'spectator', label: 'Spectator' },
    ],
  },
  {
    key: 'difficulty',
    label: 'Obtížnost',
    group: 'hra',
    type: 'enum',
    default: 'easy',
    options: [
      { value: 'peaceful', label: 'Peaceful' },
      { value: 'easy', label: 'Easy' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' },
    ],
  },
  { key: 'force-gamemode', label: 'Vynutit herní režim při připojení', group: 'hra', type: 'bool', default: 'false' },
  { key: 'hardcore', label: 'Hardcore', group: 'hra', type: 'bool', default: 'false', hint: 'Po smrti už hráč nemůže hrát.' },
  { key: 'pvp', label: 'PvP', group: 'hra', type: 'bool', default: 'true' },
  { key: 'allow-flight', label: 'Povolit létání', group: 'hra', type: 'bool', default: 'false', hint: 'Zapni pro módy s létáním, jinak je hráči vyhazováni.' },
  { key: 'enable-command-block', label: 'Command bloky', group: 'hra', type: 'bool', default: 'false' },
  { key: 'spawn-protection', label: 'Ochrana spawnu (bloky)', group: 'hra', type: 'int', default: '16', min: 0, max: 1000 },

  { key: 'max-players', label: 'Max hráčů', group: 'hraci', type: 'int', default: '20', min: 1, max: 1000 },
  { key: 'white-list', label: 'Bílá listina', group: 'hraci', type: 'bool', default: 'false', managed: true },
  { key: 'enforce-whitelist', label: 'Vyhodit hráče mimo bílou listinu', group: 'hraci', type: 'bool', default: 'false' },
  { key: 'online-mode', label: 'Ověřovat účty přes Mojang', group: 'hraci', type: 'bool', default: 'true', managed: true },
  { key: 'op-permission-level', label: 'Úroveň práv operátora', group: 'hraci', type: 'int', default: '4', min: 1, max: 4 },
  { key: 'player-idle-timeout', label: 'Vyhodit neaktivní po (min, 0 = nikdy)', group: 'hraci', type: 'int', default: '0', min: 0, max: 1440 },
  { key: 'hide-online-players', label: 'Skrýt jména hráčů v seznamu serverů', group: 'hraci', type: 'bool', default: 'false' },
  { key: 'enable-status', label: 'Zobrazit server v seznamu serverů', group: 'hraci', type: 'bool', default: 'true' },

  { key: 'level-name', label: 'Složka světa', group: 'svet', type: 'string', default: 'world' },
  { key: 'level-seed', label: 'Seed', group: 'svet', type: 'string', default: '', hint: 'Prázdné = náhodný. Platí jen pro nový svět.' },
  {
    key: 'level-type',
    label: 'Typ světa',
    group: 'svet',
    type: 'enum',
    default: 'minecraft:normal',
    options: [
      { value: 'minecraft:normal', label: 'Normální' },
      { value: 'minecraft:flat', label: 'Plochý' },
      { value: 'minecraft:large_biomes', label: 'Velké biomy' },
      { value: 'minecraft:amplified', label: 'Zesílený (amplified)' },
    ],
  },
  { key: 'generate-structures', label: 'Generovat stavby (vesnice, chrámy)', group: 'svet', type: 'bool', default: 'true' },

  { key: 'view-distance', label: 'Dohled (chunky)', group: 'vykon', type: 'int', default: '10', min: 2, max: 32, hint: 'Menší číslo = méně zátěže.' },
  { key: 'simulation-distance', label: 'Simulace (chunky)', group: 'vykon', type: 'int', default: '10', min: 2, max: 32 },
  { key: 'sync-chunk-writes', label: 'Bezpečný zápis chunků', group: 'vykon', type: 'bool', default: 'true' },

  { key: 'resource-pack', label: 'URL resource packu', group: 'resource', type: 'string', default: '' },
  { key: 'resource-pack-sha1', label: 'SHA-1 packu', group: 'resource', type: 'string', default: '' },
  { key: 'resource-pack-prompt', label: 'Výzva k packu', group: 'resource', type: 'string', default: '' },
  { key: 'require-resource-pack', label: 'Vyžadovat resource pack', group: 'resource', type: 'bool', default: 'false' },

  { key: 'motd', label: 'MOTD', group: 'ostatni', type: 'string', default: 'A Minecraft Server', managed: true },
  { key: 'server-port', label: 'Port', group: 'ostatni', type: 'int', default: '25565', managed: true },
  { key: 'query.port', label: 'Query port', group: 'ostatni', type: 'int', default: '25565', managed: true },
];

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

/** Bedrock Dedicated Server keys (a different set than Java's). */
export const BEDROCK_PROPERTY_DEFS: PropertyDef[] = [
  { key: 'gamemode', label: 'Herní režim', group: 'hra', type: 'enum', default: 'survival', options: opts(['survival', 'Survival'], ['creative', 'Creative'], ['adventure', 'Adventure']) },
  { key: 'force-gamemode', label: 'Vynutit herní režim při připojení', group: 'hra', type: 'bool', default: 'false' },
  { key: 'difficulty', label: 'Obtížnost', group: 'hra', type: 'enum', default: 'easy', options: opts(['peaceful', 'Mírumilovná'], ['easy', 'Lehká'], ['normal', 'Normální'], ['hard', 'Těžká']) },
  { key: 'allow-cheats', label: 'Povolit cheaty (příkazy)', group: 'hra', type: 'bool', default: 'false' },
  { key: 'server-name', label: 'Název v seznamu serverů', group: 'hra', type: 'string', default: 'Dedicated Server' },

  { key: 'max-players', label: 'Max. hráčů', group: 'hraci', type: 'int', default: '10', min: 1, max: 1000 },
  { key: 'online-mode', label: 'Ověřovat účty přes Xbox Live', group: 'hraci', type: 'bool', default: 'true' },
  { key: 'allow-list', label: 'Povolený seznam hráčů', group: 'hraci', type: 'bool', default: 'false', managed: true },
  {
    key: 'default-player-permission-level',
    label: 'Výchozí oprávnění nového hráče',
    group: 'hraci',
    type: 'enum',
    default: 'member',
    options: opts(['visitor', 'Návštěvník'], ['member', 'Člen'], ['operator', 'Operátor']),
  },
  { key: 'player-idle-timeout', label: 'Vyhodit nečinné po (min, 0 = nikdy)', group: 'hraci', type: 'int', default: '30', min: 0, max: 1440 },
  { key: 'chat-restriction', label: 'Omezení chatu', group: 'hraci', type: 'enum', default: 'None', options: opts(['None', 'Žádné'], ['Dropped', 'Zprávy zahazovat'], ['Disabled', 'Chat vypnutý']) },
  { key: 'disable-player-interaction', label: 'Zakázat interakci mezi hráči', group: 'hraci', type: 'bool', default: 'false' },

  { key: 'level-seed', label: 'Seed nového světa', group: 'svet', type: 'string', default: '' },
  { key: 'view-distance', label: 'Dohled (chunky)', group: 'svet', type: 'int', default: '32', min: 5, max: 96 },
  { key: 'tick-distance', label: 'Simulační vzdálenost', group: 'svet', type: 'int', default: '4', min: 4, max: 12 },
  { key: 'level-name', label: 'Aktivní svět', group: 'svet', type: 'string', default: 'Bedrock level', managed: true },

  { key: 'max-threads', label: 'Max. vláken (0 = co nejvíc)', group: 'vykon', type: 'int', default: '8', min: 0, max: 256 },
  { key: 'enable-lan-visibility', label: 'Viditelný v síti doma', group: 'vykon', type: 'bool', default: 'true' },
  { key: 'client-side-chunk-generation-enabled', label: 'Generování chunků u hráče', group: 'vykon', type: 'bool', default: 'true' },

  { key: 'texturepack-required', label: 'Vyžadovat resource pack světa', group: 'resource', type: 'bool', default: 'false' },

  { key: 'server-port', label: 'Port', group: 'ostatni', type: 'int', default: '19132', managed: true },
  { key: 'server-portv6', label: 'Port IPv6', group: 'ostatni', type: 'int', default: '19133', managed: true },
  { key: 'server-udp-ports', label: 'UDP porty pro hru', group: 'ostatni', type: 'string', default: '', managed: true },
];

export function propertyDefsFor(edition: 'java' | 'bedrock' | 'hytale' = 'java'): PropertyDef[] {
  return edition === 'bedrock' ? BEDROCK_PROPERTY_DEFS : PROPERTY_DEFS;
}

export function propertyDef(key: string, edition: 'java' | 'bedrock' | 'hytale' = 'java'): PropertyDef | undefined {
  return propertyDefsFor(edition).find((d) => d.key === key);
}

/** Keys the panel writes itself; the generic properties endpoint refuses them. */
export const MANAGED_PROPERTY_KEYS = new Set(['server-port', 'query.port', 'server-portv6', 'server-udp-ports']);

export const PROPERTY_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
