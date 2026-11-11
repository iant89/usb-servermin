/**
 * Process entry point of the Servermin Manager, started by systemd as servermin-manager.service.
 */
import { loadManagerConfig } from './config';
import { Manager } from './manager';

// node:sqlite prints an experimental warning on every start; it is expected.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

let manager: Manager;
try {
  manager = new Manager(loadManagerConfig());
} catch (e) {
  // Configuration problems: say what is wrong, without a stack trace.
  process.stderr.write(`servermin-manager: ${(e as Error).message}\n`);
  process.exit(78); // EX_CONFIG
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Received ${signal}\n`);
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await manager.stop().catch((e) => process.stderr.write(`Shutdown error: ${e}\n`));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A failure inside the Manager itself: log it and let systemd restart us (Restart=on-failure).
process.on('uncaughtException', (e) => {
  manager.logs.writeDirect({ level: 'ERROR', source: 'manager', message: `Uncaught exception: ${e.message}`, metadata: { stack: e.stack } });
  process.exit(70);
});
process.on('unhandledRejection', (e) => {
  manager.logs.write({ level: 'ERROR', source: 'manager', message: `Unhandled rejection: ${(e as Error)?.message ?? String(e)}`, metadata: { stack: (e as Error)?.stack } });
});

manager.start().catch((e) => {
  process.stderr.write(`servermin-manager: failed to start: ${e?.code === 'EADDRINUSE' ? `port ${manager.config.http.port} is already in use` : (e?.stack ?? e)}\n`);
  process.exit(1);
});
