import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HostLedger,
  HostMemoryPage,
  hash,
  nextIntervalOccurrence,
  promoteOccurrence,
  recordOccurrence,
  routineCommands,
  enqueue,
  routineTemplateBinding,
  sealRoutineTemplate,
  type AgentRoutineDefinition,
  type LedgerState,
  type SealedAgentExecutionInput,
  type SealedExecutionTemplate,
  type RoutineRef,
  type ExecutionServer,
  type FrozenOffer,
} from '@byok-sdk/server/execution-core';
import { sealContent } from '@byok-sdk/core/sealed-payload';
import { openHost, template, type TestHost } from './test-support';

let host: TestHost | undefined;
afterEach(async () => { vi.useRealTimers(); await host?.close(); host = undefined; });
const intents = () => Object.values(host!.ledger.snapshot().intents);

const sealing = { scopeId: 'scope-1', epoch: 2, categories: ['task-input' as const] };
const scopeKey = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
const agentRef = { agentId: 'main', profileRevision: '1' };
const notAfter = '2099-12-31T00:00:00.000Z';

async function sealedTemplate(deviceId: string, routineRef: RoutineRef, taskSealing: SealedExecutionTemplate['payload']['sealing'] = sealing):
  Promise<SealedExecutionTemplate> {
  const { payload } = template(deviceId);
  const { instruction: _, ...plain } = payload;
  // The member seals only `['task-input']`, so another `taskSealing` is a payload that skipped `sealRoutineTemplate`.
  const sealed = await sealRoutineTemplate({ tenantId: 'product:host-core-test', scopeKey, sealing,
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` }, sender: 'A'.repeat(43), routineRef, agentRef, instruction: 'Check the watchlist.' });
  return { deviceId, payload: { ...plain, sealing: taskSealing, sealed, routineRef } };
}
const watch = { routineId: 'watch', definitionVersion: 1, notAfter };
/** Routine `watch` version 1 with a sealed template; its first slot is due at once. */
async function sealedRoutine(deviceId: string): Promise<AgentRoutineDefinition> {
  return { id: 'watch', version: 1, timeZone: 'UTC', rule: { anchorMs: Date.now() + 30, everyMs: 86_400_000 }, execution: await sealedTemplate(deviceId, watch),
    waitMs: 60_000, lateAfterMs: 1000 };
}

/**
 * The embedded server has no sealed lane, so the test adds one: `submitSealed` records the input and `tasks.offer` reads it
 * back. `declineOnce` answers the first sealed task with a busy decline, so the intent backs off and retries.
 */
function sealedLane(options: { declineOnce?: boolean } = {}) {
  const submitted: SealedAgentExecutionInput[] = [];
  let declined = !options.declineOnce;
  const wrap = (server: ExecutionServer): ExecutionServer => ({ ...server,
    executions: { ...server.executions, submitSealed: async input => {
      submitted.push(structuredClone(input));
      return {} as never;
    } },
    tasks: { ...server.tasks,
      offer: async taskId => {
        const input = submitted.find(row => row.taskId === taskId);
        return input ? { taskId, deviceId: input.deviceId, messageId: `m-${taskId}`, type: 'task.offer',
          payload: structuredClone(input.payload), recordedAt: '1', delivered: true } as FrozenOffer : server.tasks.offer(taskId);
      },
      attempt: async taskId => {
        const input = submitted.find(row => row.taskId === taskId);
        return input ? { taskId, deviceId: input.deviceId, agentRef: input.payload.agentRef, status: 'declined' } as never : server.tasks.attempt(taskId);
      },
      deviceTerminal: async taskId => {
        if (!submitted.some(row => row.taskId === taskId) || declined) return server.tasks.deviceTerminal(taskId);
        declined = true;
        return { envelope: { type: 'task.decline', task_id: taskId, payload: { code: 'agent_home_writer_busy', reason: 'busy' } } } as never;
      },
    } });
  return { submitted, wrap };
}

describe('a sealed routine on the K4 core (#953)', () => {
  it('submits the template byte for byte with its routineRef, and a retry generation reuses the same bytes', async () => {
    const lane = sealedLane({ declineOnce: true });
    host = await openHost({ wrapServer: lane.wrap });
    const routineRef = { routineId: 'watch', definitionVersion: 1, notAfter };
    const execution = await sealedTemplate(host.deviceId, routineRef);
    const definition: AgentRoutineDefinition = { id: 'watch', version: 1, timeZone: 'UTC', rule: { anchorMs: Date.now() + 30, everyMs: 86_400_000 },
      execution, waitMs: 600_000, lateAfterMs: 1000, retry: { maxAttempts: 2, delaysMs: [20], retryFailures: false } };
    await host.core.addRoutine(definition);
    await vi.waitFor(async () => { await host!.core.drain(); expect(lane.submitted).toHaveLength(2); }, { timeout: 5000 });
    const [first, retry] = lane.submitted;
    expect(first!.taskId).not.toBe(retry!.taskId);
    for (const input of [first!, retry!]) {
      expect(input.payload).toEqual(execution.payload);
      expect(input.payload).not.toHaveProperty('instruction');
    }
    const intent = Object.values(host.ledger.snapshot().intents)[0]!;
    expect(intent).toMatchObject({ generation: 1, taskId: retry!.taskId });
    expect(host.adapter.starts).toHaveLength(0);
  });

  it('refuses a routineRef of another routine or version, output sealing, a ciphertextRef template, and a sealed execution outside a routine', async () => {
    host = await openHost({ wrapServer: sealedLane().wrap });
    const base = { timeZone: 'UTC', rule: { anchorMs: Date.now() + 60_000, everyMs: 86_400_000 }, waitMs: 60_000, lateAfterMs: 1000 };
    for (const routineRef of [{ routineId: 'other', definitionVersion: 1, notAfter }, { routineId: 'watch', definitionVersion: 2, notAfter }]) {
      await expect(host.core.addRoutine({ ...base, id: 'watch', version: 1, execution: await sealedTemplate(host.deviceId, routineRef) }))
        .rejects.toThrow('routineRef names another routine version');
    }
    const inline = await sealedTemplate(host.deviceId, { routineId: 'watch', definitionVersion: 1, notAfter });
    // A template above the inline limit travels by ciphertextRef, which no task holds between occurrences.
    const large = await sealContent({ scopeKey, scope: { id: sealing.scopeId, epoch: sealing.epoch }, chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
      sender: 'A'.repeat(43), category: 'task-input', plaintext: { instruction: 'x'.repeat(300 * 1024) }, maxContentLength: 2 * 1024 * 1024,
      binding: routineTemplateBinding('product:host-core-test', { routineId: 'watch', definitionVersion: 1, notAfter }, agentRef, sealing.categories) });
    const byReference = { ...inline, payload: { ...inline.payload, sealed: { ...large.header, ciphertextRef: { blobId: 'blob-1',
      contentHash: `sha256:${'b'.repeat(64)}`, size: large.ciphertext.byteLength, contentType: 'application/octet-stream' } } } };
    await expect(host.core.addRoutine({ ...base, id: 'watch', version: 1, execution: byReference as never })).rejects.toThrow('must be inline');
    // K4 settles from the plaintext terminal, so a sealed execution never seals its output.
    const both = await sealedTemplate(host.deviceId, watch, { ...sealing, categories: ['task-input', 'task-output'] });
    await expect(host.core.addRoutine({ ...base, id: 'watch', version: 1, execution: both })).rejects.toThrow('A sealed execution seals task-input only');
    // An output-only sealing has no template, so it cannot be a routine template occurrence either.
    const { sealed: _sealed, routineRef: _ref, ...outputOnly } = inline.payload;
    const output = { ...inline, payload: { ...outputOnly, instruction: 'plain', sealing: { ...sealing, categories: ['task-output'] } } };
    await expect(host.core.addRoutine({ ...base, id: 'watch', version: 1, execution: output as never }))
      .rejects.toThrow('A sealed execution must be a routine template occurrence');
    // A task-bound ciphertext names one task id, so a retry generation could not open it: only a routine template runs.
    const { routineRef: _, ...unbound } = inline.payload;
    for (const execution of [inline, { ...inline, payload: unbound }]) {
      await expect(host.core.enqueue({ key: 'bot-turn', source: 'bot', execution: execution as never, waitUntil: Date.now() + 60_000 }))
        .rejects.toThrow('A sealed execution must be a routine template occurrence');
    }
    expect(Object.keys(host.ledger.snapshot().routines)).toEqual([]);
  });

  it('enqueues no sealed execution outside a routine occurrence, even one labelled routine with the right routineRef', async () => {
    host = await openHost({ wrapServer: sealedLane().wrap });
    const execution = await sealedTemplate(host.deviceId, watch);
    const input = { key: 'occurrence:forged', source: 'routine' as const, execution: execution as never, waitUntil: Date.now() + 60_000 };
    await expect(host.core.enqueue(input)).rejects.toThrow('A sealed execution must be a routine template occurrence');
    const state = host.ledger.snapshot();
    expect(() => enqueue(state, host!.ledger.tenant, input)).toThrow('A sealed execution must be a routine template occurrence');
    expect(state.intents).toEqual({});
    expect(host.ledger.snapshot().intents).toEqual({});
  });

  it('calls the server submitSealed as a method of its executions', async () => {
    const submitted: SealedAgentExecutionInput[] = [];
    const lane = sealedLane();
    host = await openHost({ wrapServer: server => {
      const wrapped = lane.wrap(server);
      const executions = { ...wrapped.executions, async submitSealed(input: SealedAgentExecutionInput) {
        if (this !== executions) throw new Error('unbound submitSealed');
        submitted.push(input);
        return wrapped.executions.submitSealed!(input);
      } };
      return { ...wrapped, executions };
    } });
    await host.core.addRoutine(await sealedRoutine(host.deviceId));
    await vi.waitFor(async () => { await host!.core.drain(); expect(submitted).toHaveLength(1); }, { timeout: 5000 });
    expect(Object.values(host.ledger.snapshot().executions)[0]).toMatchObject({ submission: 'delivered' });
  });

  it('refuses the reconcile resubmit of an uncertain sealed intent before its readback once the sealed lane is gone', async () => {
    const calls = { submitSealed: 0, offer: 0, deviceTerminal: 0 };
    let executions: ExecutionServer['executions'] | undefined;
    host = await openHost({ wrapServer: server => {
      executions = { ...server.executions, submitSealed: async () => { calls.submitSealed++; throw new Error('lost response'); } };
      return { ...server, executions, tasks: { ...server.tasks,
        offer: async taskId => { calls.offer++; return server.tasks.offer(taskId); },
        deviceTerminal: async taskId => { calls.deviceTerminal++; return server.tasks.deviceTerminal(taskId); } } };
    } });
    await host.core.addRoutine(await sealedRoutine(host.deviceId));
    await vi.waitFor(async () => { await host!.core.drain(); expect(calls.submitSealed).toBeGreaterThan(0); }, { timeout: 5000 });
    expect(intents()[0]).toMatchObject({ phase: 'inflight' });
    expect(Object.values(host.ledger.snapshot().executions)[0]).toMatchObject({ submission: 'uncertain' });
    delete executions!.submitSealed;
    const sent = calls.submitSealed;
    await host.core.drain();
    Object.assign(calls, { offer: 0, deviceTerminal: 0 });
    await host.core.drain(); await host.core.drain();
    // Each reconcile pass reads the offer once, to verify the frozen input, and stops before the submit readback.
    expect(calls.deviceTerminal).toBeGreaterThan(0);
    expect(calls.offer).toBe(calls.deviceTerminal);
    expect(calls.submitSealed).toBe(sent);
    expect(host.ledger.snapshot().outbox[`intent:${intents()[0]!.id}`]?.lastError).toContain('This Host has no sealed dispatch');
  });

  it('fails a sealed occurrence before any submit on a server with no sealed lane', async () => {
    host = await openHost();
    await host.core.addRoutine(await sealedRoutine(host.deviceId));
    await vi.waitFor(async () => { await host!.core.drain(); expect(intents()[0]).toMatchObject({ conclusion: 'failed', preparationError: 'sealed_dispatch_unavailable' }); },
      { timeout: 5000 });
    expect(await host.server.tasks.offer(intents()[0]!.taskId)).toBeUndefined();
  });

  it('fails a sealed occurrence with memory on, and writes no instruction next to the sealed one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sealed-memory-'));
    const ledger = new HostLedger(path.join(root, 'ledger.sqlite'), 'product:host-core-test');
    try {
      const page = new HostMemoryPage(ledger, { now: () => Date.now(), isCurrent: () => true, notify: async () => {}, authorizeProjection: () => true });
      const lane = sealedLane();
      host = await openHost({ memory: page, wrapServer: lane.wrap });
      await host.core.addRoutine(await sealedRoutine(host.deviceId));
      await vi.waitFor(async () => { await host!.core.drain(); expect(intents()[0]).toMatchObject({ conclusion: 'failed',
        preparationError: 'A sealed execution takes no Host memory ContextPack' }); }, { timeout: 5000 });
      expect(lane.submitted).toEqual([]);
      const { input } = Object.values(host.ledger.snapshot().executions)[0]!;
      expect(input.payload).not.toHaveProperty('instruction');
    } finally {
      await host?.close(); host = undefined;
      ledger.close(); await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a promoted sealed occurrence (#953)', () => {
  const now = 1_000_000;
  const refs = { previous: { routineId: 'watch', definitionVersion: 2, notAfter }, other: { routineId: 'other', definitionVersion: 3, notAfter },
    own: { routineId: 'watch', definitionVersion: 3, notAfter } };
  const templates = new Map<RoutineRef, SealedExecutionTemplate>();
  beforeAll(async () => { for (const ref of Object.values(refs)) templates.set(ref, await sealedTemplate('device-1', ref)); });
  /** An open `hostOccurrence` occurrence of routine `watch` version 3. */
  function occurrence() {
    const state: LedgerState = { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {}, occurrences: {}, slots: {},
      outbox: {}, applied: {}, application: {}, scanWake: null };
    const commands = routineCommands(state, { now: () => now, nextTime: nextIntervalOccurrence, hostJobs: new Map(), occurrenceHooks: new Map([['bot', () => {}]]) });
    commands.create({ id: 'watch', version: 3, timeZone: 'UTC', rule: { anchorMs: now + 10, everyMs: 86_400_000 }, waitMs: 60_000, lateAfterMs: 1000,
      hostOccurrence: { type: 'bot', input: null } });
    const next = state.routines[hash('watch')]!.next!;
    const recorded = recordOccurrence(state, 'product:host-core-test', { wakeId: 'w', dedupKey: next.dedupKey, availableAt: next.availableAt,
      deliveredAt: next.availableAt, delivery: 1 }, next.availableAt, nextIntervalOccurrence)!;
    return { state, key: recorded.key };
  }

  it('takes a template sealed for its own routine version only', () => {
    for (const ref of [refs.previous, refs.other]) {
      const { state, key } = occurrence();
      expect(() => promoteOccurrence(state, 'product:host-core-test', key, structuredClone(templates.get(ref)!))).toThrow('routineRef names another routine version');
      expect(state.intents).toEqual({});
    }
    const { state, key } = occurrence();
    const intent = promoteOccurrence(state, 'product:host-core-test', key, structuredClone(templates.get(refs.own)!));
    expect(intent.execution.payload).toMatchObject({ routineRef: refs.own });
  });
});
