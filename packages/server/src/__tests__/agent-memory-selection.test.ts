import type { Server as HttpServer } from 'node:http';
import { createEnvelope, type AgentEgressPolicy } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { claimAndStart, connectFakeDaemonLongPoll, nextEnvelope, sendOne, startServer, stopServer, TEST_AGENT_DISPATCH, TEST_CLAIMED_EXECUTOR } from './test-support';

const PRODUCT_ID = 'acme';
const AGENT_REF = { agentId: 'memory-agent', profileRevision: 'profile-r1' } as const;
const POLICY: AgentEgressPolicy = {
  policyRevision: 'policy-r1',
  activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled' as const, transcript: 'disabled' as const, artifact: 'disabled' as const },
};
const ALL_CAPABILITIES = [
  'agent-home-contract', 'agent-home-readers', 'agent-memory-selection', 'agent-egress-policy',
  'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];

/** #614: reference-server dispatch threads `agentMemory` and the kernel gates it on `agent-memory-selection`. */
describe('reference-server per-task Agent memory dispatch (#614)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; baseUrl: string }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 200 });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('projects reader memory evidence and leaves it absent for a writer terminal', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID, capabilities: [...ALL_CAPABILITIES, 'agent-memory-read-write-if-admitted'],
    });
    for (const pass of [
      { homeAccess: 'memory-reader' as const, agentMemory: 'read' as const, change: { outcome: 'reader-attributed' as const, paths: ['MEMORY.md'] } },
      { homeAccess: 'writer' as const, agentMemory: 'read-write-if-admitted' as const, change: undefined },
    ]) {
      const handle = await started.byok.dispatch({
        ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'memory pass',
        ...(pass.homeAccess === 'memory-reader' ? { homeAccess: pass.homeAccess } : {}), agentMemory: pass.agentMemory,
      });
      await claimAndStart(started.byok, daemon, handle, TEST_CLAIMED_EXECUTOR);
      const terminal = createEnvelope('task.complete', {
        executor: TEST_CLAIMED_EXECUTOR, agentRef: TEST_AGENT_DISPATCH.agentRef, summary: 'done', sessionRef: TEST_AGENT_DISPATCH.sessionRef,
        ...(pass.change === undefined ? {} : { agentHomeMemoryChange: pass.change }),
      }, { taskId: handle.taskId });
      expect(await sendOne(daemon, terminal)).toMatchObject({ status: 200, body: { accepted: 1 } });
      const result = await handle.result();
      const recorded = await started.byok.tasks.deviceTerminal(handle.taskId);
      expect(recorded?.envelope.payload).toEqual(terminal.payload);
      expect(Object.hasOwn(result, 'agentHomeMemoryChange')).toBe(pass.change !== undefined);
      if (pass.change !== undefined) expect(result.agentHomeMemoryChange).toEqual(terminal.payload.agentHomeMemoryChange);
    }
  });

  it('refuses an agentMemory dispatch to a device without agent-memory-selection before creating the task', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    await expect(started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      taskId: 'memory-refused',
      instruction: 'plan only',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'none',
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await started.byok.tasks.attempt('memory-refused')).toBeUndefined();
  });

  it('delivers agentMemory on the Agent offer to a device that advertises agent-memory-selection', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-memory-selection'],
    });
    await started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      instruction: 'read memory',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'read',
    });
    const offered = await nextEnvelope(daemon);
    expect(offered.type).toBe('task.offer');
    expect(offered.payload).toMatchObject({ agentRef: AGENT_REF, agentMemory: 'read' });
  });

  it('refuses a memory-reader dispatch that selects read-write before creating the task', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ALL_CAPABILITIES,
    });
    await expect(started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      taskId: 'reader-read-write',
      instruction: 'read memory',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      homeAccess: 'memory-reader',
      agentMemory: 'read-write',
    })).rejects.toThrow(/agentMemory read-write requires a writer/);
    expect(await started.byok.tasks.attempt('reader-read-write')).toBeUndefined();
  });

  it('refuses a memory-reader execution that selects read-write before any row is written', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ALL_CAPABILITIES,
    });
    await expect(started.byok.executions.submit({
      taskId: 'fresh-reader-read-write',
      deviceId: daemon.deviceId,
      payload: {
        instruction: 'read memory', target: { lane: 'runtime', runtimeId: 'codex' }, terminalProjection: { mode: 'none' }, agentRef: AGENT_REF,
        session: { mode: 'fresh' }, egressPolicy: POLICY, homeAccess: 'memory-reader', agentMemory: 'read-write',
      },
    })).rejects.toThrow(/agentMemory read-write requires a writer/);
    expect(await started.byok.tasks.attempt('fresh-reader-read-write')).toBeUndefined();
    expect(await started.byok.tasks.offer('fresh-reader-read-write')).toBeUndefined();
  });

  it('refuses read-if-admitted to a device without agent-memory-read-if-admitted, on dispatch and on submit', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ALL_CAPABILITIES,
    });
    await expect(started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      taskId: 'read-if-admitted-refused',
      instruction: 'chat turn',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'read-if-admitted',
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    await expect(started.byok.executions.submit({
      taskId: 'fresh-read-if-admitted-refused',
      deviceId: daemon.deviceId,
      payload: {
        instruction: 'chat turn', target: { lane: 'runtime', runtimeId: 'codex' }, terminalProjection: { mode: 'none' }, agentRef: AGENT_REF,
        session: { mode: 'fresh' }, egressPolicy: POLICY, agentMemory: 'read-if-admitted',
      },
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await started.byok.tasks.attempt('read-if-admitted-refused')).toBeUndefined();
    expect(await started.byok.tasks.offer('fresh-read-if-admitted-refused')).toBeUndefined();
  });

  it('delivers read-if-admitted to a device that advertises agent-memory-read-if-admitted', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [...ALL_CAPABILITIES, 'agent-memory-read-if-admitted'],
    });
    await started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      instruction: 'chat turn',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'read-if-admitted',
    });
    const offered = await nextEnvelope(daemon);
    expect(offered.type).toBe('task.offer');
    expect(offered.payload).toMatchObject({ agentRef: AGENT_REF, agentMemory: 'read-if-admitted' });
  });

  it('refuses read-write-if-admitted to a device without agent-memory-read-write-if-admitted, on dispatch and on submit', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [...ALL_CAPABILITIES, 'agent-memory-read-if-admitted'],
    });
    await expect(started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      taskId: 'read-write-if-admitted-refused',
      instruction: 'chat turn',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'read-write-if-admitted',
    })).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining('agent-memory-read-write-if-admitted'),
    });
    await expect(started.byok.executions.submit({
      taskId: 'fresh-read-write-if-admitted-refused',
      deviceId: daemon.deviceId,
      payload: {
        instruction: 'chat turn', target: { lane: 'runtime', runtimeId: 'codex' }, terminalProjection: { mode: 'none' }, agentRef: AGENT_REF,
        session: { mode: 'fresh' }, egressPolicy: POLICY, agentMemory: 'read-write-if-admitted',
      },
    })).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining('agent-memory-read-write-if-admitted'),
    });
    expect(await started.byok.tasks.attempt('read-write-if-admitted-refused')).toBeUndefined();
    expect(await started.byok.tasks.offer('fresh-read-write-if-admitted-refused')).toBeUndefined();
  });

  it('delivers read-write-if-admitted to a device that advertises agent-memory-read-write-if-admitted', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [...ALL_CAPABILITIES, 'agent-memory-read-write-if-admitted'],
    });
    await started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      instruction: 'chat turn',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'read-write-if-admitted',
    });
    const offered = await nextEnvelope(daemon);
    expect(offered.type).toBe('task.offer');
    expect(offered.payload).toMatchObject({ agentRef: AGENT_REF, agentMemory: 'read-write-if-admitted' });
  });

  it('refuses a memory-reader with read-write-if-admitted before the task exists, on dispatch and on submit', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [...ALL_CAPABILITIES, 'agent-memory-read-write-if-admitted'],
    });
    await expect(started.byok.dispatch({
      target: { lane: 'auto' },
      deviceId: daemon.deviceId,
      taskId: 'reader-read-write-if-admitted',
      instruction: 'read memory',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      homeAccess: 'memory-reader',
      agentMemory: 'read-write-if-admitted',
    })).rejects.toThrow(/agentMemory read-write-if-admitted requires a writer/);
    await expect(started.byok.executions.submit({
      taskId: 'fresh-reader-read-write-if-admitted',
      deviceId: daemon.deviceId,
      payload: {
        instruction: 'read memory', target: { lane: 'runtime', runtimeId: 'codex' }, terminalProjection: { mode: 'none' }, agentRef: AGENT_REF,
        session: { mode: 'fresh' }, egressPolicy: POLICY, homeAccess: 'memory-reader', agentMemory: 'read-write-if-admitted',
      },
    })).rejects.toThrow(/agentMemory read-write-if-admitted requires a writer/);
    expect(await started.byok.tasks.attempt('reader-read-write-if-admitted')).toBeUndefined();
    expect(await started.byok.tasks.attempt('fresh-reader-read-write-if-admitted')).toBeUndefined();
    expect(await started.byok.tasks.offer('fresh-reader-read-write-if-admitted')).toBeUndefined();
  });
});
