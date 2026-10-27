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
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'];

let state;

// The path-mutation gate uses a fixed UID-scoped root, independent of TMPDIR.
// Claim it only if this run creates it; preserve every pre-existing root.
// Never recursively delete this shared namespace: live or stale endpoints
// must make cleanup fail, rather than disappear under an unrelated process.
export function claimEmptyDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return undefined;
    throw error;
  }
  const owned = lstatSync(directory, { bigint: true });
  return () => {
    const current = lstatSync(directory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new Error(`test-owned directory identity changed: ${directory}`);
    }
    rmdirSync(directory);
  };
}

export function setup() {
  if (state) throw new Error('tmp-root globalSetup ran twice without teardown');
  // POSIX: /tmp is short and always present. Windows has no such path, so keep
  // the OS temp dir there (no Unix sockets are involved). Fixtures need its
  // canonical spelling: the JS realpath keeps 8.3 names such as RUNNER~1, which
  // the SDK folds. The #1030 tests configure aliases explicitly.
  const base = process.platform === 'win32' ? realpathSync.native(os.tmpdir()) : realpathSync('/tmp');
  const root = mkdtempSync(path.join(base, 'byok-t-'));
  let releaseGateRoot;
  try {
    if (process.platform !== 'win32') {
      releaseGateRoot = claimEmptyDirectory(`/tmp/byok-pm-${process.getuid?.() ?? 'unknown'}`);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  state = { root, releaseGateRoot, previous: Object.fromEntries(TMP_ENV_KEYS.map(key => [key, process.env[key]])) };
  for (const key of TMP_ENV_KEYS) process.env[key] = root;
}

export function teardown() {
  if (!state) return;
  const { root, previous, releaseGateRoot } = state;
  state = undefined;
  for (const key of TMP_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  try {
    releaseGateRoot?.();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
