import { CliError, run } from './agent';

run(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`servermin-agent: ${e instanceof CliError ? e.message : (e?.stack ?? e)}\n`);
  process.exit(1);
});
