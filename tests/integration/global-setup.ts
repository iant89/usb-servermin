import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error untyped build script
import { buildCore } from '../../tools/build.mjs';
// @ts-expect-error untyped build script
import { buildModule } from '../../tools/build-module.mjs';

/** Builds the core bundle, worker host and fixture modules once for all integration tests. */
export default async function setup() {
  const root = resolve(import.meta.dirname, '../..');
  const out = join(root, '.vitest-tmp/core');
  mkdirSync(out, { recursive: true });
  await buildCore(out);
  const modules = readdirSync(join(root, 'modules')).map((m) => `modules/${m}`);
  for (const dir of ['examples/hello', 'tests/fixtures/faulty', 'tests/fixtures/echo-provider', 'tests/fixtures/echo-consumer', ...modules]) await buildModule(join(root, dir), { dev: true });
}
