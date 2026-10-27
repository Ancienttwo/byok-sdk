/**
 * A `task.offer` field this daemon's protocol build does not know (#925 stage
 * 2, Q4): a sender that forgot to gate a new field reaches an older daemon.
 * Both offer branches are strict, so the daemon refuses the offer instead of
 * stripping the field and running the rest. Like a malformed known-type entry
 * (`unknown-message-type-tolerance.test.ts`, finding R1), the cursor stays
 * before it until a corrected offer at the same seq is processed.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { testScratchRoot } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const roots: string[] = [];
let server: TestServer | undefined;
let daemon: Daemon | undefined;

async function tmpDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('task.offer with a field this build does not know', () => {
  it('is never claimed or run, stalls the cursor, and the corrected offer at the same seq runs and moves it', async () => {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-offer-future-gate-store-');
    const hostStorageRoot = await tmpDir('byok-offer-future-gate-home-');
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(
      {
        storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-offer-future-gate' },
        productName: 'Offer future gate test',
        productId: 'offer-future-gate-test',
        serverUrl: server.url,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [adapter],
    );
    const { deviceId } = await daemon.pair('offer-future-gate-pair-code');
    await daemon.start();
    await server.waitFor((envelope) => envelope.type === 'conn.hello');

    const taskId = 'offer-future-gate';
    const seq = server.nextSeq();
    const payload = {
      agentRef: { agentId: 'future-gate-agent', profileRevision: 'profile-r1' },
      session: { mode: 'fresh' },
      instruction: 'run only what this daemon understands',
      runtime: 'pi',
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    } as const;
    server.pushRawLongPollEvent({
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'task.offer',
      task_id: taskId,
      seq,
      payload: { ...payload, futureGate: { mode: 'required' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.received.some((envelope) => envelope.task_id === taskId)).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
    expect(adapter.preparedStartCalls).toHaveLength(0);
    // No cursor was written yet: nothing before this offer, and the offer itself is not acknowledged.
    expect(await new CursorStore(storeDir).load(server.url, deviceId)).toBeUndefined();

    server.send(createEnvelope('task.offer', payload, { taskId, seq }));
    await server.waitFor((envelope) => envelope.type === 'task.claim' && envelope.task_id === taskId);
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId);
    expect(adapter.startCalls).toHaveLength(1);
    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server!.url, deviceId)).toBe(seq));
  });
});
