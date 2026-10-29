import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/task-runner-cancel-runtime.mjs', import.meta.url));
type Receipt = { rootPid: number; descendantPid: number; grandchildPid: number };
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

it('the cancellation fixture reaps its tree when its test worker is SIGKILLed before cleanup', async ({ onTestFinished }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-t1-worker-exit-'));
  const tree = path.join(dir, 'tree.json');
  // The worker cannot run finally/exit hooks after SIGKILL. Its real pipe EOF,
  // not a mocked close call or parent-side process sweep, is the fixture signal.
  const workerSource = `
    const { spawn, spawnSync } = require('node:child_process');
    const { readFileSync } = require('node:fs');
    const { createInterface } = require('node:readline');
    const [fixture, tree, trace] = process.argv.slice(1);
    let published = false;
    let stopped = false;
    const send = frame => {
      if (process.connected) process.send(frame, error => { if (error) stop(); });
    };
    const child = spawn(process.execPath, [fixture, 'app-server'], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, T1_TREE: tree, T1_TRACE: trace, T1_SCENARIO: 'tool' },
    });
    // The fixture publishes the complete receipt before installing its input
    // reader. Its initialize response is a readiness barrier, not a file event.
    const output = createInterface({ input: child.stdout });
    output.once('line', line => {
      if (stopped) return;
      try {
        const response = JSON.parse(line);
        if (response.id !== 1 || response.result?.userAgent !== 'task-runner-fixture') {
          throw new Error('unexpected fixture initialize response');
        }
        const receipt = JSON.parse(readFileSync(tree, 'utf8'));
        published = true;
        send({ type: 'tree', receipt });
        output.close();
      } catch (error) {
        send({ type: 'error', reason: String(error) });
        stop();
      }
    });
    // Parent loss can precede receipt publication or the fixture's EOF handler.
    // The launcher already owns the detached group, without needing a receipt.
    function stop() {
      if (stopped) return;
      stopped = true;
      output.close();
      child.stdout.destroy();
      child.stdin.destroy();
      // A detached POSIX group can outlive its root, including before receipt
      // publication. Root exit is not evidence that the owned group is empty.
      if (child.pid !== undefined) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
    }
    process.once('disconnect', stop);
    child.on('error', error => send({ type: 'error', reason: String(error) }));
    child.on('exit', (code, signal) => {
      if (!published) send({ type: 'error', reason: 'fixture exited before receipt: ' + code + '/' + signal });
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\\n');
  `;
  const worker = spawn(process.execPath, ['-e', workerSource, fixture, tree, path.join(dir, 'trace')],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve()); worker.once('error', reject);
  });
  let receipt: Receipt | undefined;
  // Vitest runs this hook on timeout even while the receipt await is suspended.
  onTestFinished(async () => {
    if (worker.connected) worker.disconnect();
    await exited;
    if (receipt && Object.values(receipt).some(alive)) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(receipt.rootPid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-receipt.rootPid, 'SIGKILL'); } catch { /* already reaped */ } }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  receipt = await new Promise<Receipt>((resolve, reject) => {
    worker.on('message', message => {
      const frame = message as { type: string; receipt: Receipt; reason: string };
      if (frame.type === 'tree') resolve(frame.receipt);
      else reject(new Error(frame.reason));
    });
    worker.once('error', reject);
    worker.once('exit', () => reject(new Error('fixture launcher exited before receipt')));
  });
  const pids = Object.values(receipt);
  expect(new Set(pids).size).toBe(3);
  for (const pid of pids) expect(alive(pid)).toBe(true);
  worker.kill('SIGKILL'); await exited;
  // Assert before the emergency hook sweep: all three must die on EOF.
  await vi.waitFor(() => { for (const pid of pids) expect(alive(pid), `orphan PID ${pid}`).toBe(false); });
});
