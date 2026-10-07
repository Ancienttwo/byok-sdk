import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { SpawnFn } from '../adapters/claude/process-client';
import { RuntimeStartupDisposalFailure } from '../runtime-failure';
import { sealRuntimeOperationManifest } from '../types';

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

it.skipIf(process.platform === 'win32')('cancels a silent inert runtime and retains its TERM-resistant process tree until disposal', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-aborted-tree-'));
  const receiptFile = path.join(workspaceDir, 'tree.json');
  const fixtureUrl = new URL('./fixtures/process-tree-receipt.mjs', import.meta.url).href;
  const source = `
    import { spawnProcessTreeDescendant } from ${JSON.stringify(fixtureUrl)};
    process.on('SIGTERM', () => {});
    await spawnProcessTreeDescendant({ receiptFile: ${JSON.stringify(receiptFile)}, rootPid: process.pid, ignoreTerm: true });
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `;
  let child: ChildProcess | undefined;
  const spawnFn = ((_command, _args, options) => {
    child = spawn(process.execPath, ['--input-type=module', '-e', source], options ?? {});
    return child;
  }) as SpawnFn;
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-node-fixture', source: 'path' }), spawnFn });
  const offer = { instruction: 'hello' };
  const prepared = await adapter.prepare({ offer, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  if (prepared.kind !== 'prepared') throw new Error('unexpected fixture rejection');
  const controller = new AbortController();
  let failure: unknown;
  try {
    const startup = prepared.operation.start({
      kind: 'instruction', instruction: 'hello', env: process.env, signal: controller.signal,
      manifest: sealRuntimeOperationManifest({ taskId: 'silent-fixture', runtimeId: 'claude', descriptor: adapter.descriptor,
        requiredToolsetIds: [], workspace: { workspaceDir }, forwardedEnvironmentNames: Object.keys(process.env) }),
    });
    void startup.catch(error => { failure = error; });
    await expect.poll(async () => fs.access(receiptFile).then(() => true, () => false), { timeout: 3000 }).toBe(true);
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as { rootPid: number; descendantPid: number; grandchildPid: number };
    controller.abort();
    await expect.poll(() => failure, { timeout: 1000 }).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (failure as RuntimeStartupDisposalFailure).retryDisposal();
    for (const pid of Object.values(receipt)) expect(exists(pid)).toBe(false);
  } finally {
    if (child?.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => child!.once('close', () => resolve()));
      }
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
