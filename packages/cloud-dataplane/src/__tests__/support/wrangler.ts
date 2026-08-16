/**
 * Wrangler plumbing shared by the worker packaging and E2E tests.
 *
 * Resolving wrangler's bin from the installed package — rather than relying
 * on PATH or `bunx`/`npx` — keeps the spawn deterministic in CI: the version
 * under test is the one pinned in this package's devDependencies, executed
 * under the same Node that runs vitest.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const PACKAGE_DIR = fileURLToPath(new URL('../../..', import.meta.url));
export const WORKER_SMOKE_DIR = path.join(PACKAGE_DIR, 'worker-smoke');

/** The `.js` entry of the installed wrangler CLI, for `spawn(node, [entry, ...])`. */
export function wranglerEntry(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('wrangler/package.json', { paths: [PACKAGE_DIR] });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: Record<string, string> };
  const relative = manifest.bin['wrangler'];
  if (relative === undefined) throw new Error('installed wrangler exposes no wrangler bin');
  return path.join(path.dirname(manifestPath), relative);
}

/** The environment every wrangler invocation in these tests runs under. */
export function wranglerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
}
