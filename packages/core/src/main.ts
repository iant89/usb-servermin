/**
 * Process entry point (`node dist/server.js`), started by systemd as server-control.service.
 */
import { loadConfig } from './config/config';
import { Platform } from './platform';

// node:sqlite prints an experimental warning on every start; it is expected.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const config = loadConfig();
const platform = new Platform(config);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Received ${signal}\n`);
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await platform.stop().catch((e) => process.stderr.write(`Shutdown error: ${e}\n`));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A failure inside the core itself: log it and let systemd restart us (Restart=on-failure).
// Module failures never reach here, because modules run in worker threads.
process.on('uncaughtException', (e) => {
  platform.logs.write({ level: 'ERROR', source: 'core', message: `Uncaught exception: ${e.message}`, metadata: { stack: e.stack } });
  platform.logs.close();
  process.exit(70);
});
process.on('unhandledRejection', (e) => {
  platform.logs.write({ level: 'ERROR', source: 'core', message: `Unhandled rejection: ${(e as Error)?.message ?? String(e)}`, metadata: { stack: (e as Error)?.stack } });
});

platform.start().catch((e) => {
  process.stderr.write(`Failed to start: ${e?.stack ?? e}\n`);
  process.exit(1);
});
