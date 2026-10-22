// Reads what a plugin or mod jar says about itself (plugin.yml, fabric.mod.json, mods.toml, …).
import yauzl from 'yauzl';

export type JarLoader = 'bukkit' | 'paper' | 'fabric' | 'quilt' | 'forge' | 'neoforge';

export interface JarMeta {
  kind: 'plugin' | 'mod' | 'unknown';
  loaders: JarLoader[];
  name?: string;
  version?: string;
  /** Declared as client-side only (Fabric/Quilt "environment": "client"). */
  clientOnly?: boolean;
}

const WANTED = new Set(['plugin.yml', 'paper-plugin.yml', 'fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml']);
const MAX_ENTRY = 1024 * 1024;

/** Reads the small descriptor files of a jar into memory. */
export function readJarEntries(file: string, wanted: Set<string> = WANTED): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Cannot open the jar.'));
      const out = new Map<string, string>();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName) || entry.uncompressedSize > MAX_ENTRY) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return zip.readEntry();
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
          stream.on('error', () => zip.readEntry());
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Value of a top-level YAML key ("name: Foo" / 'version: "1.2"'). Good enough for plugin.yml. */
export function yamlTop(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*["']?([^"'\\r\\n#]+?)["']?\\s*(?:#.*)?$`, 'm').exec(text);
  return m?.[1]?.trim();
}

/** First value of `key = "…"` in a mods.toml. */
export function tomlValue(text: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm').exec(text)?.[1];
}

const placeholder = (v?: string) => (v && !v.includes('${') ? v : undefined);

export function describeJar(entries: Map<string, string>): JarMeta {
  const fabric = entries.get('fabric.mod.json');
  const quilt = entries.get('quilt.mod.json');
  const neoToml = entries.get('META-INF/neoforge.mods.toml');
  const forgeToml = entries.get('META-INF/mods.toml');
  const plugin = entries.get('paper-plugin.yml') ?? entries.get('plugin.yml');

  if (fabric || quilt) {
    try {
      if (quilt) {
        const q = JSON.parse(quilt) as { quilt_loader?: { version?: string; metadata?: { name?: string } }; minecraft?: { environment?: string } };
        return { kind: 'mod', loaders: ['quilt'], name: q.quilt_loader?.metadata?.name, version: placeholder(q.quilt_loader?.version), clientOnly: q.minecraft?.environment === 'client' };
      }
      const f = JSON.parse(fabric!) as { name?: string; id?: string; version?: string; environment?: string };
      return { kind: 'mod', loaders: ['fabric', 'quilt'], name: f.name ?? f.id, version: placeholder(f.version), clientOnly: f.environment === 'client' };
    } catch {
      return { kind: 'mod', loaders: quilt ? ['quilt'] : ['fabric', 'quilt'] };
    }
  }
  if (neoToml || forgeToml) {
    const toml = (neoToml ?? forgeToml)!;
    const clientOnly = /^\s*displayTest\s*=\s*["']IGNORE_ALL_VERSION["']/m.test(toml) && /clientSideOnly\s*=\s*true/.test(toml);
    return { kind: 'mod', loaders: neoToml ? ['neoforge'] : ['forge', 'neoforge'], name: tomlValue(toml, 'displayName'), version: placeholder(tomlValue(toml, 'version')), clientOnly };
  }
  if (plugin) {
    return { kind: 'plugin', loaders: entries.has('paper-plugin.yml') ? ['paper'] : ['bukkit', 'paper'], name: yamlTop(plugin, 'name'), version: placeholder(yamlTop(plugin, 'version')) };
  }
  return { kind: 'unknown', loaders: [] };
}

export async function readJarMeta(file: string): Promise<JarMeta> {
  try {
    return describeJar(await readJarEntries(file));
  } catch {
    return { kind: 'unknown', loaders: [] };
  }
}
