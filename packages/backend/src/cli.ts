// Development entry point: runs the API on its own so the Vite dev server can proxy to it.
import { startBackend } from './app.ts';
import { makePaths } from './paths.ts';

const webFlag = process.argv.indexOf('--web');
const backend = await startBackend({
  port: Number(process.env.PORT ?? 8420),
  paths: makePaths(process.env.SRVMC_HOME),
  devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  webDir: webFlag > 0 ? process.argv[webFlag + 1] : process.env.SRVMC_WEB_DIR,
});
console.log(`srvMC API běží na ${backend.url} (data: ${makePaths(process.env.SRVMC_HOME).root})`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('Zastavuji servery…');
  await backend.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
