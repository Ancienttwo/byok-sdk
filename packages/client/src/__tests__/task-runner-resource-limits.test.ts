import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import {
  DEFAULT_MAX_TASK_OUTPUT_BYTES,
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import {
  MAX_DURATION_EXCEEDED_REASON_PREFIX,
  MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX,
  ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX,
} from '../daemon/task-runner/state';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

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
  overrides: Partial<Pick<TaskRunnerDeps, 'shutdownInterruptTimeoutMs' | 'maxTaskOutputBytes' | 'batcherOptions' | 'getIngressBudget'>> = {},
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = { scratchRoot: testScratchOwner(), ...freshOfferRunnerDeps(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    // An enrolled daemon always passes its tenant; without it a closing Agent task logs a skipped memory snapshot on Linux.
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    shutdownInterruptTimeoutMs: overrides.shutdownInterruptTimeoutMs,
    maxTaskOutputBytes: overrides.maxTaskOutputBytes,
    batcherOptions: overrides.batcherOptions,
    getIngressBudget: overrides.getIngressBudget ?? testIngressBudget,
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
        { agentRef: freshTestAgentRef(),  instruction: 'x', limits: { maxDurationMs: 5000 }, ...FRESH_OFFER },
        { taskId: 'task-1', seq: 1 },
      ),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    expect(runner.activeTaskCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(session?.interruptCalled).toBe(true);
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    const fail = sent.find((e) => e.type === 'task.fail' && e.task_id === 'task-1');
    expect(fail).toBeDefined();
    expect(fail?.payload).toMatchObject({ retryable: false });
    expect((fail?.payload as { reason: string }).reason.startsWith(MAX_DURATION_EXCEEDED_REASON_PREFIX)).toBe(true);
    expect(sent.some((e) => e.type === 'task.cancelled')).toBe(false);
  });

  it('honors a maxDurationMs beyond one timer range: no early failure, fails once the real limit elapses', async () => {
    const MAX_TIMER_DELAY_MS = 2_147_483_647;
    const limitMs = 30 * 24 * 60 * 60 * 1000; // 30 days, above what a single setTimeout can hold
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(),  instruction: 'x', limits: { maxDurationMs: limitMs }, ...FRESH_OFFER },
        { taskId: 'task-long', seq: 1 },
      ),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    // An unclamped delay would have fired at 1 ms.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session?.interruptCalled).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(session?.interruptCalled).toBe(false);
    expect(runner.activeTaskCount).toBe(1);

    await vi.advanceTimersByTimeAsync(limitMs - MAX_TIMER_DELAY_MS - 1_000);
    expect(session?.interruptCalled).toBe(true);
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    const fail = sent.find((e) => e.type === 'task.fail' && e.task_id === 'task-long');
    expect((fail?.payload as { reason: string }).reason.startsWith(MAX_DURATION_EXCEEDED_REASON_PREFIX)).toBe(true);
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
        { agentRef: freshTestAgentRef(),  instruction: 'x', limits: { maxDurationMs: 1000 }, ...FRESH_OFFER },
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
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
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
        { agentRef: freshTestAgentRef(),  instruction: 'x', limits: { maxDurationMs: 5000 }, ...FRESH_OFFER },
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

    // The Agent home finish does real filesystem work before the terminal.
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-ok')).toBe(true));
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));

    await vi.advanceTimersByTimeAsync(5000);

    expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-ok')).toBe(false);
  });

  it('an offer with no limits.maxDurationMs never arms a timer at all (no fail after a long real wait)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'task-nolimit', seq: 1 }),
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
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'task-flood', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    for (let i = 0; i < 50; i++) {
      session!.emit({ type: 'progress', text: 'x'.repeat(50) });
    }

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-flood')).toBe(true);
    });

    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
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
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'task-small', seq: 1 }),
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
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'task-default-cap', seq: 1 }),
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

describe('TaskRunner: server activity ingress enforcement', () => {
  it('splits 100 KiB text and preserves the completed summary', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await runner.handleEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'text-split', seq: 1 }));
    const text = 'x'.repeat(100 * 1024);
    adapter.sessions[0]!.emit({ type: 'progress', text });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((event) => event.type === 'task.complete')).toBe(true));
    const progress = sent.filter((event) => event.type === 'task.progress');
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((event) => event.type === 'task.progress' && event.payload.sealed === undefined && Buffer.byteLength(JSON.stringify(event.payload.events)) <= 65536)).toBe(true);
    expect(progress.flatMap((event) => event.type === 'task.progress' && event.payload.sealed === undefined ? event.payload.events : []).flatMap((event) => event.type === 'progress' ? [event.text] : []).join('')).toBe(text);
    expect(sent.find((event) => event.type === 'task.complete')?.payload).toMatchObject({ summary: text });
    expect(sent.some((event) => event.type === 'task.fail')).toBe(false);
  });

  it('flushes prior valid activity, rejects the oversized event locally, and tears down once', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const validEvent = { type: 'progress' as const, text: 'valid-prefix' };
    const maxBatchBytes = new TextEncoder().encode(JSON.stringify([validEvent])).length;
    const runner = await makeRunner(adapter, sent, {
      batcherOptions: { maxBatchSize: 10, flushIntervalMs: 60_000 },
      getIngressBudget: () => ({ activityMaxEvents: 10, activityMaxBytes: maxBatchBytes }),
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'task-batch-bytes', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    session!.emit(validEvent);
    session!.emit({ type: 'error', message: 'x'.repeat(maxBatchBytes * 2) });

    await vi.waitFor(() => {
      expect(sent.some((event) => event.type === 'task.fail' && event.task_id === 'task-batch-bytes')).toBe(true);
    });

    const progress = sent.filter(
      (event) => event.type === 'task.progress' && event.task_id === 'task-batch-bytes',
    );
    expect(progress).toHaveLength(1);
    expect(progress[0]?.payload).toMatchObject({ seq: 1, events: [validEvent] });
    expect(JSON.stringify(progress)).not.toContain('x'.repeat(maxBatchBytes * 2));

    const failures = sent.filter(
      (event) => event.type === 'task.fail' && event.task_id === 'task-batch-bytes',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({ retryable: false });
    expect(
      (failures[0]?.payload as { reason: string }).reason.startsWith(
        ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX,
      ),
    ).toBe(true);
    expect(session?.interruptCalled).toBe(true);
    expect(session?.closeCalled).toBe(true);
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(diagnostic).not.toHaveBeenCalled();
    diagnostic.mockRestore();
  });
});

/**
 * Acceptance gap: `pump()`'s OWN fallback (task-runner.ts:~1374-1375) for a
 * invalid custom-adapter termination — a Session `events` iterable ending
 * with neither explicit `turn_end` nor a typed RuntimeExecutionFailure and no
 * teardown in flight. Bundled adapters translate a genuine process crash to
 * typed infrastructure/retryable before ending; TaskRunner cannot infer that
 * meaning from a custom iterable's clean end.
 */
describe('TaskRunner: clean custom Session termination', () => {
  it('reports exactly one non-retryable contract violation when the runtime session ends without terminal authority', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x', ...FRESH_OFFER }, { taskId: 'task-crash', seq: 1 }),
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
      retryable: false,
      reason: 'runtime adapter contract violation during run',
    });
    expect(sent.some((e) => e.type === 'task.decline' && e.task_id === 'task-crash')).toBe(false);
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(diagnostic).toHaveBeenCalledOnce();
    diagnostic.mockRestore();
  });
});
