import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { testScratchRoot } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { TestServer } from './fixtures/test-server';

const capture = vi.hoisted(() => ({
  helper: vi.fn(() => '/sdk/release/agent-memory-fs'),
  surface: undefined as ReturnType<typeof import('../daemon/prepared-tool-surface').createPreparedToolSurfaceAssembler> | undefined,
}));
// Model an installed/verified macOS or Windows x64 helper at the resolver seam. The tests do
// not open it: they assert admission before an adapter can start a memory tool.
vi.mock('../daemon/agent-memory-helper-release', () => ({ resolveAgentMemoryFilesystemHelper: capture.helper }));
vi.mock('../daemon/prepared-tool-surface', async importOriginal => {
  const actual = await importOriginal<typeof import('../daemon/prepared-tool-surface')>();
  return { ...actual, createPreparedToolSurfaceAssembler: (deps: Parameters<typeof actual.createPreparedToolSurfaceAssembler>[0]) => {
    capture.surface = actual.createPreparedToolSurfaceAssembler(deps);
    return capture.surface;
  } };
});
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { isAgentMemoryFilesystemHelperSupported } from '../daemon/agent-memory-fs-helper';

let daemon: Daemon | undefined;
let server: TestServer | undefined;
const roots: string[] = [];
afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await server?.close(); server = undefined;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  capture.helper.mockClear(); capture.surface = undefined;
});
async function config(mode: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-memory-admission-'));
  roots.push(root);
  return { productId: 'memory-admission', productName: 'Memory admission', serverUrl: server?.url ?? 'http://localhost:1',
    localAgentRelease: { version: '0.0.0-test' }, storeDir: path.join(root, 'store'),
    storage: { scratchRoot: testScratchRoot() }, agentHome: { hostStorageRoot: path.join(root, 'homes') },
    ...(mode === undefined ? {} : { agentMemoryMcp: mode }),
  } as DaemonConfig;
}

it.each(['disabled', false, null, 1])('rejects malformed memory MCP admission %s', async mode => {
  const input = await config(mode);
  expect(() => createDaemonWithAdapters(input, [])).toThrow('agentMemoryMcp must be auto or off');
});

// Supported admission backends: native Linux and the helper resolver seam above.
// Windows arm64 has no SDK memory backend to opt out of.
it.skipIf(process.platform !== 'linux' && !isAgentMemoryFilesystemHelperSupported()).each([undefined, 'auto', 'off'] as const)(
  'ordinary Agent admission with memory mode %s preserves the non-MCP adapter boundary', async mode => {
    server = await TestServer.start();
    const adapter = new StubRuntimeAdapter('pi', undefined, { steer: true, resume: true, approvalInteractive: true });
    daemon = createDaemonWithAdapters({ ...await config(mode), agentEgress: FRESH_DAEMON_EGRESS }, [adapter], { longPoll: { idleDelayMs: 10, retryDelayMs: 10 } });
    await daemon.pair('pairing-code'); await daemon.start();
    await server.waitFor(envelope => envelope.type === 'conn.hello');
    server.pushLongPollEvent(createEnvelope('task.offer', {
      instruction: 'No external action', runtime: 'pi', agentRef: { agentId: 'agent', profileRevision: '1' }, ...FRESH_OFFER,
    }, { taskId: 'memory-admission-task', seq: server.nextSeq() }));
    const result = await server.waitFor(envelope => envelope.task_id === 'memory-admission-task'
      && (envelope.type === 'task.started' || envelope.type === 'task.decline'));
    if (mode === 'off') {
      expect(result.type).toBe('task.started');
      expect(adapter.startCalls).toHaveLength(1);
      expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentmemory).toBeUndefined();
      // #614: `off` also drops the memory guidance, so no second memory writer is asked for.
      expect(adapter.startCalls[0]!.task.instruction).toBe('No external action');
      expect(capture.helper).not.toHaveBeenCalled();
    } else {
      expect(result.type).toBe('task.decline');
      if (result.type !== 'task.decline' || result.payload.sealed !== undefined) throw new Error('Expected a plaintext decline');
      expect(result.payload.reason).toContain('cannot project required MCP toolsets');
      expect(adapter.startCalls).toHaveLength(0);
    }
  },
);

// #614: a Host reads the effective admission instead of inferring it from configuration.
it('reports the effective memory MCP admission in status', async () => {
  expect(createDaemonWithAdapters(await config('off'), []).status().agentMemoryMcp).toBe('off');
  const noHome = await config(undefined);
  delete noHome.agentHome;
  expect(createDaemonWithAdapters(noHome, []).status().agentMemoryMcp).toBe('unavailable');
  for (const mode of [undefined, 'auto'] as const) {
    // Native Linux and the helper resolver seam above admit memory; Windows arm64 has no backend.
    expect(createDaemonWithAdapters(await config(mode), []).status().agentMemoryMcp)
      .toBe(process.platform === 'linux' || isAgentMemoryFilesystemHelperSupported() ? 'admitted' : 'unavailable');
  }
});

it('refuses prepared memory selections when disabled, without degrading them to none', async () => {
  daemon = createDaemonWithAdapters(await config('off'), []);
  for (const agentMemory of ['read', 'read-write'] as const) {
    expect(await capture.surface!.resolveBinding({ requiredToolsets: [], agentMemory })).toMatchObject({
      ok: false, code: 'unsupported_input', detail: 'agent_memory_unavailable',
    });
  }
  expect(await capture.surface!.resolveBinding({ requiredToolsets: [], agentMemory: 'none' })).toMatchObject({ ok: true });
  expect(capture.helper).not.toHaveBeenCalled();
});

// Explicit transports retain their own helper requirement even with task tools off.
it.skipIf(!isAgentMemoryFilesystemHelperSupported()).each(['projection', 'intents'] as const)(
  'off preserves helper validation for explicit %s', async transport => {
    const input = await config('off');
    if (transport === 'projection') input.agentMemory = {};
    else input.agentMemoryIntents = { fetch: async () => [], complete: async () => undefined };
    capture.helper.mockImplementationOnce(() => { throw new Error('invalid release helper'); });
    expect(() => createDaemonWithAdapters(input, [])).toThrow('invalid release helper');
    expect(capture.helper).toHaveBeenCalledOnce();
  },
);
