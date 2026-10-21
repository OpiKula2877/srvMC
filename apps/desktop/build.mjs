// Bundles the Electron main process together with the backend and copies the built web panel next to it.
import { cp, rm, stat } from 'node:fs/promises';
import { build } from 'esbuild';

const webDist = new URL('../../packages/web/dist/', import.meta.url);
try {
  await stat(webDist);
} catch {
  console.error('Chybí packages/web/dist – spusť nejdřív "npm run build -w @srvmc/web".');
  process.exit(1);
}

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/main.mjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
  // Bundled CommonJS dependencies (Fastify and friends) expect require/__dirname.
  banner: {
    js: [
      "import { createRequire as __srvmcCreateRequire } from 'node:module';",
      "import { fileURLToPath as __srvmcFileURLToPath } from 'node:url';",
      "import { dirname as __srvmcDirname } from 'node:path';",
      'const require = __srvmcCreateRequire(import.meta.url);',
      'const __filename = __srvmcFileURLToPath(import.meta.url);',
      'const __dirname = __srvmcDirname(__filename);',
    ].join('\n'),
  },
});
await cp(webDist, 'dist/web', { recursive: true });
await cp('assets', 'dist/assets', { recursive: true, filter: (src) => !src.endsWith('icon-source.png') });
console.log('Desktop build hotový: apps/desktop/dist');
