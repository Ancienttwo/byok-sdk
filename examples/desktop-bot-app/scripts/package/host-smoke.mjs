// Starts a built Host the way main does and checks the bridge end to end: hello,
// the Host composes and reports `running`, then an acknowledged shutdown and exit 0.
// The Host pairs in process with its own server and keeps its device credential in
// this OS's credential store, so run it only on a CI runner (Linux needs an
// unlocked Secret Service session).
//
//   node scripts/package/host-smoke.mjs <Host executable> [arguments...]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { BridgeClient } from '../../src/bridge/client.ts';
import { hostEnvironment } from '../../src/main/packaged-host.ts';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: host-smoke.mjs <Host executable> [arguments...]');

/** Rejects with `what` when `promise` has not settled within `ms`. */
function within(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms);
  })]).finally(() => clearTimeout(timer));
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: hostEnvironment(), windowsHide: true });
let reachRunning;
const running = new Promise((resolve, reject) => { reachRunning = { resolve, reject }; });
const client = await within(BridgeClient.connect(child, state => {
  console.log(`[host-smoke] state ${JSON.stringify(state)}`);
  if (state.state === 'running') reachRunning.resolve();
  if (state.state === 'stopped') reachRunning.reject(new Error(`Host stopped: ${state.reason}`));
}), 30_000, 'Host did not answer hello').catch(error => { child.kill(); throw error; });
try {
  const exitedEarly = client.exited.then(code => { throw new Error(`Host exited with code ${code} before it reported running`); });
  await within(Promise.race([running, exitedEarly]), 180_000, 'Host did not report running');
  assert.equal(await within(client.call('shutdown', undefined), 30_000, 'Host did not acknowledge shutdown'), null);
  assert.equal(await within(client.exited, 30_000, 'Host did not exit after shutdown'), 0);
} catch (error) {
  client.kill();
  throw error;
}
console.log('[host-smoke] hello, running, shutdown, exit 0');
