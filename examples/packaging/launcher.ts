// M3-K packageability guarantee smoke.
//
// Decision-6 boundary: the SDK ships ONLY the npm library — this file is not
// a product, not a distribution artifact, and it is never signed, notarized,
// or auto-updated. Its only job is to be a minimal, realistic entry point
// that a single-file bundler (bun build --compile, Node SEA — see
// templates/packaging/{bun,sea}) can compile into one executable, so CI can
// prove a real packageability hazard is actually handled rather than merely
// asserted in prose.
//
// The hazard: `packages/client/src/adapters/pi/resolve-bin.ts` calls
// `import.meta.resolve(PI_PACKAGE_NAME)` to find pi's required package
// install. tsup marks that package `external` (never bundled into
// @byok-sdk/client's own dist), so a single-file product must inject its
// required Node 24.15+ pi sidecar with BYOK_PI_BIN. `detect()` reports
// kind: 'probe-failed' for package resolution failure, or kind: 'not-found'
// when an explicit sidecar executable is missing. What's NOT
// exercised anywhere else is whether `import.meta.resolve` still behaves
// (throws catchably, degrades) once @byok-sdk/client's own code is itself
// flattened into a single-file compiled binary, run somewhere with no
// node_modules of its own. That is what this launcher + the recipes in
// templates/packaging/ actually prove, empirically, in CI.
//
// claude/codex are deliberately NOT probed here: their resolve-bin.ts
// (adapters/claude, adapters/codex) only ever do a bare PATH lookup for the
// user's own already-installed, already-authenticated CLI -- never bundled,
// never a hazard, nothing for a packaging smoke to prove.
//
// Deliberately dry / no network:
//   - `createDaemon(...)` + `.status()` only construct the object graph and
//     read local in-memory/on-disk state; `.start()` / `.pair()` (the only
//     calls that touch the network or require a paired device) are never
//     invoked. This is enough to force the bundler to pull in create-daemon,
//     connection-manager, task-runner, etc. alongside the adapters.
//   - `new PiAdapter().detect()` is the actual runtime probe: it calls the
//     same `resolveBin()` -> `resolvePiBin()` path the real adapter uses.
//     `BYOK_PI_BIN`, if set, short-circuits resolve-bin.ts straight to that
//     path (see resolve-bin.ts) -- so running this SAME compiled binary
//     twice, once with pi genuinely unreachable and once with `BYOK_PI_BIN`
//     pointing at a stub script, proves both halves of the guarantee:
//     observable missing-sidecar detection and correct pickup when present.
//
// Output contract: exactly one line to stdout on success, prefixed with
// `BYOK_PACKAGING_PROBE ` and followed by a JSON object -- this is what the
// bun/SEA recipe scripts (templates/packaging/{bun,sea}/run-smoke.sh) grep
// for. A thrown error prints the same marker to stderr with `ok: false` and
// exits non-zero, so a hard crash (the CRITICAL escalation case: pi
// resolution breaking module load instead of degrading) is unmistakable in
// CI output rather than silently swallowed.

import { createDaemon, PiAdapter, SqliteLocalTaskJournal } from '@byok-sdk/client';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROBE_MARKER = 'BYOK_PACKAGING_PROBE';

// TEMP #2332 diagnostic: which SQLite handle outlives close() on this runtime.
async function handleDiagnostic(scratchRoot: string): Promise<Record<string, unknown>> {
  const { readdirSync, rmSync, mkdirSync } = await import('node:fs');
  const { Worker } = await import('node:worker_threads');
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const busy = (dir: string): string[] => readdirSync(dir).filter((name) => {
    try { rmSync(path.join(dir, name)); return false; } catch { return true; }
  });
  const gc = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc;
  const out: Record<string, unknown> = { runtime: (globalThis as { Bun?: { version: string } }).Bun?.version ?? process.version };
  out.journal = busy(path.join(scratchRoot, 'journal'));
  if (gc) { gc(true); out.journalAfterGc = busy(path.join(scratchRoot, 'journal')); }
  const mainDir = path.join(scratchRoot, 'main'); mkdirSync(mainDir);
  const prepared = new sqlite.DatabaseSync(path.join(mainDir, 'x.db'));
  prepared.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  prepared.prepare('SELECT count(*) FROM t').get();
  prepared.close();
  out.mainPrepared = busy(mainDir);
  const execDir = path.join(scratchRoot, 'exec'); mkdirSync(execDir);
  const plain = new sqlite.DatabaseSync(path.join(execDir, 'x.db'));
  plain.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  plain.close();
  out.mainExecOnly = busy(execDir);
  const workerDir = path.join(scratchRoot, 'worker'); mkdirSync(workerDir);
  const worker = new Worker(`const s = process.getBuiltinModule('node:sqlite'); const d = new s.DatabaseSync(require('node:worker_threads').workerData);
    d.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)'); d.prepare('SELECT count(*) FROM t').get(); d.close();`, { eval: true, workerData: path.join(workerDir, 'x.db') });
  await new Promise((resolve) => worker.once('exit', resolve));
  out.workerPrepared = busy(workerDir);
  if (gc) { gc(true); out.afterGc = { mainPrepared: busy(mainDir), workerPrepared: busy(workerDir) }; }
  return out;
}

async function main(): Promise<void> {
  const scratchRoot = await realpath(await mkdtemp(path.join(
    process.platform === 'win32' ? os.tmpdir() : '/tmp', 'byok-pkg-',
  )));
  try {
    const daemon = createDaemon({
      localAgentRelease: { version: '0.0.0-packaging-probe' },
      productId: 'byok-packaging-smoke',
      productName: 'BYOK Packaging Smoke',
      // Deliberately unroutable (port 0) -- start()/pair() are never called,
      // so this is never dialed. Present only because DaemonConfig requires it.
      serverUrl: 'http://127.0.0.1:0',
      // Hermetic: never touch a real ~/.byok on whatever machine/CI runner
      // this compiled binary happens to execute on.
      storeDir: path.join(os.tmpdir(), 'byok-packaging-smoke', String(process.pid)),
      storage: { scratchRoot },
    });

    // Dry: no pairing on disk yet, so this is `paired: false, connected:
    // false` by construction -- the point is that it constructs and returns
    // at all inside a bundled/compiled binary, not what it reports.
    const daemonStatus = daemon.status();

    // The actual hazard probe -- see file header.
    const piDetect = await new PiAdapter().detect();

    // The journal commits on a worker thread started from source the client
    // bundle inlines (#2332): an open, a read and a close prove that thread
    // runs inside the bundled/compiled binary.
    const journal = new SqliteLocalTaskJournal({ storeDir: path.join(scratchRoot, 'journal') });
    const journalEntries = (await journal.measureUsage()).journalEntries;
    await journal.close();
    const diag = await handleDiagnostic(scratchRoot); // TEMP #2332 diagnostic, reverted after one CI run

    const result = {
      ok: true as const,
      daemonStatus,
      piDetect,
      journalEntries,
      diag,
      byokPiBinSet: process.env.BYOK_PI_BIN !== undefined,
    };
    console.log(`${PROBE_MARKER} ${JSON.stringify(result)}`);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  const result = {
    ok: false as const,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  console.error(`${PROBE_MARKER} ${JSON.stringify(result)}`);
  process.exitCode = 1;
});
