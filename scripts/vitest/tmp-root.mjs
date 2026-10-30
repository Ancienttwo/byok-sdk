// Shared vitest `globalSetup`: one short, per-run temp root for the whole run.
//
// Test files create their scratch directories with `mkdtemp(os.tmpdir() + ...)`.
// Pointing TMPDIR at a root this module owns means everything they leave behind
// is removed in teardown instead of accumulating in the developer's real
// TMPDIR (tens of thousands of `byok-*` entries slowed Bun startup, which walks
// the ancestors of every spawn).
//
// The workers are child processes forked after globalSetup, so they inherit the
// environment set here; `os.tmpdir()` reads TMPDIR (TEMP/TMP on Windows) on
// every call. The root is deliberately short: on macOS the default TMPDIR is
// ~49 bytes long and a Unix socket path must stay under 104 bytes.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'];

let state;

export function setup() {
  if (state) throw new Error('tmp-root globalSetup ran twice without teardown');
  // POSIX: /tmp is short and always present. Windows has no such path, so keep
  // the OS temp dir there (no Unix sockets are involved). Fixtures need its
  // canonical spelling: the JS realpath keeps 8.3 names such as RUNNER~1, which
  // the SDK folds. The #1030 tests configure aliases explicitly.
  const base = process.platform === 'win32' ? realpathSync.native(os.tmpdir()) : realpathSync('/tmp');
  const root = mkdtempSync(path.join(base, 'byok-t-'));
  // The path-mutation gate's fixed root (/tmp/byok-pm-<uid>) is production
  // state outside this run root: the gate creates it and keeps its lock files
  // by design, so a run neither creates nor removes it.
  state = { root, previous: Object.fromEntries(TMP_ENV_KEYS.map(key => [key, process.env[key]])) };
  for (const key of TMP_ENV_KEYS) process.env[key] = root;
}

export function teardown() {
  if (!state) return;
  const { root, previous } = state;
  state = undefined;
  for (const key of TMP_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
