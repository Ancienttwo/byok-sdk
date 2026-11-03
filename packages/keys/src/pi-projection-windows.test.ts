import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PI_ACL_CLIENT_STARTUP_DEADLINE_MS } from './fixtures/acl-evidence-budget';
import { assertPiProjectionDirectory, assertWindowsPiProjectionAcl } from './pi-provider-launcher-core';

const exec = promisify(execFile);
// Test-owned physical ACL fixture; no cross-package internal import. It
// mirrors the client's projection DACL (#1373): the current user, SYSTEM and
// Administrators with inheritable full control, plus OWNER RIGHTS with
// READ_CONTROL only.
async function createProjectionFixture(directory: string, ownerRights = true): Promise<void> {
  await fs.mkdir(directory);
  await exec('icacls', [directory, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`,
    '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F',
    ...(ownerRights ? ['/grant', '*S-1-3-4:(RC)'] : [])], { windowsHide: true });
}
async function withRoot(prefix: string, check: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  try { await check(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Runs in the existing real non-administrator release-pack lane. POSIX cannot
// provide ACL/token evidence and explicitly skips this platform-only suite.
describe.skipIf(process.platform !== 'win32')('real Windows keys projection ACL', () => {
  // The account's first whoami and icacls inside the client's startup
  // deadline; #1381 E1 measured them at 40-255ms on fresh hosted accounts.
  it('accepts an exclusively created projection directory on the account\'s first query (cold)', async () => withRoot('pi-acl-cold-', async root => {
    const directory = path.join(root, 'projection');
    await createProjectionFixture(directory);
    const started = Date.now();
    await expect(assertPiProjectionDirectory(directory)).resolves.toBeUndefined();
    console.log(`[pi-acl-native] cold query elapsed=${Date.now() - started}ms`);
  }), PI_ACL_CLIENT_STARTUP_DEADLINE_MS);
  it('accepts a projection directory under a non-ASCII path', async () => withRoot('pi-acl 空間 ü-', async root => {
    const directory = path.join(root, 'projection');
    await createProjectionFixture(directory);
    await expect(assertPiProjectionDirectory(directory)).resolves.toBeUndefined();
  }));
  it('refuses a directory without the OWNER RIGHTS ACE', async () => withRoot('pi-acl-no-ow-', async root => {
    const directory = path.join(root, 'projection');
    await createProjectionFixture(directory, false);
    await expect(assertPiProjectionDirectory(directory)).rejects.toThrow('pi_projection_acl_owner_rights_missing');
  }));
  // icacls writes Everyone as the alias WD, which the launcher does not admit.
  it('refuses a real external Allow ACE', async () => withRoot('pi-acl-foreign-', async root => {
    const directory = path.join(root, 'projection');
    await createProjectionFixture(directory);
    await exec('icacls', [directory, '/grant', '*S-1-1-0:(R)', '/Q'], { windowsHide: true });
    await expect(assertPiProjectionDirectory(directory)).rejects.toThrow('pi_projection_acl_invalid_ace');
  }));
  it('refuses a DACL that inherits from its parent', async () => withRoot('pi-acl-inherit-', async root => {
    const directory = path.join(root, 'projection');
    await createProjectionFixture(directory);
    await exec('icacls', [directory, '/inheritance:e', '/Q'], { windowsHide: true });
    await expect(assertPiProjectionDirectory(directory)).rejects.toThrow('pi_projection_acl_unprotected');
  }));
  it('refuses a real directory junction', async () => withRoot('pi-acl-junction-', async root => {
    const directory = path.join(root, 'target');
    const junction = path.join(root, 'junction');
    await createProjectionFixture(directory);
    await fs.symlink(directory, junction, 'junction');
    await expect(assertWindowsPiProjectionAcl(junction)).rejects.toThrow('pi_projection_reparse_point');
    await expect(assertPiProjectionDirectory(junction)).rejects.toThrow('pi_projection_not_directory_or_symlink');
  }));
  it('reports a missing directory with a closed cause and no path', async () => withRoot('pi-acl-missing-', async root => {
    await expect(assertWindowsPiProjectionAcl(path.join(root, 'absent'))).rejects
      .toThrow(new Error('pi_projection_acl_query_failed: Pi projection ACL query failed (cause=path_not_found, step=readdir)'));
  }));
});
