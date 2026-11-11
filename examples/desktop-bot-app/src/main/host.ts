import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../bridge/client.ts';

const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Dev mode: the Host child runs under the Node on PATH, never under Electron's
 * own binary (RunAsNode is fused off). The packaged SEA Host arrives with #1811.
 */
export function startHost(): Promise<BridgeClient> {
  const entry = fileURLToPath(new URL('../bridge/stub-host.js', import.meta.url));
  const child = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  return BridgeClient.connect(child);
}

/** Asks the Host to stop, then kills it if it has not exited within the grace period. */
export async function stopHost(host: BridgeClient): Promise<void> {
  const timer = setTimeout(() => host.kill(), SHUTDOWN_GRACE_MS);
  try {
    await host.call('shutdown', undefined).catch(() => {});
    await host.exited;
  } finally {
    clearTimeout(timer);
  }
}
