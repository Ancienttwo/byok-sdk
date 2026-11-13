import { testExecutionScratch } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePiRuntimeLaunch } from '../adapters/pi/runtime-launch';
import { loadPrivateTeamDocument } from '../bin/team-codex-relay';
import { foldNameAliases } from '../util/fold-name-aliases';
import { isModeNot0700 } from '../util/secure-dir';

let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (root !== undefined) await fs.rm(root, { recursive: true, force: true }); root = undefined; });

// #2031: owner checks compare against the effective uid, which owns what this
// process creates. A diverging real uid must not change any verdict. Skipped
// as root: foldNameAliases trusts uid 0 unconditionally, so a getuid revert
// would still pass there (CI does not run as root).
it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)('owner checks use the effective uid when the real uid differs', async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owner-uid-')));
  const storeRoot = path.join(root, 'store');
  await fs.mkdir(storeRoot, { mode: 0o755 });
  await fs.chmod(storeRoot, 0o755);
  await fs.symlink(storeRoot, path.join(root, 'alias'));
  const document = path.join(root, 'bindings.json');
  await fs.writeFile(document, '{"version":1}', { mode: 0o600 });
  const sessionCwd = path.join(root, 'session');
  await fs.mkdir(sessionCwd, { mode: 0o700 });
  const scratch = await testExecutionScratch();
  vi.spyOn(process, 'getuid').mockReturnValue(process.geteuid!() + 1);

  expect(await isModeNot0700(storeRoot, 'store-root')).toBe(true);
  expect(foldNameAliases(path.join(root, 'alias'))).toBe(storeRoot);
  expect(await loadPrivateTeamDocument(document)).toEqual({ version: 1 });
  const launch = await resolvePiRuntimeLaunch({
    kind: 'pi-rpc', sessionCwd, scratch, keysSessionDir: path.join(root, 'native-sessions'),
    resolveInvocation: () => ({ command: process.execPath, entry: path.join(root!, 'entry.js') }),
    env: { PATH: process.env.PATH! },
  });
  try { expect(launch.projectionDir).toBeDefined(); } finally { await launch.release(); }
});
