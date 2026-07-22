import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import {
  DEFAULT_MAX_TASK_OUTPUT_BYTES,
  MAX_DURATION_EXCEEDED_REASON_PREFIX,
  MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX,
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * M5 batch-3 (workstream 2): `TaskRunner`'s two local resource-limit
 * enforcers, driven directly (not through a full daemon/control socket) —
 * mirrors `task-runner-shutdown.test.ts`'s own convention for exercising
 * `TaskRunner` on its own:
 *
 *  - `payload.limits.maxDurationMs` — daemon-authoritative wall-clock
 *    enforcement (`armMaxDurationTimer`). Previously accepted and silently
 *    ignored (see `task-runner-admission-limits.test.ts`'s own "does NOT
 *    decline when only limits.maxDurationMs is set" test, M5 batch-3
 *    workstream 1) — now hard-enforced.
 *  - `DaemonConfig.maxTaskOutputBytes` — local output-byte cap, counted per
 *    normalized `AgentEvent` as it flows through `TaskRunner.pump`.
 *
 * Both funnel through the SAME shared teardown `shutdownActiveTasks` already
 * uses (`teardownActiveTask`) — `retryable: false` and a stable, documented
 * reason prefix distinguish them from a graceful-shutdown `task.fail`
 * (`retryable: true`, `daemon shutting down: ...`).
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  overrides: Partial<Pick<TaskRunnerDeps, 'shutdownInterruptTimeoutMs' | 'maxTaskOutputBytes'>> = {},
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-limits-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-limits-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    shutdownInterruptTimeoutMs: overrides.shutdownInterruptTimeoutMs,
    maxTaskOutputBytes: overrides.maxTaskOutputBytes,
  };
  return new TaskRunner(deps);
}

describe('TaskRunner: maxDurationMs wall-clock enforcement (M5 batch-3, workstream 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('interrupts the session and reports task.fail (retryable:false, stable reason prefix) once maxDurationMs elapses', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, limits: { maxDurationMs: 5000 } },
        { taskId: 'task-1', seq: 1 },
      ),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    expect(runner.activeTaskCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(session?.interruptCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    const fail = sent.find((e) => e.type === 'task.fail' && e.task_id === 'task-1');
    expect(fail).toBeDefined();
    expect(fail?.payload).toMatchObject({ retryable: false });
    expect((fail?.payload as { reason: string }).reason.startsWith(MAX_DURATION_EXCEEDED_REASON_PREFIX)).toBe(true);
    expect(sent.some((e) => e.type === 'task.cancelled')).toBe(false);
  });

  it('escalates to a hard kill (session.close()) when interrupt() itself hangs past the grace window', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    // Short override so this test doesn't depend on the real 5s default —
    // proves the escalation is bounded, not any particular duration.
    const runner = await makeRunner(adapter, sent, { shutdownInterruptTimeoutMs: 20 });

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, limits: { maxDurationMs: 1000 } },
        { taskId: 'task-hang', seq: 1 },
      ),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    // Never resolves, never rejects — the "misbehaving adapter" shape the
    // hard-kill escalation exists for.
    session!.interrupt = () => new Promise<void>(() => {});
    expect(session!.closeCalled).toBe(false);

    // Wall clock fires at 1000ms; the interrupt race then needs its own 20ms
    // grace window to elapse before escalating.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20); // margin for the hard-kill's own close() to settle

    expect(session?.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    const fail = sent.find((e) => e.type === 'task.fail' && e.task_id === 'task-hang');
    expect(fail).toBeDefined();
    expect(fail?.payload).toMatchObject({ retryable: false });
    expect((fail?.payload as { reason: string }).reason.startsWith(MAX_DURATION_EXCEEDED_REASON_PREFIX)).toBe(true);
  });

  it('is cleared on normal completion — no stray task.fail arrives once maxDurationMs would otherwise have elapsed', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, limits: { maxDurationMs: 5000 } },
        { taskId: 'task-ok', seq: 1 },
      ),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    session!.emit({ type: 'turn_end' });
    // Flush the pump()/finish() promise chain triggered by that event
    // (timer-clearing happens inside finish()) before advancing past the
    // configured limit.
    await vi.advanceTimersByTimeAsync(0);

    expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-ok')).toBe(true);
    expect(runner.activeTaskCount).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);

    expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-ok')).toBe(false);
  });

  it('an offer with no limits.maxDurationMs never arms a timer at all (no fail after a long real wait)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-nolimit', seq: 1 }),
    );
    expect(runner.activeTaskCount).toBe(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // 24h — nothing should ever fire

    expect(sent.some((e) => e.type === 'task.fail')).toBe(false);
    expect(runner.activeTaskCount).toBe(1);
  });
});

describe('TaskRunner: maxTaskOutputBytes enforcement (M5 batch-3, workstream 2)', () => {
  it('tears the task down (retryable:false, stable reason prefix) once accumulated output exceeds the configured cap', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, { maxTaskOutputBytes: 200 });

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-flood', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    for (let i = 0; i < 50; i++) {
      session!.emit({ type: 'progress', text: 'x'.repeat(50) });
    }

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-flood')).toBe(true);
    });

    expect(runner.activeTaskCount).toBe(0);
    const fail = sent.find((e) => e.type === 'task.fail' && e.task_id === 'task-flood');
    expect(fail?.payload).toMatchObject({ retryable: false });
    expect((fail?.payload as { reason: string }).reason.startsWith(MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX)).toBe(true);
    expect(session?.interruptCalled).toBe(true);
  });

  it('leaves an under-cap task unaffected — no fail, task completes normally', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, { maxTaskOutputBytes: 1_000_000 });

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-small', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    session!.emit({ type: 'progress', text: 'hello' });
    session!.emit({ type: 'turn_end' });

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-small')).toBe(true);
    });
    expect(sent.some((e) => e.type === 'task.fail')).toBe(false);
  });

  it('defaults to DEFAULT_MAX_TASK_OUTPUT_BYTES (64 MiB) when unset — an ordinary task stays far under it', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent); // no override — exercises the real default

    expect(DEFAULT_MAX_TASK_OUTPUT_BYTES).toBe(64 * 1024 * 1024);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-default-cap', seq: 1 }),
    );
    const session = adapter.sessions[0];
    session!.emit({ type: 'progress', text: 'a small amount of output' });
    session!.emit({ type: 'turn_end' });

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-default-cap')).toBe(true);
    });
    expect(sent.some((e) => e.type === 'task.fail')).toBe(false);
  });
});

/**
 * Acceptance gap: `pump()`'s OWN fallback (task-runner.ts:~1374-1375) for a
 * genuine mid-task crash — the runtime session's `events` iterable ending
 * with no explicit `turn_end` AND no teardown of any kind in flight
 * (`active.beingTornDown` never set). Unlike this file's two describe blocks
 * above, nothing here is limit-triggered: no `maxDurationMs`, no
 * `maxTaskOutputBytes` override — this is the plain "the underlying CLI
 * process just died" case, using `StubSession.endAbruptly()` (ends the event
 * queue with no `turn_end`, mirroring an unexpected exit) to reach it
 * deterministically instead of depending on a real adapter crashing.
 */
describe("TaskRunner: genuine mid-task crash detection (pump's own fallback)", () => {
  it('reports exactly one retryable task.fail with the fixed reason when the runtime session ends abruptly with no teardown in flight', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-crash', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    expect(runner.activeTaskCount).toBe(1);

    session!.endAbruptly();

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-crash')).toBe(true);
    });

    const fails = sent.filter((e) => e.type === 'task.fail' && e.task_id === 'task-crash');
    expect(fails).toHaveLength(1);
    expect(fails[0]?.payload).toMatchObject({
      retryable: true,
      reason: 'runtime session ended without completing the task',
    });
    expect(sent.some((e) => e.type === 'task.decline' && e.task_id === 'task-crash')).toBe(false);
    expect(runner.activeTaskCount).toBe(0);
  });
});
