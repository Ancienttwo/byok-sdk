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

it('the cancellation fixture reaps its tree when its test worker is SIGKILLed before cleanup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-t1-worker-exit-'));
  const tree = path.join(dir, 'tree.json');
  // The worker cannot run finally/exit hooks after SIGKILL. Its real pipe EOF,
  // not a mocked close call or parent-side process sweep, is the fixture signal.
  const workerSource = `
    const { spawn } = require('node:child_process');
    const { watch, existsSync, readFileSync } = require('node:fs');
    const { dirname } = require('node:path');
    const [fixture, tree, trace] = process.argv.slice(1);
    let published = false;
    const publish = () => {
      if (published || !existsSync(tree)) return;
      const receipt = JSON.parse(readFileSync(tree, 'utf8'));
      published = true;
      process.send({ type: 'tree', receipt });
      watcher.close();
    };
    const watcher = watch(dirname(tree), publish);
    const child = spawn(process.execPath, [fixture, 'app-server'], {
      detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: process.env.PATH, T1_TREE: tree, T1_TRACE: trace, T1_SCENARIO: 'tool' },
    });
    child.on('error', error => process.send({ type: 'error', reason: String(error) }));
    child.on('exit', (code, signal) => {
      if (!published) process.send({ type: 'error', reason: 'fixture exited before receipt: ' + code + '/' + signal });
    });
    publish();
  `;
  const worker = spawn(process.execPath, ['-e', workerSource, fixture, tree, path.join(dir, 'trace')],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise<void>((resolve, reject) => {
    worker.once('close', () => resolve()); worker.once('error', reject);
  });
  let receipt: Receipt | undefined;
  try {
    receipt = await new Promise<Receipt>((resolve, reject) => {
      worker.on('message', message => {
        const frame = message as { type: string; receipt: Receipt; reason: string };
        if (frame.type === 'tree') resolve(frame.receipt);
        else reject(new Error(frame.reason));
      });
      worker.once('error', reject);
    });
    const pids = Object.values(receipt);
    expect(new Set(pids).size).toBe(3);
    for (const pid of pids) expect(alive(pid)).toBe(true);
    worker.kill('SIGKILL'); await closed;
    // Assert before the emergency finally sweep: all three must die on EOF.
    await vi.waitFor(() => { for (const pid of pids) expect(alive(pid), `orphan PID ${pid}`).toBe(false); });
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed;
    if (receipt && Object.values(receipt).some(alive)) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(receipt.rootPid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-receipt.rootPid, 'SIGKILL'); } catch { /* already reaped */ } }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
