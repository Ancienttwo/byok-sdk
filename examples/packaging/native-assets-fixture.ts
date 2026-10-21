import { spawn, type ChildProcess } from 'node:child_process';
import { runSdkReservedHelperCommand } from '@byok-sdk/client';
import { createOwnedLineProcessSpawn } from '../../packages/client/src/runtime/owned-line-process';

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
