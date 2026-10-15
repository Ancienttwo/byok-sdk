import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function security(args) {
  try { await execute('/usr/bin/security', args); }
  catch { throw new Error(`isolated test keychain ${args[0]} failed`); }
}

/** Real OS custody, owned by one test and shared only with that test's children. */
export async function createTestKeychain() {
  if (process.platform !== 'darwin') throw new Error('test keychains require macOS');
  const directory = await mkdtemp(path.join(tmpdir(), 'byok-kc-'));
  const keychainPath = path.join(directory, 'test.keychain-db');
  const password = randomBytes(32).toString('hex');
  let created = false;
  try {
    await security(['create-keychain', '-p', password, keychainPath]);
    created = true;
    await security(['unlock-keychain', '-p', password, keychainPath]);
    // No -l/-u/-t: no auto-lock while children exercise crash recovery.
    await security(['set-keychain-settings', keychainPath]);
  } catch (error) {
    if (created) await security(['delete-keychain', keychainPath]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: keychainPath,
    async dispose() {
      // Delete only our keychain. Replacing the user's whole search list would
      // overwrite keychains concurrently created by another test worker.
      await security(['delete-keychain', keychainPath]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
