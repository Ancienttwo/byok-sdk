import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { SpawnFn } from '../adapters/claude/process-client';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { startPreparedOperation } from './fixtures/prepared-operation';

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

// Only inert Node fixtures run here. No installed runtime, provider or MCP.
describe('Claude rejected startup process-tree receipt', () => {
  it.skipIf(process.platform === 'win32')('does not return ordinary resume mismatch while its TERM-resistant descendants survive', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-rejected-tree-'));
    const receiptFile = path.join(workspaceDir, 'tree.json');
    const fixtureUrl = new URL('./fixtures/process-tree-receipt.mjs', import.meta.url).href;
    const source = `
      import { spawnProcessTreeDescendant } from ${JSON.stringify(fixtureUrl)};
      process.on('SIGTERM', () => {});
      await spawnProcessTreeDescendant({ receiptFile: ${JSON.stringify(receiptFile)}, rootPid: process.pid, ignoreTerm: true });
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'wrong-session' }) + '\\n');
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `;
    let child: ChildProcess | undefined;
    const spawnFn = ((_command, _args, options) => {
      child = spawn(process.execPath, ['--input-type=module', '-e', source], options ?? {});
      return child;
    }) as SpawnFn;
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-node-fixture', source: 'path' }), spawnFn });
    try {
      const failure = await startPreparedOperation(adapter, {
        instruction: 'hello', sessionRef: 'requested-session',
      }, { workspaceDir, env: process.env }).catch(error => error);
      expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
      expect(failure).toMatchObject({ phase: 'start', category: 'authority' });
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as { rootPid: number; descendantPid: number; grandchildPid: number };
      for (const pid of Object.values(receipt)) expect(exists(pid)).toBe(false);
    } finally {
      // The baseline intentionally fails while the fixture is still alive.
      // Reap only the exact detached process group this test spawned.
      if (child?.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>(resolve => child!.once('close', () => resolve()));
        }
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
