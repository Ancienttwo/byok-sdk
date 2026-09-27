/**
 * Test-only child process for the custody crash and lock suites. Run as
 * `node --import fixtures/register-ts-hook.mjs fixtures/custody-child.ts <mode> <json-args>`.
 *
 * - `apply`: apply one provisioning request and SIGKILL itself at the named
 *   persistence cut point (or print the result if it never reaches it).
 * - `hold-lock`: take the configuration lock, print `locked`, and wait to be
 *   killed.
 */
import { readFileSync } from 'node:fs';

import { DeviceSealingKeyStore } from '../device-sealing-key';
import { applySealedProviderProvisioning } from '../sealed-provisioning';
import { SqliteProviderProfileStore } from '../sqlite-profile-store';
import { FileSecretStore } from './file-secret-store';
import { placedIdentity } from './provisioning-requests';

interface ApplyArgs {
  dbPath: string;
  secretPath: string;
  requestPath: string;
  cutPoint: string;
  now: string;
  tenantId: string;
  deviceId: string;
  profileRef: string;
}

async function main(): Promise<void> {
  const [mode, raw] = process.argv.slice(2);
  if (mode === 'hold-lock') {
    const { dbPath } = JSON.parse(raw!) as { dbPath: string };
    const store = new SqliteProviderProfileStore({ path: dbPath });
    const lock = await store.acquireConfigurationLock();
    // Keep the lock strongly reachable: a runtime may collect (and finalize)
    // an unreachable SQLite connection, which would drop the lock early.
    (globalThis as { heldConfigurationLock?: unknown }).heldConfigurationLock = lock;
    process.stdout.write('locked\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (mode !== 'apply') throw new Error(`unknown mode ${mode}`);
  const args = JSON.parse(raw!) as ApplyArgs;
  const profileStore = new SqliteProviderProfileStore({ path: args.dbPath });
  const secretStore = new FileSecretStore(args.secretPath);
  const enrollment = { tenantId: args.tenantId, deviceId: args.deviceId };
  const sealingKey = await new DeviceSealingKeyStore({ secretStore }).loadOrCreate(enrollment);
  const result = await applySealedProviderProvisioning({
    request: JSON.parse(readFileSync(args.requestPath, 'utf8')),
    profileStore,
    secretStore,
    sealingKey,
    resolveProfileRef: () => args.profileRef,
    readIdentity: async () => placedIdentity(),
    now: () => new Date(args.now),
    faults: {
      onCutPoint(point) {
        if (point === args.cutPoint) process.kill(process.pid, 'SIGKILL');
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as { code?: string }).code ?? 'error'}\n`);
  process.exit(1);
});
