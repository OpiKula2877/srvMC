// What the panel knows about server.properties keys. Unknown keys still show up under 'Other'.

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
  { id: 'hra', label: 'Game' },
  { id: 'hraci', label: 'Players' },
  { id: 'svet', label: 'World' },
  { id: 'vykon', label: 'Performance' },
  { id: 'resource', label: 'Resource pack' },
  { id: 'ostatni', label: 'Other' },
];

export const PROPERTY_DEFS: PropertyDef[] = [
  {
    key: 'gamemode',
    label: 'Game mode',
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
    label: 'Difficulty',
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
  { key: 'force-gamemode', label: 'Force game mode on join', group: 'hra', type: 'bool', default: 'false' },
  { key: 'hardcore', label: 'Hardcore', group: 'hra', type: 'bool', default: 'false', hint: 'After death the player cannot play any more.' },
  { key: 'pvp', label: 'PvP', group: 'hra', type: 'bool', default: 'true' },
  { key: 'allow-flight', label: 'Allow flight', group: 'hra', type: 'bool', default: 'false', hint: 'Turn on for mods with flying, otherwise players get kicked.' },
  { key: 'enable-command-block', label: 'Command blocks', group: 'hra', type: 'bool', default: 'false' },
  { key: 'spawn-protection', label: 'Spawn protection (blocks)', group: 'hra', type: 'int', default: '16', min: 0, max: 1000 },

  { key: 'max-players', label: 'Max players', group: 'hraci', type: 'int', default: '20', min: 1, max: 1000 },
  { key: 'white-list', label: 'Whitelist', group: 'hraci', type: 'bool', default: 'false', managed: true },
  { key: 'enforce-whitelist', label: 'Kick players not on the whitelist', group: 'hraci', type: 'bool', default: 'false' },
  { key: 'online-mode', label: 'Check accounts with Mojang', group: 'hraci', type: 'bool', default: 'true', managed: true },
  { key: 'op-permission-level', label: 'Operator permission level', group: 'hraci', type: 'int', default: '4', min: 1, max: 4 },
  { key: 'player-idle-timeout', label: 'Kick idle players after (min, 0 = never)', group: 'hraci', type: 'int', default: '0', min: 0, max: 1440 },
  { key: 'hide-online-players', label: 'Hide player names in the server list', group: 'hraci', type: 'bool', default: 'false' },
  { key: 'enable-status', label: 'Show the server in the server list', group: 'hraci', type: 'bool', default: 'true' },

  { key: 'level-name', label: 'World folder', group: 'svet', type: 'string', default: 'world' },
  { key: 'level-seed', label: 'Seed', group: 'svet', type: 'string', default: '', hint: 'Empty = random. Only applies to a new world.' },
  {
    key: 'level-type',
    label: 'World type',
    group: 'svet',
    type: 'enum',
    default: 'minecraft:normal',
    options: [
      { value: 'minecraft:normal', label: 'Normal' },
      { value: 'minecraft:flat', label: 'Flat' },
      { value: 'minecraft:large_biomes', label: 'Large biomes' },
      { value: 'minecraft:amplified', label: 'Amplified' },
    ],
  },
  { key: 'generate-structures', label: 'Generate structures (villages, temples)', group: 'svet', type: 'bool', default: 'true' },

  { key: 'view-distance', label: 'View distance (chunks)', group: 'vykon', type: 'int', default: '10', min: 2, max: 32, hint: 'A smaller number means less load.' },
  { key: 'simulation-distance', label: 'Simulation distance (chunks)', group: 'vykon', type: 'int', default: '10', min: 2, max: 32 },
  { key: 'sync-chunk-writes', label: 'Safe chunk writes', group: 'vykon', type: 'bool', default: 'true' },

  { key: 'resource-pack', label: 'Resource pack URL', group: 'resource', type: 'string', default: '' },
  { key: 'resource-pack-sha1', label: 'Pack SHA-1', group: 'resource', type: 'string', default: '' },
  { key: 'resource-pack-prompt', label: 'Pack prompt', group: 'resource', type: 'string', default: '' },
  { key: 'require-resource-pack', label: 'Require the resource pack', group: 'resource', type: 'bool', default: 'false' },

  { key: 'motd', label: 'MOTD', group: 'ostatni', type: 'string', default: 'A Minecraft Server', managed: true },
  { key: 'server-port', label: 'Port', group: 'ostatni', type: 'int', default: '25565', managed: true },
  { key: 'query.port', label: 'Query port', group: 'ostatni', type: 'int', default: '25565', managed: true },
];

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

/** Bedrock Dedicated Server keys (a different set than Java's). */
export const BEDROCK_PROPERTY_DEFS: PropertyDef[] = [
  { key: 'gamemode', label: 'Game mode', group: 'hra', type: 'enum', default: 'survival', options: opts(['survival', 'Survival'], ['creative', 'Creative'], ['adventure', 'Adventure']) },
  { key: 'force-gamemode', label: 'Force game mode on join', group: 'hra', type: 'bool', default: 'false' },
  { key: 'difficulty', label: 'Difficulty', group: 'hra', type: 'enum', default: 'easy', options: opts(['peaceful', 'Peaceful'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']) },
  { key: 'allow-cheats', label: 'Allow cheats (commands)', group: 'hra', type: 'bool', default: 'false' },
  { key: 'server-name', label: 'Name in the server list', group: 'hra', type: 'string', default: 'Dedicated Server' },

  { key: 'max-players', label: 'Max players', group: 'hraci', type: 'int', default: '10', min: 1, max: 1000 },
  { key: 'online-mode', label: 'Check accounts with Xbox Live', group: 'hraci', type: 'bool', default: 'true' },
  { key: 'allow-list', label: 'Allow list', group: 'hraci', type: 'bool', default: 'false', managed: true },
  {
    key: 'default-player-permission-level',
    label: 'Default permission of a new player',
    group: 'hraci',
    type: 'enum',
    default: 'member',
    options: opts(['visitor', 'Visitor'], ['member', 'Member'], ['operator', 'Operator']),
  },
  { key: 'player-idle-timeout', label: 'Kick idle players after (min, 0 = never)', group: 'hraci', type: 'int', default: '30', min: 0, max: 1440 },
  { key: 'chat-restriction', label: 'Chat restriction', group: 'hraci', type: 'enum', default: 'None', options: opts(['None', 'None'], ['Dropped', 'Drop messages'], ['Disabled', 'Chat off']) },
  { key: 'disable-player-interaction', label: 'Disable interaction between players', group: 'hraci', type: 'bool', default: 'false' },

  { key: 'level-seed', label: 'Seed of a new world', group: 'svet', type: 'string', default: '' },
  { key: 'view-distance', label: 'View distance (chunks)', group: 'svet', type: 'int', default: '32', min: 5, max: 96 },
  { key: 'tick-distance', label: 'Simulation distance', group: 'svet', type: 'int', default: '4', min: 4, max: 12 },
  { key: 'level-name', label: 'Active world', group: 'svet', type: 'string', default: 'Bedrock level', managed: true },

  { key: 'max-threads', label: 'Max threads (0 = as many as possible)', group: 'vykon', type: 'int', default: '8', min: 0, max: 256 },
  { key: 'enable-lan-visibility', label: 'Visible on the home network', group: 'vykon', type: 'bool', default: 'true' },
  { key: 'client-side-chunk-generation-enabled', label: 'Chunk generation on the player side', group: 'vykon', type: 'bool', default: 'true' },

  { key: 'texturepack-required', label: "Require the world's resource pack", group: 'resource', type: 'bool', default: 'false' },

  { key: 'server-port', label: 'Port', group: 'ostatni', type: 'int', default: '19132', managed: true },
  { key: 'server-portv6', label: 'Port IPv6', group: 'ostatni', type: 'int', default: '19133', managed: true },
  { key: 'server-udp-ports', label: 'UDP ports for the game', group: 'ostatni', type: 'string', default: '', managed: true },
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
