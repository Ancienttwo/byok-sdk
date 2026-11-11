import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolveFileScopeGrant } from '../file-scope-guard';
import { startPreparedOperation } from './fixtures/prepared-operation';
import type { RuntimeAdapter, RuntimeOperationStartInput } from '../types';
import * as trees from '../adapters/process-tree';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { renderNativeSessions } from '../daemon/native-sessions/renderer';
import { nativeSessionsIO } from '../daemon/native-sessions/io';

// These transport tests own no OS process. Real-host suites retain process-tree enforcement.
vi.mock('../adapters/process-tree', () => ({
  withOwnedProcessTree: (options: unknown) => options,
  adoptOwnedProcessTree: vi.fn(async () => {}),
  disposeOwnedProcessTree: vi.fn(async ({ child }) => { child.emit('close', 0, null); }),
  requestOwnedProcessTreeTermination: vi.fn(async () => {}),
}));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(memory = false, readyFrames: unknown[] = [{ type: 'byok_host_ready', sessionId: 'native-session' }]) {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-adapter-'))); roots.push(cwd);
  const commands: string[] = [];
  let acknowledgeAbort!: () => void;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  let pending = '';
  child.stdin.on('data', chunk => {
    pending += chunk.toString();
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), command = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      commands.push(command.type);
      const response = () => frame({ type: 'response', id: command.id, success: true, data: { sessionId: 'native-session' } });
      if (command.type === 'abort') { acknowledgeAbort = response; if (!commands.includes('prompt')) response(); }
      else response();
    }
  });
  const adapter = new PiAdapter({ resolveBin: () => ({ command: '/fixture/pi', source: 'env' }), spawnFn: (() => {
    queueMicrotask(() => { for (const ready of readyFrames) frame(ready); }); return child;
  }) as never });
  const grant = memory ? await resolveFileScopeGrant({ fileScope: { mode: 'memory' }, home: { path: cwd, identity: await fs.stat(cwd, { bigint: true }) }, attempt: { homeAccess: 'writer' } }) : undefined;
  const wrapped: RuntimeAdapter = {
    descriptor: adapter.descriptor, runtimeEnvironment: () => adapter.runtimeEnvironment(), detect: () => adapter.detect(),
    prepare: async input => {
      const prepared = await adapter.prepare(input); if (prepared.kind !== 'prepared') return prepared;
      return { ...prepared, operation: { ...prepared.operation, start: (input: RuntimeOperationStartInput) => prepared.operation.start({ ...input,
        ...(grant === undefined ? {} : { memoryLane: grant }),
      }) } };
    },
  };
  const session = await startPreparedOperation(wrapped, { instruction: 'dream' }, { workspaceDir: cwd, agentHome: cwd, env: process.env });
  return { session, cwd, commands, ack: () => acknowledgeAbort() };
}

it('renders recorded sessions with the same summary rules without launch confirmations', async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-adapter-'))); roots.push(cwd);
  const sessionDir = join(cwd, 'sessions'); await fs.mkdir(sessionDir);
  const store = new AgentSessionHandoffStore();
  for (const id of ['native-session', 'session-B']) {
    await store.record({ agentRef: { agentId: 'agent', profileRevision: '1' }, taskId: 'task', sessionRef: id, runtimeId: 'pi', cwd, leaseId: 'lease' });
    await fs.writeFile(join(sessionDir, `2026-11-07T00-00-00-000Z_${id}.jsonl`), [
      { type: 'session', version: 3, id, cwd },
      { type: 'message', message: { role: 'assistant', timestamp: id === 'native-session' ? 2000 : 2500, content: [
        { type: 'toolCall', id: 'bash-call', name: 'bash', arguments: { command: 'echo useful' } },
        { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'notes/topic.md' } },
      ] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  const rendered = await renderNativeSessions({ home: cwd, sessionDir, window: { fromMs: 1000, toMs: 3000 },
    signal: new AbortController().signal, deadlineMs: Date.now() + 10000, io: nativeSessionsIO,
  });
  expect(JSON.parse(rendered.jsonLine).calls).toEqual([
    { tool: 'bash', arguments: { command: 'echo useful' }, result: 'none' }, { tool: 'read', arguments: { path: 'notes/topic.md' }, result: 'none' },
    { tool: 'bash', arguments: { command: 'echo useful' }, result: 'none' }, { tool: 'read', arguments: { path: 'notes/topic.md' }, result: 'none' },
  ]);
});

it.each([
  [],
  [{ type: 'byok_host_ready', sessionId: 'native-session' }, { type: 'byok_host_ready', sessionId: 'native-session' }],
  [{ type: 'byok_host_ready', sessionId: 'different-session' }],
].map(frames => ({ frames })))('rejects a memory lane without one matching readiness receipt: %j', async ({ frames }) => {
  await expect(fixture(true, frames)).rejects.toMatchObject({ message: 'memory_lane_tool_set_mismatch', retry: 'non-retryable' });
});

it.skipIf(process.platform === 'win32')('drains the memory abort acknowledgement before any process-tree disposal and never sends compact', async () => {
  const f = await fixture(true);
  const close = f.session.close();
  await vi.waitFor(() => expect(f.commands).toContain('abort'));
  expect(trees.disposeOwnedProcessTree).not.toHaveBeenCalled();
  expect(f.commands).not.toContain('compact');
  f.ack(); await close;
  expect(trees.disposeOwnedProcessTree).toHaveBeenCalledOnce();
});
