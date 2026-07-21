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
// `import.meta.resolve(PI_PACKAGE_NAME)` to find pi's optionalDependency
// install. tsup marks that package `external` (never bundled into
// @byok/client's own dist), and resolve-bin.ts already wraps the call in a
// try/catch that falls back to a bare `pi` on PATH, whose `detect()` then
// reports `present: false` when that also fails. That fallback is exercised
// and passing in this repo's ordinary Node test suite -- what's NOT
// exercised anywhere else is whether `import.meta.resolve` still behaves
// (throws catchably, degrades) once @byok/client's own code is itself
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
//     graceful degrade when absent, and correct pickup when present.
//
// Output contract: exactly one line to stdout on success, prefixed with
// `BYOK_PACKAGING_PROBE ` and followed by a JSON object -- this is what the
// bun/SEA recipe scripts (templates/packaging/{bun,sea}/run-smoke.sh) grep
// for. A thrown error prints the same marker to stderr with `ok: false` and
// exits non-zero, so a hard crash (the CRITICAL escalation case: pi
// resolution breaking module load instead of degrading) is unmistakable in
// CI output rather than silently swallowed.

import { createDaemon, PiAdapter } from '@byok/client';
import os from 'node:os';
import path from 'node:path';

const PROBE_MARKER = 'BYOK_PACKAGING_PROBE';

async function main(): Promise<void> {
  const daemon = createDaemon({
    productId: 'byok-packaging-smoke',
    productName: 'BYOK Packaging Smoke',
    // Deliberately unroutable (port 0) -- start()/pair() are never called,
    // so this is never dialed. Present only because DaemonConfig requires it.
    serverUrl: 'http://127.0.0.1:0',
    workspaceRoot: process.cwd(),
    // Hermetic: never touch a real ~/.byok on whatever machine/CI runner
    // this compiled binary happens to execute on.
    storeDir: path.join(os.tmpdir(), 'byok-packaging-smoke', String(process.pid)),
  });

  // Dry: no pairing on disk yet, so this is `paired: false, connected:
  // false` by construction -- the point is that it constructs and returns
  // at all inside a bundled/compiled binary, not what it reports.
  const daemonStatus = daemon.status();

  // The actual hazard probe -- see file header.
  const piDetect = await new PiAdapter().detect();

  const result = {
    ok: true as const,
    daemonStatus,
    piDetect,
    byokPiBinSet: process.env.BYOK_PI_BIN !== undefined,
  };
  console.log(`${PROBE_MARKER} ${JSON.stringify(result)}`);
}

main().catch((err: unknown) => {
  const result = {
    ok: false as const,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  console.error(`${PROBE_MARKER} ${JSON.stringify(result)}`);
  process.exitCode = 1;
});
