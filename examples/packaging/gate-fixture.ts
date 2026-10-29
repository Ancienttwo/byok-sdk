// Packaging probe for the path-mutation gate (#1149). The gate is internal, so
// this imports its module directly: it proves the bundled OS lock (darwin raw
// fd with O_EXLOCK, linux abstract socket, win32 named pipe) survives an ESM,
// CJS and SEA bundle. All state is fixture-owned.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePathMutationGate, PathMutationGateBusyError } from '../../packages/client/src/util/path-mutation-gate';

async function main() {
  const targetPath = await realpath(await mkdtemp(join(tmpdir(), 'b-gate-')));
  try {
    const first = await acquirePathMutationGate({ scope: 'store', targetPath });
    await assert.rejects(acquirePathMutationGate({ scope: 'store', targetPath }, { waitMs: 0 }), PathMutationGateBusyError);
    await first.release();
    const second = await acquirePathMutationGate({ scope: 'store', targetPath });
    await second.release();
    console.log(`BYOK_GATE_BUNDLE_OK ${process.platform}`);
  } finally { await rm(targetPath, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
