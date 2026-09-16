import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { assertPiProjectionDirectory, assertWindowsPiProjectionAcl } from './pi-provider-launcher-core';

const exec = promisify(execFile);
// Test-owned physical ACL fixture; no cross-package internal import. This tests
// keys validation, not the client's allocator implementation.
async function createPrivateFixture(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await exec('icacls', [directory, '/inheritance:r', '/grant:r',
    `${os.userInfo().username}:(OI)(CI)F`, '/grant', '*S-1-5-18:(OI)(CI)F',
    '/grant', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true });
}
// Runs in the existing real non-administrator release-pack lane. POSIX cannot
// provide ACL/token evidence and explicitly skips this platform-only suite.
describe.skipIf(process.platform !== 'win32')('real Windows keys projection ACL', () => {
  it('accepts a private empty directory with the approved ACL', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-positive-')));
    try {
      await createPrivateFixture(directory);
      await expect(assertPiProjectionDirectory(directory, directory)).resolves.toBeUndefined();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  it('refuses a real external Allow ACE', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-foreign-')));
    try {
      await createPrivateFixture(directory);
      await exec('icacls', [directory, '/grant', '*S-1-1-0:(R)', '/Q'], { windowsHide: true });
      await expect(assertPiProjectionDirectory(directory, directory)).rejects.toThrow('pi_projection_acl_unauthorized_ace');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  it('refuses the real Windows directory owner rather than the current token', async () => {
    if (!process.env.SystemRoot) throw new Error('SystemRoot missing');
    await expect(assertWindowsPiProjectionAcl(process.env.SystemRoot)).rejects.toThrow('pi_projection_owner_mismatch');
  });
  it('refuses a real directory junction', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-junction-')));
    const directory = path.join(root, 'target');
    const junction = path.join(root, 'junction');
    try {
      await createPrivateFixture(directory);
      await fs.symlink(directory, junction, 'junction');
      await expect(assertWindowsPiProjectionAcl(junction)).rejects.toThrow('pi_projection_reparse_point');
      await expect(assertPiProjectionDirectory(junction, junction)).rejects.toThrow('pi_projection_not_directory_or_symlink');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
