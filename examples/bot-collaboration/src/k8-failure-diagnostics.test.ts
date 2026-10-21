import { openHost, template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration as RealBot } from './host';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../host-execution-core/src/test-support';
import type { BotCollaboration } from './host';
import { k8FailureSnapshot, trackFinishReceipt, withK8FailureSnapshot, type FinishReceipt } from './k8-failure-diagnostics';
afterEach(() => vi.restoreAllMocks());
function barrier() { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); return { pending, release }; }
function controlled() {
  const sessions = new Map();
  const state = { attempt: 'offered', owner: false, local: 'Offered', terminal: undefined as undefined | { envelope: { type: string } } };
  const host = { core: { intent: () => { throw new Error('wrong fixture core'); } }, adapter: { sessions },
    server: { tasks: { offer: async () => ({ type: 'task.offer_for_agent' }),
      attempt: async () => ({ status: state.attempt, ...(state.owner ? { ownerDeviceId: 'device' } : {}) }),
      deviceTerminal: async () => state.terminal } },
    daemon: { tasks: () => [{ taskId: 'exact-task', state: state.local }] } } as unknown as TestHost;
  const bot = { core: { intent: () => ({ taskId: 'exact-task' }) }, snapshot: () => ({ turns: { caller: { status: 'processing' } } }) } as unknown as BotCollaboration;
  return { host, bot, sessions, state };
}
it('distinguishes withheld start from held result RPC and receipt from semantic terminal', async () => {
  const { host, bot, sessions, state } = controlled();
  const admission = barrier(); const rpc = barrier();
  const receipt: FinishReceipt = { state: 'not-called' };
  const started = admission.pending.then(() => { sessions.set('exact-task', {}); state.attempt = 'claimed'; state.owner = true; state.local = 'Claimed'; });
  expect(await k8FailureSnapshot(host, bot, 'caller', 'session-present', receipt)).toMatchObject({
    callerId: 'caller', taskId: 'exact-task', predicate: 'session-present', sessionPresent: false, finishReceipt: 'not-called', ownerPresent: false,
  });
  admission.release(); await started;
  trackFinishReceipt(rpc.pending, receipt);
  expect(await k8FailureSnapshot(host, bot, 'caller', 'semantic-succeeded', receipt)).toMatchObject({
    sessionPresent: true, finishReceipt: 'pending', terminalType: null, attemptStatus: 'claimed',
  });
  rpc.release(); await rpc.pending;
  expect(await k8FailureSnapshot(host, bot, 'caller', 'semantic-succeeded', receipt)).toMatchObject({
    finishReceipt: 'resolved', terminalType: null, turnStatus: 'processing',
  });
});
it('collects only on failure and preserves original error if snapshot fails or stalls', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const collect = vi.fn();
  expect(await withK8FailureSnapshot(Promise.resolve(3), collect)).toBe(3);
  expect(collect).not.toHaveBeenCalled();
  const error = new Error('original assertion');
  await expect(withK8FailureSnapshot(Promise.reject(error), () => { throw new Error('private'); })).rejects.toBe(error);
  await expect(withK8FailureSnapshot(Promise.reject(error), () => new Promise(() => {}))).rejects.toBe(error);
  expect(log.mock.calls.map(call => call[1])).toEqual(['{"unavailable":"snapshot-failed"}', '{"unavailable":"snapshot-deadline"}']);
});

it('classifies real Bot preparation and withheld result injection using separate barriers', async () => {
  let bot: RealBot | undefined;
  const host = await openHost({ consume: (wake, signal) => bot!.consume(wake, signal),
    agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const base = template(host.deviceId);
  bot = new RealBot(host.server, host.ledger, { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'acceptance' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
    } }, connector: async id => ({ externalId: id }) });
  const preparation = barrier(); const injection = barrier();
  const originalPrepare = host.adapter.prepare.bind(host.adapter);
  const entered = vi.spyOn(host.adapter, 'prepare').mockImplementation(async input => { await preparation.pending; return originalPrepare(input); });
  let finishPromise: Promise<void> | undefined;
  try {
    const id = await bot.input('held-preparation', 'controlled test input');
    const receipt: FinishReceipt = { state: 'not-called' };
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const taskId = bot.core.intent(id)!.taskId;
    expect(await k8FailureSnapshot(host, bot, id, 'session-present', receipt)).toMatchObject({
      taskId, sessionPresent: false, attemptStatus: 'offered', ownerPresent: false,
      localTask: { state: 'Offered' }, finishReceipt: 'not-called',
    });
    preparation.release();
    await vi.waitFor(() => expect(host.adapter.sessions.has(taskId)).toBe(true), { timeout: 5000 });
    const session = host.adapter.sessions.get(taskId)!;
    const finish = session.finish.bind(session);
    vi.spyOn(session, 'finish').mockImplementation(async document => { await injection.pending; await finish(document); });
    finishPromise = session.finish({ confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
    trackFinishReceipt(finishPromise, receipt);
    expect(await k8FailureSnapshot(host, bot, id, 'semantic-succeeded', receipt)).toMatchObject({
      taskId, sessionPresent: true, finishReceipt: 'pending', terminalType: null,
    });
    injection.release(); await finishPromise;
    await vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
    expect(await k8FailureSnapshot(host, bot, id, 'semantic-succeeded', receipt)).toMatchObject({
      finishReceipt: 'resolved', terminalType: 'task.complete', turnStatus: 'succeeded',
    });
  } finally {
    preparation.release(); injection.release();
    try { await finishPromise; } finally { try { await bot.close(); } finally { await host.close(); } }
  }
});
