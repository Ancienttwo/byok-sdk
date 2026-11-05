import { spawn, type ChildProcess } from 'node:child_process';
import { readDeviceEnrollmentStatus, runSdkReservedHelperCommand } from '@byok-sdk/client';
import { DeviceCredentialStore } from '../../packages/client/src/daemon/device-credential-store';
import { createOwnedLineProcessSpawn } from '../../packages/client/src/runtime/owned-line-process';

/** One Credential Manager round trip of the packaged Host, through its own native asset root. */
async function credentialRoundTrip(nativeAssetRoot: string, storeDir: string): Promise<void> {
  const productId = `native-assets-sea-${process.pid}-${Date.now()}`;
  const record = { deviceId: 'device-sea', tenantId: 'tenant-sea', devicePublicKey: 'public', accessToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'private' };
  const store = new DeviceCredentialStore({ productId, storeDir, nativeAssetRoot });
  try {
    const status = await readDeviceEnrollmentStatus({ productId, storeDir, nativeAssetRoot });
    await store.replace(record);
    const stored = await new DeviceCredentialStore({ productId, storeDir, nativeAssetRoot }).read();
    process.stdout.write(`${JSON.stringify({ status: status.state, roundTrip: stored?.accessToken === record.accessToken, cleared: await store.clear() })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ failed: error instanceof Error ? error.name : String(error) })}\n`);
  }
}

async function main() {
  if (await runSdkReservedHelperCommand(process.argv.slice(2))) return;
  const mode = process.argv[2];
  if (mode === '--descendant') { setInterval(() => {}, 1000); return; }
  if (mode === '--runtime') {
    const descendant = spawn(process.execPath, ['--descendant'], { stdio: 'ignore' });
    process.stdout.write(`${JSON.stringify({ runtime: process.pid, descendant: descendant.pid })}\n`);
    setInterval(() => {}, 1000); return;
  }
  const nativeAssetRoot = process.argv[3]!;
  if (mode === '--credentials') { await credentialRoundTrip(nativeAssetRoot, process.argv[4]!); return; }
  let child: ChildProcess | undefined;
  const owned = createOwnedLineProcessSpawn({ nativeAssetRoot,
    spawnFn: (command, args, options) => { child = spawn(command, args, options); return child; },
  })(process.execPath, ['--runtime'], { env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, cwd: nativeAssetRoot });
  try {
    await owned.spawned;
    owned.onLine(line => process.stdout.write(`${line}\n`));
    setInterval(() => {}, 1000);
  } catch (error) {
    await owned.dispose();
    // Do not publish a runtime handle; require disposal before reporting refusal.
    let alive = false;
    if (child?.pid) { try { process.kill(child.pid, 0); alive = true; } catch {} }
    process.stdout.write(`${JSON.stringify({ failed: String(error), alive })}\n`);
    process.exitCode = alive ? 2 : 1;
  }
}
main().catch(error => { process.stderr.write(`${error}\n`); process.exitCode = 1; });
