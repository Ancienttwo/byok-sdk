import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ByokServerEvent } from '@byok-sdk/server';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { connectControlClient } from '../bin/control-client';
import type { ApprovalsListResult, ApprovalsRequestResult } from '../daemon/control-protocol';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServer, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

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
 * M4 (additive-minor, `task.approval_resolved`): the full end-to-end pass —
 * a REAL `@byok-sdk/server` and a REAL `@byok-sdk/client` daemon — because
 * this specific scenario's whole point is proving the REAL capability
 * negotiation (the real server actually advertises `approval_resolved`; the
 * real daemon actually reads it back via
 * `ConnectionManager.getServerCapabilities`) and the REAL
 * local-CLI-equivalent resolve path (`approvals.resolve` over the real
 * control socket) produce the correct real-server state progression: local
 * CLI approve -> task.approval_resolved observed at the server -> record
 * Running BEFORE any progress arrives -> task completes -> record Complete,
 * with the pre-existing implicit-resume path never firing for this
 * resolution (the two are mutually exclusive: whichever mechanism the server
 * processes first clears the pending slot on the approval timeline).
 *
 * WP3B Step 2: the transport is long-poll (the real server serves no WS
 * upgrade any more), which is where the capability advertisement now comes
 * from — each successful `GET /byok/events` response carries it — rather than
 * from a WS `conn.ack`. The body below is the long-poll rewrite.
 */
describe('M4 (additive-minor) end-to-end: local CLI approve -> task.approval_resolved -> real server state', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  // 2d-client-followup: the kernel now advertises `approval_resolved`
  // (`CLOUD_PROTOCOL_CAPABILITIES`, `packages/cloud/src/handlers/events.ts:35`),
  // which is the flag `TaskRunner.sendApprovalResolved`
  // (`packages/client/src/daemon/task-runner.ts:3319`) gates on, so the REAL
  // negotiation this case exists to prove now happens over long-poll: the
  // advertisement rides each `GET /byok/events` response instead of a WS
  // `conn.ack`. Un-skipped.
  it('local approvals.resolve over the real control socket reaches the real server as task.approval_resolved BEFORE any progress, moves the record straight to Running, and the task completes without the implicit-resume path ever firing', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-approval-resolved-workspace-');
    const storeDir = await tmpDir('byok-e2e-approval-resolved-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
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

    const handle = await real.byok.dispatch({
      instruction: 'do a thing that needs approval',
      policy: { mode: 'confirm' },
    });
    const taskId = handle.taskId;

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running'); // Claimed -> Running (task.claim + task.started)

    const conn = await connectControlClient({ storeDir, productId: 'test-product' });
    if (!conn.ok) throw new Error('expected reachable control socket');

    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: rm -rf /tmp/whatever',
    });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'AwaitApproval');

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

    // The server observed the EXPLICIT wire report and moved straight to
    // Running from it — proven by the dedicated task.approval_resolved
    // embedder event (not the implicit-inference one), BEFORE any progress
    // was ever sent for this task.
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

    const result = await handle.result();
    expect(result.state).toBe('Complete');
    expect((await real.byok.tasks.get(taskId))?.state).toBe('Complete');

    // The pre-existing implicit-resume path must never have fired for this
    // task — the explicit report already moved it out of AwaitApproval
    // before any task.progress/task.complete ever arrived to trigger it.
    const implicitFired = await Promise.race([
      waitForServerEvent(real.byok, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === taskId).then(
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(implicitFired).toBe(false);

    conn.client.close();
    cliConn.client.close();
  }, 15000);
});
