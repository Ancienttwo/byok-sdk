// DIAG #1373 (do not merge): the client's createProjectionDir steps, then the #1396 launcher check.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateTempDir, ensurePiProjectionDir, ensureSecureDir } from '../../src/packages/client/src/util/secure-dir';
import { assertPiProjectionDirectory } from '../../src/packages/keys/src/pi-provider-launcher-core';

const user = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim();
const sid = /"(S-1-[0-9-]+)"$/u.exec(user)?.[1] ?? '?';
console.log(`[diag] whoami=${JSON.stringify(user)} sid=${sid} rid=${sid.split('-').at(-1)} username=${os.userInfo().username}`);
const root = path.join(await fs.realpath(os.tmpdir()), `byok-diag-root-${process.pid}`);
await ensureSecureDir(root);
const dir = await createPrivateTempDir(await fs.realpath(root), 'pi-');
await ensurePiProjectionDir(dir);
const save = path.join(os.tmpdir(), `diag-acl-${process.pid}.txt`);
execFileSync('icacls', [dir, '/save', save]);
console.log(`[diag] projection=${dir}`);
console.log(`[diag] saved=${JSON.stringify((await fs.readFile(save)).toString('utf16le'))}`);
try {
  await assertPiProjectionDirectory(dir);
  console.log('[diag] launcher check: ACCEPTED');
} catch (error) {
  console.log(`[diag] launcher check: REJECTED ${(error as Error).message}`);
}
await fs.rm(root, { recursive: true, force: true });
await fs.rm(save, { force: true });
