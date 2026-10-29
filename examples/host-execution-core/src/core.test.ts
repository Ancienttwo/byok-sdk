import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RuntimeExecutionFailure } from '@byok-sdk/client';
import type { CreateByokServerOptions } from '@byok-sdk/server';
import { hash, taskId } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from './test-support';

let host: TestHost;
afterEach(async () => { await host?.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function running(key: string) {
  await vi.waitFor(() => expect(host.adapter.sessions.has(host.core.intent(key)!.taskId)).toBe(true), { timeout: 5000 });
  return host.adapter.sessions.get(host.core.intent(key)!.taskId)!;
}
async function settled(key: string, conclusion = 'succeeded') {
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(key)?.conclusion).toBe(conclusion); }, { timeout: 5000 });
}

it('runs a routine through wake, daemon, submit_result, terminal and the atomic result outbox', async () => {
  host = await openHost({ applyOutcome: (document, tx) => { tx.application.result = document as { text: string }; } });
  await host.core.addRoutine(host.routine('daily'));
  await vi.waitFor(() => expect(Object.values(host.ledger.snapshot().occurrences)).toHaveLength(1));
  const occurrence = Object.values(host.ledger.snapshot().occurrences)[0]!;
  const intent = host.ledger.snapshot().intents[occurrence.intentId!]!;
  (await running(intent.key)).finish({ text: 'routine result' });
  await settled(intent.key);
  expect(host.ledger.snapshot().application.result).toEqual({ text: 'routine result' });
  expect(host.ledger.snapshot().occurrences[occurrence.key]).toMatchObject({ attempts: 1, conclusion: 'succeeded' });
  expect(Object.keys(host.ledger.snapshot().applied)).toEqual([taskId(intent.key, 0)]);
  const projections: string[] = [];
  await host.core.flushProjections(async id => { projections.push(id); throw new Error('upload response lost'); });
  expect(Object.values(host.ledger.snapshot().outbox).filter(row => row.kind === 'projection')).toHaveLength(1);
  await host.restartCore();
  await host.core.flushProjections(async id => { projections.push(id); });
  expect(projections).toEqual([`intent:${intent.key}`, `intent:${intent.key}`]);
  expect(Object.values(host.ledger.snapshot().outbox).filter(row => row.kind === 'projection')).toEqual([]);
});

it('uses one FIFO for routine, Bot and user triggers, independent of profile revision', async () => {
  host = await openHost();
  await host.core.addRoutine(host.routine('first'));
  await vi.waitFor(() => expect(Object.keys(host.ledger.snapshot().occurrences)).toHaveLength(1));
  const first = Object.values(host.ledger.snapshot().intents)[0]!;
  const firstSession = await running(first.key);
  const bot = await host.core.enqueue(host.intent('bot'));
  const user = await host.core.enqueue(host.intent('user', { source: 'user', execution: {
    ...template(host.deviceId), payload: { ...template(host.deviceId).payload, agentRef: { agentId: 'main', profileRevision: '2' } },
  } }));
  expect(await host.server.tasks.offer(bot.taskId)).toBeUndefined();
  expect(await host.server.tasks.offer(user.taskId)).toBeUndefined();
  firstSession.finish({ text: 'first' }); await settled(first.key);
  (await running('bot')).finish({ text: 'second' }); await settled('bot');
  (await running('user')).finish({ text: 'third' }); await settled('user');
  expect(host.adapter.starts.map(start => start.manifest.taskId)).toEqual([first.taskId, bot.taskId, user.taskId]);
});

it('accepts one Bot chat turn through messageEgress and settles it through the routine FIFO and outcome transaction', async () => {
  const received: Array<Parameters<NonNullable<CreateByokServerOptions['agentMessage']>['consume']>[0]> = [];
  let accept!: () => void;
  const decision = new Promise<void>(resolve => { accept = resolve; });
  host = await openHost({
    agentMessage: { consume: async input => { received.push(input); await decision; return host.core.consumeMessage(input); } },
    applyMessage: (input, tx) => { tx.publish(`reply:${input.taskId}`, input.payload.body); return { outcome: 'accepted' }; },
    applyOutcome: (document, tx) => {
      tx.application[tx.intent.taskId] = { source: tx.intent.source, document: document as { text: string },
        terminal: tx.terminal.envelope.type };
      tx.application.count = Number(tx.application.count ?? 0) + 1;
      tx.publish(`outcome:${tx.intent.taskId}`, { source: tx.intent.source });
    },
  });
  try {
    const submit = vi.spyOn(host.server.executions, 'submit'); // Call through to the real embedded server.
    await host.core.addRoutine(host.routine('before-chat'));
    await vi.waitFor(() => expect(Object.keys(host.ledger.snapshot().occurrences)).toHaveLength(1));
    const routine = Object.values(host.ledger.snapshot().intents)[0]!;
    const routineSession = await running(routine.key);
    const execution = template(host.deviceId);
    const chat = await host.core.enqueue(host.intent('chat-turn', { source: 'bot', execution: {
      ...execution, payload: { ...execution.payload, instruction: 'Reply to this chat turn and submit its result.',
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn-1' },
    } }));
    expect(chat.source).toBe('bot');
    expect(await host.server.tasks.offer(chat.taskId)).toBeUndefined();
    expect(host.adapter.starts.map(start => start.manifest.taskId)).toEqual([routine.taskId]);
    routineSession.finish({ text: 'routine result' }); await settled(routine.key);

    const reply = { text: 'Hello from the Bot.' };
    (await running(chat.key)).finish(reply);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const message = received[0]!;
    const body = JSON.stringify(reply);
    expect(message).toMatchObject({ tenant: 'product:host-core-test', taskId: chat.taskId, deviceId: host.deviceId,
      context: { destinationBinding: 'conversation', freshnessCursor: 'turn-1' },
      payload: { agentRef: execution.payload.agentRef, contentType: 'text/markdown', body,
        byteCount: Buffer.byteLength(body), contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}` },
    });
    expect(await host.server.tasks.messageDisposition(chat.taskId, host.deviceId, message.payload)).toBeUndefined();
    expect(await host.server.tasks.deviceTerminal(chat.taskId)).toBeUndefined();
    expect(host.ledger.snapshot().applied[chat.taskId]).toBeUndefined();
    accept();
    await vi.waitFor(async () => expect(await host.server.tasks.messageDisposition(chat.taskId, host.deviceId, message.payload))
      .toMatchObject({ outcome: 'accepted' }));
    await vi.waitFor(async () => expect(await host.server.tasks.deviceTerminal(chat.taskId))
      .toMatchObject({ envelope: { type: 'task.complete', payload: { document: reply } } }));
    await settled(chat.key);
    expect(host.ledger.snapshot().executions[chat.taskId]!.terminal).toEqual(await host.server.tasks.deviceTerminal(chat.taskId));
    expect(submit.mock.calls.map(([input]) => input.taskId)).toEqual([routine.taskId, chat.taskId]);
    expect(host.adapter.starts.map(start => start.manifest.taskId)).toEqual([routine.taskId, chat.taskId]);

    await host.restartCore(); await host.core.drain();
    const state = host.ledger.snapshot();
    expect(state.application).toEqual({ count: 2,
      [routine.taskId]: { source: 'routine', document: { text: 'routine result' }, terminal: 'task.complete' },
      [chat.taskId]: { source: 'bot', document: reply, terminal: 'task.complete' },
    });
    expect(state.applied).toEqual({ [routine.taskId]: true, [chat.taskId]: true });
    expect(Object.values(state.outbox)).toContainEqual({ kind: 'projection', id: `reply:${chat.taskId}`, value: body });
    expect(await host.core.consumeMessage(message)).toEqual({ outcome: 'accepted' });
    for (const intent of [routine, chat]) {
      expect(host.core.intent(intent.key)?.conclusion).toBe('succeeded');
      expect(Object.values(state.outbox)).toContainEqual({ kind: 'projection', id: `outcome:${intent.taskId}`, value: { source: intent.source } });
    }
    expect(await host.server.tasks.messageDisposition(chat.taskId, host.deviceId, message.payload)).toMatchObject({ outcome: 'accepted' });
  } finally { accept(); }
});

it('recovers a lost submit response with the same frozen task and no second execution', async () => {
  let lost = false;
  host = await openHost({ wrapServer: server => ({ ...server, executions: { submit: async input => {
    const result = await server.executions.submit(input);
    if (!lost) { lost = true; throw new Error('lost response'); }
    return result;
  } } }) });
  const input = host.intent('lost');
  await host.core.enqueue(input);
  await running('lost');
  await host.restartCore();
  expect(host.core.intent('lost')?.taskId).toBe(taskId('lost', 0));
  expect(host.ledger.snapshot().executions[taskId('lost', 0)]!.input).toEqual({ ...input.execution, taskId: taskId('lost', 0) });
  expect(host.adapter.starts).toHaveLength(1);
  await expect(host.core.enqueue({ ...input, execution: { ...input.execution, payload: { ...input.execution.payload, instruction: 'changed' } } })).rejects.toThrow('identity conflict');
});

it('rolls back a throwing outcome handler and commits application plus marker only once', async () => {
  let reject = true;
  host = await openHost({ applyOutcome: (_document, tx) => {
    tx.application.count = Number(tx.application.count ?? 0) + 1;
    tx.publish('business-effect', { accepted: true });
    if (reject) throw new Error('transaction rejected');
  } });
  const intent = await host.core.enqueue(host.intent('atomic'));
  (await running('atomic')).finish({ text: 'done' });
  await vi.waitFor(async () => expect(await host.server.tasks.deviceTerminal(intent.taskId)).toBeDefined());
  await host.core.drain();
  expect(host.ledger.snapshot().application.count).toBeUndefined();
  expect(host.ledger.snapshot().applied[intent.taskId]).toBeUndefined();
  expect(Object.values(host.ledger.snapshot().outbox).filter(row => row.kind === 'projection')).toEqual([]);
  reject = false;
  await host.restartCore(); await settled('atomic');
  await Promise.all([host.core.drain(), host.core.drain()]);
  expect(host.ledger.snapshot().application.count).toBe(1);
  expect(host.ledger.snapshot().applied[intent.taskId]).toBe(true);
});

it('expires an offline offer without waiting for a device terminal and releases the FIFO', async () => {
  host = await openHost(); await host.offline();
  // The offer must be submitted before it can expire. If the deadline passes before
  // submit, the core does not submit (see `submit` in core.ts) and no attempt exists.
  const expired = await host.core.enqueue(host.intent('offline', { waitUntil: Date.now() + 1_000 }));
  await settled('offline', 'expired');
  expect(await host.server.tasks.attempt(expired.taskId)).toMatchObject({ status: 'cancelled' });
  expect((await host.server.tasks.attempt(expired.taskId))?.claimedRuntime).toBeUndefined();
  expect(await host.server.tasks.deviceTerminal(expired.taskId)).toBeUndefined();
  await host.online();
  await host.core.enqueue(host.intent('after-offline'));
  await running('after-offline');
  expect(host.adapter.sessions.has(expired.taskId)).toBe(false);
});

it('keeps cancellation unsettled and never changes generation until device terminal arrives', async () => {
  let hide = true;
  host = await openHost({ wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => hide ? undefined : server.tasks.deviceTerminal(id),
  } }) });
  const intent = await host.core.enqueue(host.intent('cancel'));
  await running('cancel');
  // This case requires a durable claim before cancellation can wait for terminal.
  await vi.waitFor(async () => expect(await host.server.tasks.attempt(intent.taskId)).toMatchObject({
    ownerDeviceId: host.deviceId, claimedRuntime: 'pi',
  }), { timeout: 5000 });
  await host.core.cancel('cancel');
  await vi.waitFor(async () => expect(await host.server.tasks.deviceTerminal(intent.taskId)).toBeDefined());
  await host.core.drain();
  expect(host.core.intent('cancel')).toMatchObject({ phase: 'inflight', generation: 0 });
  expect(host.core.intent('cancel')?.conclusion).toBeUndefined();
  hide = false; await settled('cancel', 'cancelled');
  expect(host.core.intent('cancel')?.generation).toBe(0);
});

it('advances busy generations only after canonical terminal readback and respects the attempt cap', async () => {
  let hide = true;
  host = await openHost({ wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => hide && id !== 'external-writer' ? undefined : server.tasks.deviceTerminal(id),
  } }) });
  await host.server.executions.submit({ ...template(host.deviceId), taskId: 'external-writer' });
  await vi.waitFor(() => expect(host.adapter.sessions.has('external-writer')).toBe(true));
  const intent = await host.core.enqueue(host.intent('busy', { retry: { maxAttempts: 2, delaysMs: [20], retryFailures: false } }));
  await vi.waitFor(async () => expect(await host.server.tasks.deviceTerminal(intent.taskId)).toMatchObject({ envelope: { type: 'task.decline', payload: { code: 'agent_home_writer_busy' } } }));
  await host.core.drain();
  expect(host.core.intent('busy')?.generation).toBe(0);
  expect(await host.server.tasks.offer(taskId('busy', 1))).toBeUndefined();
  hide = false; await settled('busy', 'declined');
  expect(host.core.intent('busy')).toMatchObject({ generation: 1, attempts: 2 });
  expect(await host.server.tasks.offer(taskId('busy', 2))).toBeUndefined();
  expect(Object.values(host.ledger.snapshot().executions).filter(row => row.terminal)).toHaveLength(2);
});

it('settles runtime failure without a message and retries only when source policy permits it', async () => {
  host = await openHost();
  await host.core.enqueue(host.intent('failed', { retry: { maxAttempts: 1, delaysMs: [], retryFailures: false } }));
  (await running('failed')).fail(); await settled('failed', 'failed');
  expect(host.core.intent('failed')?.generation).toBe(0);
  expect(host.ledger.snapshot().outbox[`intent:${hash('failed')}`]).toBeUndefined();
});

it('retries a retryable device failure only with an explicit source policy', async () => {
  host = await openHost({ reconcileMs: 20 });
  vi.spyOn(host.adapter, 'prepare').mockResolvedValueOnce({ kind: 'prepared', operation: { start: async () => {
    throw new RuntimeExecutionFailure({ phase: 'start', category: 'infrastructure', retry: 'retryable', reason: 'fixture launch unavailable' });
  } } });
  const intent = await host.core.enqueue(host.intent('retry-failure', { retry: { maxAttempts: 2, delaysMs: [20], retryFailures: true } }));
  await vi.waitFor(() => expect(host.core.intent('retry-failure')?.generation).toBe(1), { timeout: 5000 });
  expect(await host.server.tasks.deviceTerminal(intent.taskId)).toMatchObject({ envelope: { type: 'task.fail', payload: { retryable: true } } });
  (await running('retry-failure')).finish({ text: 'recovered' });
  await settled('retry-failure');
  expect(host.core.intent('retry-failure')?.attempts).toBe(2);
});

it('does not retry an untyped decline and never parses its reason', async () => {
  host = await openHost(); host.adapter.rejectNext = true;
  await host.core.enqueue(host.intent('decline'));
  await settled('decline', 'declined');
  expect(host.core.intent('decline')?.generation).toBe(0);
  expect(await host.server.tasks.offer(taskId('decline', 1))).toBeUndefined();
});

it('accepts the deadline/claim race but holds the FIFO until the cancelled terminal', async () => {
  host = await openHost({ reconcileMs: 120_000 }); await host.offline();
  let now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const first = await host.core.enqueue(host.intent('race', { waitUntil: now + 60_000 }));
  await host.online();
  const session = await running('race');
  // Session creation is not a durable claim receipt. Keep the Host's scan after
  // this test's explicit deadline step, but observe the real SDK claim first.
  await vi.waitFor(async () => expect(await host.server.tasks.attempt(first.taskId)).toMatchObject({ claimedRuntime: 'pi' }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(session, 'interrupt').mockImplementation(async () => { session.interrupted = true; await gate; });
  try {
    now += 60_001;
    vi.setSystemTime(now);
    await host.core.drain();
    expect(await host.server.tasks.attempt(first.taskId)).toMatchObject({ status: 'cancel_requested', claimedRuntime: 'pi' });
    const second = await host.core.enqueue(host.intent('behind', { waitUntil: now + 60_000 }));
    expect(await host.server.tasks.offer(second.taskId)).toBeUndefined();
    expect(host.core.intent('race')).toMatchObject({ generation: 0, phase: 'inflight' });
    expect(host.core.intent('race')?.conclusion).toBeUndefined();
    release(); await settled('race', 'cancelled'); await running('behind');
    expect(host.core.intent('race')?.generation).toBe(0);
  } finally { release(); }
});

it('refuses mismatched immutable input even when that task later has a successful terminal', async () => {
  host = await openHost();
  const input = host.intent('conflict');
  await host.server.executions.submit({ ...input.execution, taskId: taskId(input.key, 0),
    payload: { ...input.execution.payload, instruction: 'another input' } });
  await host.core.enqueue(input);
  (await running(input.key)).finish({ text: 'wrong input result' });
  await vi.waitFor(async () => expect(await host.server.tasks.deviceTerminal(taskId(input.key, 0))).toBeDefined());
  await host.core.drain();
  expect(host.core.intent(input.key)?.conclusion).toBeUndefined();
  expect(host.ledger.snapshot().applied[taskId(input.key, 0)]).toBeUndefined();
  expect(host.ledger.snapshot().outbox[`intent:${hash(input.key)}`]).toMatchObject({ lastError: 'Offer differs from the frozen input' });
});

it('expires a queued intent behind running work without submitting its reserved input', async () => {
  host = await openHost();
  await host.core.enqueue(host.intent('head')); await running('head');
  const tail = await host.core.enqueue(host.intent('short-wait', { waitUntil: Date.now() + 100 }));
  await settled('short-wait', 'expired');
  expect(await host.server.tasks.offer(tail.taskId)).toBeUndefined();
  expect(host.core.intent('head')?.conclusion).toBeUndefined();
  expect(host.adapter.starts).toHaveLength(1);
});

it('allows separate Agent queues to execute at the same time', async () => {
  host = await openHost();
  await Promise.all([
    host.core.enqueue(host.intent('agent-a')),
    host.core.enqueue(host.intent('agent-b', { execution: template(host.deviceId, 'other-agent') })),
  ]);
  await running('agent-a'); await running('agent-b');
  expect(host.adapter.starts).toHaveLength(2);
  expect(host.core.intent('agent-a')?.conclusion).toBeUndefined();
  expect(host.core.intent('agent-b')?.conclusion).toBeUndefined();
});

it('resubmits the same frozen input after a failure before SDK admission', async () => {
  const inputs: unknown[] = [];
  host = await openHost({ wrapServer: server => ({ ...server, executions: { submit: async input => {
    inputs.push(structuredClone(input));
    if (inputs.length === 1) throw new Error('dispatch failed before admission');
    return server.executions.submit(input);
  } } }) });
  const intent = await host.core.enqueue(host.intent('before-admission'));
  expect(await host.server.tasks.offer(intent.taskId)).toBeUndefined();
  expect(host.ledger.snapshot().executions[intent.taskId]?.submission).toBe('uncertain');
  await host.restartCore(); await running(intent.key);
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(host.core.intent(intent.key)).toMatchObject({ generation: 0, attempts: 1, taskId: intent.taskId });
  expect(host.adapter.starts).toHaveLength(1);
});


it('shows the required Bot reply without applying an absent outcome', async () => {
  const received: string[] = [];
  const applyOutcome = vi.fn();
  host = await openHost({ agentMessage: { consume: async ({ payload }) => { received.push(payload.body); return { outcome: 'accepted' }; } }, applyOutcome });
  const execution = template(host.deviceId);
  const intent = await host.core.enqueue(host.intent('missing-chat-outcome', { execution: {
    ...execution, payload: { ...execution.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
    }, agentMessageContext: { destinationBinding: 'conversation' },
  } }));
  const reply = { text: 'Visible reply; no action was requested.' };
  (await running(intent.key)).finish(reply, false);
  await settled(intent.key, 'failed');
  expect(received).toEqual([JSON.stringify(reply)]);
  expect(applyOutcome).not.toHaveBeenCalled();
  expect(await host.server.tasks.deviceTerminal(intent.taskId)).toMatchObject({ envelope: {
    type: 'task.fail', payload: { retryable: false, reason: expect.stringMatching(/^result_not_submitted:/) },
  } });
  expect((await host.server.tasks.deviceTerminal(intent.taskId))!.envelope.payload).not.toHaveProperty('document');
  expect(await host.server.tasks.agentMessage(intent.taskId, host.deviceId, execution.payload.agentRef)).toMatchObject({ disposition: { outcome: 'accepted' } });
});
