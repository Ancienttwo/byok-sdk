import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ByokServerEvent } from '@byok/server';
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
 * a REAL `@byok/server` and a REAL `@byok/client` daemon, wired together over
 * a real WS connection (not the lightweight `TestServer`/hand-rolled fake
 * this package's other approval tests use, and not a manually-crafted
 * server-side envelope the way `hub-approval-resolved.test.ts` exercises the
 * server in isolation) — because this specific scenario's whole point is
 * proving the REAL capability negotiation (the real server actually
 * advertises `approval_resolved` in its real `conn.ack`; the real daemon
 * actually reads it back via `ConnectionManager.getServerCapabilities`) and
 * the REAL local-CLI-equivalent resolve path (`approvals.resolve` over the
 * real control socket) produce the correct real-server state progression:
 * local CLI approve -> task.approval_resolved observed at the server ->
 * record Running BEFORE any progress arrives -> task completes -> record
 * Complete, with the pre-existing implicit-resume path never firing for
 * this resolution (see `hub.ts`'s `onApprovalResolved`/
 * `resumeIfImplicitlyApproved` doc comments for why the two can't both fire).
 */
describe('M4 (additive-minor) end-to-end: local CLI approve -> task.approval_resolved -> real server state', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('local approvals.resolve over the real control socket reaches the real server as task.approval_resolved BEFORE any progress, moves the record straight to Running, and the task completes without the implicit-resume path ever firing', async () => {
    real = await startRealServer({ productId: 'test-product' });

    const workspaceRoot = await tmpDir('byok-e2e-approval-resolved-workspace-');
    const storeDir = await tmpDir('byok-e2e-approval-resolved-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
    );

    const pairing = real.byok.pairing.createPairingCode();
    await daemon.pair(pairing.code);
    await daemon.start();
    expect(daemon.status().connected).toBe(true);

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
    expect(real.byok.tasks.get(taskId)?.state).toBe('Running');

    // The stubbed runtime continues on its own after being unblocked and
    // finishes its turn normally.
    adapter.sessions[0]!.emit({ type: 'progress', text: 'finishing up' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
    expect(real.byok.tasks.get(taskId)?.state).toBe('Complete');

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
  });
});
