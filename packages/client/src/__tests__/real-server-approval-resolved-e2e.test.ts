import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ByokServerEvent } from '@byok-sdk/server';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { connectControlClient } from '../daemon/control-client';
import type { ApprovalsListResult, ApprovalsRequestResult } from '../daemon/control-protocol';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServer, waitForTaskState, type RealServerHandle } from './fixtures/real-server';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForServerEvent(
  byok: RealServerHandle['byok'],
  predicate: (e: ByokServerEvent) => boolean,
): Promise<ByokServerEvent> {
  for await (const event of byok.events.subscribe()) {
    if (predicate(event)) return event;
  }
  throw new Error('server event stream ended before a matching event was seen');
}

/**
 * The full end-to-end pass of `task.approval_resolved` — a REAL
 * `@byok-sdk/server` and a REAL `@byok-sdk/client` daemon: the
 * local-CLI-equivalent resolve path (`approvals.resolve` over the real
 * control socket) produces the correct real-server state progression: local
 * CLI approve -> task.approval_resolved observed at the server -> record
 * Running BEFORE any progress arrives -> task completes -> record Complete.
 * Wire v4 sends the report unconditionally, and only a daemon report
 * resolves an approval.
 */
describe('M4 (additive-minor) end-to-end: local CLI approve -> task.approval_resolved -> real server state', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('local approvals.resolve over the real control socket reaches the real server as task.approval_resolved BEFORE any progress, moves the record straight to Running, and the task completes', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const storeDir = await tmpDir('byok-e2e-approval-resolved-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
      {
        longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const taskId = 'task-approval-resolved';
    await real.byok.executions.submit({
      taskId,
      deviceId: record.deviceId,
      payload: {
        session: { mode: 'fresh' },
        instruction: 'do a thing that needs approval',
        runtime: 'pi',
        agentRef: { agentId: 'agent-approval-resolved', profileRevision: 'rev-1' },
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
      },
    });

    await waitForTaskState(real, taskId, 'Running'); // Claimed -> Running (task.claim + task.started)

    const conn = await connectControlClient({ storeDir, productId: 'test-product' });
    if (!conn.ok) throw new Error('expected reachable control socket');

    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: rm -rf /tmp/whatever',
    });

    await waitForTaskState(real, taskId, 'AwaitApproval');

    // The local CLI's own action — a SEPARATE control-socket connection,
    // exactly like a real `byok-agent approve` invocation, mirroring
    // `confirm-mode-approval-e2e.test.ts`'s own convention for this.
    const cliConn = await connectControlClient({ storeDir, productId: 'test-product' });
    if (!cliConn.ok) throw new Error('expected reachable control socket');
    const list = await cliConn.client.request<ApprovalsListResult>('approvals.list');
    expect(list.approvals).toHaveLength(1);
    const approvalId = list.approvals[0]!.approvalId;
    await cliConn.client.request('approvals.resolve', { approvalId, decision: 'approve' });

    const outcome = await requestPromise;
    expect(outcome).toEqual({ approved: true, reason: undefined });

    // The server observed the wire report and moved straight to Running from
    // it — proven by the task.approval_resolved embedder event, BEFORE any
    // progress was ever sent for this task.
    const resolvedEvent = await waitForServerEvent(
      real.byok,
      (e) => e.kind === 'task.approval_resolved' && e.taskId === taskId,
    );
    if (resolvedEvent.kind !== 'task.approval_resolved') throw new Error('unreachable');
    expect(resolvedEvent.approvalId).toBe(approvalId);
    expect(resolvedEvent.decision).toBe('approve');
    expect(resolvedEvent.resolvedBy).toBe('local');
    expect((await real.byok.tasks.get(taskId))?.state).toBe('Running');

    // The stubbed runtime continues on its own after being unblocked and
    // finishes its turn normally.
    adapter.sessions[0]!.emit({ type: 'progress', text: 'finishing up' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await waitForTaskState(real, taskId, 'Complete');
    expect((await real.byok.tasks.get(taskId))?.result?.state).toBe('Complete');

    conn.client.close();
    cliConn.client.close();
  }, 15000);
});
