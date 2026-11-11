// Starts a built Host the way main does and checks the bridge end to end: hello,
// the Host composes and reports `running`, then an acknowledged shutdown and exit 0.
// The Host pairs in process with its own server and keeps its device credential in
// this OS's credential store, so run it only on a CI runner with a throwaway HOME
// (Linux needs an unlocked Secret Service session).
//
//   node scripts/package/host-smoke.mjs <Host executable> [arguments...]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { BridgeClient } from '../../src/bridge/client.ts';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: host-smoke.mjs <Host executable> [arguments...]');

const env = { ...process.env };
for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'PI_PACKAGE_DIR', 'BYOK_PI_BIN', 'ELECTRON_RUN_AS_NODE']) delete env[name];
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env, windowsHide: true });
let reachRunning;
const running = new Promise((resolve, reject) => { reachRunning = { resolve, reject }; });
const timer = setTimeout(() => reachRunning.reject(new Error('Host did not report running within 180 s')), 180_000);
const client = await BridgeClient.connect(child, state => {
  console.log(`[host-smoke] state ${JSON.stringify(state)}`);
  if (state.state === 'running') reachRunning.resolve();
  if (state.state === 'stopped') reachRunning.reject(new Error(`Host stopped: ${state.reason}`));
});
try {
  await running;
} catch (error) {
  client.kill();
  throw error;
} finally {
  clearTimeout(timer);
}
assert.equal(await client.call('shutdown', undefined), null);
assert.equal(await client.exited, 0);
console.log('[host-smoke] hello, running, shutdown, exit 0');
