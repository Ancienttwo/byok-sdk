/**
 * The Worker packaging probe: `wrangler deploy --dry-run` over the
 * `worker-smoke/` fixture, with the emitted bundle inspected.
 *
 * This is the one test that exercises the deployment story the runtime
 * subpath exists for: a host bundler (wrangler/esbuild) resolving
 * `@byok-sdk/cloud-dataplane/runtime` and bundling it together with `pg`
 * against `nodejs_compat`. A dry run needs no Cloudflare credentials and no
 * database — it is a pure build — so it runs ungated, like any unit test.
 *
 * What the bundle must NOT contain: the Node-only half of this package. The
 * migration runner and the cleanup composition must be unreachable from the
 * runtime subpath, and the markers below are chosen to survive minification —
 * SQL string literals and the ledger's table name, not identifier names that
 * a minifier could rewrite.
 *
 * What it MUST contain, and does: `pg`'s own node-module usage. Under
 * `nodejs_compat`, workerd implements `node:net`, `node:tls`, `node:crypto`
 * and `node:events`, so those imports are expected and deliberately not
 * banned. Wrangler additionally emits a bare `fs` import hoisted from `pg`'s
 * lazy `require('pgpass')` (the password-file path); workerd imports that
 * module fine and the path itself never runs when the connection string
 * carries a password — the live E2E (`worker-e2e.test.ts`) is the proof, and
 * this file intentionally asserts the weaker, truthful property instead:
 * no `node:fs`, no `fs/promises`, no migration runner, no cleanup.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_DIR, WORKER_SMOKE_DIR, wranglerEntry, wranglerEnv } from './support/wrangler';

const DIST_RUNTIME = path.join(PACKAGE_DIR, 'dist', 'runtime.js');

if (!existsSync(DIST_RUNTIME)) {
  throw new Error(
    `build this package before running its tests: ${DIST_RUNTIME} is missing (the fixture imports @byok-sdk/cloud-dataplane/runtime, which resolves to dist/)`,
  );
}

describe('the worker-smoke fixture bundles on wrangler', () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'byok-worker-smoke-'));
  let bundle = '';

  it('dry-runs wrangler deploy over worker-smoke', () => {
    const result = spawnSync(
      process.execPath,
      [wranglerEntry(), 'deploy', '--dry-run', '--outdir', outDir],
      {
        cwd: WORKER_SMOKE_DIR,
        encoding: 'utf8',
        timeout: 120_000,
        env: wranglerEnv(),
      },
    );
    expect(result.status, `wrangler stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const emitted = readdirSync(outDir).filter((name) => name.endsWith('.js'));
    expect(emitted.length).toBeGreaterThan(0);
    bundle = emitted.map((name) => readFileSync(path.join(outDir, name), 'utf8')).join('\n');
  });

  it('reaches no node builtin that workerd does not implement', () => {
    expect(bundle).not.toContain('node:fs');
    expect(bundle).not.toContain('fs/promises');
  });

  it('leaves the migration runner out of the runtime bundle', () => {
    expect(bundle).not.toContain('byok_schema_migration');
    expect(bundle).not.toContain('readMigrationFiles');
  });

  it('leaves the cleanup composition out of the runtime bundle', () => {
    expect(bundle).not.toContain('PostgresCloudCleanup');
    expect(bundle).not.toContain('cleanup_dead_letter_not_found');
  });

  it('does keep the runtime entry itself in the bundle', () => {
    // A bundle that lost the dataplane entirely would vacuously pass every
    // "must not contain" above, so the positive control lives here too. The
    // names are the ones the fixture actually exercises — wrangler's dry-run
    // bundle is unminified and tree-shaken, so unused exports (the rest of
    // the runtime surface) are legitimately absent.
    expect(bundle).toContain('createByokPool');
    expect(bundle).toContain('createPostgresCoreStores');
    expect(bundle).toContain('PostgresPairingCodeStore');
    expect(bundle).toContain('PostgresTruthCommitter');
  });

  it('cleans up its scratch directory', () => {
    rmSync(outDir, { recursive: true, force: true });
  });
});
