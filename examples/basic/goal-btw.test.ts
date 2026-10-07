import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer, type ByokServer } from '@byok-sdk/server';
import { createDaemonWithAdapters, type Daemon, type AgentEgressPolicy } from '@byok-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalBtwHost, GOAL_RESULT_CONTRACT, BTW_RESULT_CONTRACT, extractBotResult, type BotTarget } from './goal-btw';
import { SqliteGoalBtwStore, HostRevisionConflict } from './goal-btw-store';
import { BotStubAdapter } from './goal-btw.test-support';

const policy: AgentEgressPolicy = {
  policyRevision: 'example-bot-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};
const result = (outcome: string, rest: object = {}) => ({ contract: GOAL_RESULT_CONTRACT, outcome, ...rest });

describe('copy-and-own goal/btw Host, public SDK over real HTTP', () => {
  let root: string; let byok: ByokServer; let daemon: Daemon; let adapter: BotStubAdapter;
  let closeHttp: () => Promise<void>; let store: SqliteGoalBtwStore; let host: GoalBtwHost;
  let deviceId: string; let now: number; let dbPath: string;
  let extraStores: SqliteGoalBtwStore[];
  const accepted: (outcome: unknown) => boolean = () => true; // Fixture acceptance, not a production semantic proof.
  const target = (agentId = 'main-agent'): BotTarget => ({
    deviceId, agentRef: { agentId, profileRevision: '1' }, runtime: 'pi', egressPolicy: policy,
  });
  function newGoal(id = 'goal', budget = 3, deadline = now + 10_000, agent = 'main-agent') {
    return host.startGoal({ id, objective: 'Complete the approved task', target: target(agent), maxSteps: budget, deadline });
  }
  async function running(taskId: string): Promise<void> {
    await vi.waitFor(async () => expect((await byok.tasks.attempt(taskId))?.status).toBe('running'), { timeout: 5000 });
    expect(adapter.sessions.has(taskId)).toBe(true);
  }
  async function terminal(taskId: string): Promise<void> {
    await vi.waitFor(async () => expect(await byok.tasks.deviceTerminal(taskId)).toBeDefined(), { timeout: 5000 });
  }
  async function startStep(id = 'goal', taskId = 'step-1') {
    const goal = newGoal(id);
    const reserved = host.reserveGoalStep(id, goal.revision, taskId, 'Frozen Host transcript prefix');
    const sent = await host.sendGoalStep(id, reserved.revision); await running(taskId); return sent;
  }
  async function side(id = 'side', taskId = 'side-1', mainTaskId = 'step-1') {
    const reserved = await host.reserveBtw({ id, taskId, mainTaskId, mainDestination: 'main-thread', destination: `btw:${id}`,
      snapshotRevision: 'prefix-v1', snapshot: 'Only the Host-selected prefix', question: 'Explain the API', target: target('side-agent') });
    const sent = await host.sendBtw(id, reserved.revision); await running(taskId); return sent;
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gb-')); now = 1_000_000; extraStores = [];
    byok = createByokServer({ productId: 'goal-btw-test', longPollHoldMs: 100 });
    const listening = await new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
      const http = serve({ fetch: byok.hono.fetch, port: 0, hostname: '127.0.0.1' }, info => resolve({
        url: `http://127.0.0.1:${info.port}`, close: () => new Promise<void>(done => { http.close(() => done()); if ('closeAllConnections' in http) http.closeAllConnections(); }),
      }));
    });
    closeHttp = listening.close;
    adapter = new BotStubAdapter();
    daemon = createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-example-stub' }, productName: 'Example Bot',
      productId: 'goal-btw-test', serverUrl: listening.url, workspaceRoot: path.join(root, 'ws'), storeDir: path.join(root, 'sdk'),
      agentHome: { hostStorageRoot: path.join(root, 'homes') }, agentEgress: { policy }, resultDocument: { extract: extractBotResult },
    }, [adapter], { longPoll: { retryDelayMs: 10, idleDelayMs: 10 } });
    const pair = await byok.pairing.createPairingCode({ productId: 'goal-btw-test' });
    deviceId = (await daemon.pair(pair.code)).deviceId;
    await daemon.start();
    await vi.waitFor(async () => expect((await byok.machines.list()).find(m => m.deviceId === deviceId)?.connected).toBe(true), { timeout: 5000 });
    dbPath = path.join(root, 'host.sqlite'); store = new SqliteGoalBtwStore(dbPath, 'goal-btw-test');
    host = new GoalBtwHost(byok, store, () => now, (_goal, verdict) => accepted(verdict));
  });
  afterEach(async () => {
    await daemon?.stop(); byok?.stop(); await closeHttp?.(); store?.close(); extraStores?.forEach(s => s.close());
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('T2: reserved input -> real offer -> continue -> fresh step -> complete, no native followUp', async () => {
    const sent = await startStep();
    const offer = await byok.tasks.offer('step-1');
    expect(offer).toMatchObject({ taskId: 'step-1', deviceId, type: 'task.offer_for_agent_with_egress_fresh', delivered: true,
      payload: { runtime: 'pi', agentRef: target().agentRef, terminalProjection: { mode: 'result-document', contract: GOAL_RESULT_CONTRACT } } });
    expect(offer?.payload).not.toHaveProperty('sessionRef'); expect(offer?.payload).not.toHaveProperty('messageEgress');
    adapter.sessions.get('step-1')!.finish(result('continue')); await terminal('step-1');
    const continued = await host.reconcileGoal('goal', sent.revision);
    expect(continued.value).toMatchObject({ status: 'active', steps: 1, lastTaskId: 'step-1', pending: null });
    await vi.waitFor(() => expect(adapter.sessions.get('step-1')!.closed).toBe(true), { timeout: 5000 });
    const second = host.reserveGoalStep('goal', continued.revision, 'step-2', 'Host accepted the first step');
    const sent2 = await host.sendGoalStep('goal', second.revision); await running('step-2');
    adapter.sessions.get('step-2')!.finish(result('complete')); await terminal('step-2');
    expect((await host.reconcileGoal('goal', sent2.revision)).value.status).toBe('complete');
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts.every(s => s.kind === 'instruction' && s.manifest.sessionRef === undefined)).toBe(true);
    expect([...adapter.sessions.values()].every(s => s.steered === 0 && s.followedUp === 0)).toBe(true);
  });

  it('T1: B answers while A keeps running; same A home is refused before adapter start', async () => {
    await startStep(); const main = host.goal('goal'); const sent = await side();
    expect((await byok.tasks.attempt('step-1'))?.status).toBe('running');
    const starts = adapter.starts.length;
    await byok.dispatchFreshAgentEgress({ ...target('main-agent'), taskId: 'same-home-side', instruction: 'side question',
      terminalProjection: { mode: 'result-document', contract: BTW_RESULT_CONTRACT } });
    await terminal('same-home-side');
    expect((await byok.tasks.deviceTerminal('same-home-side'))?.envelope).toMatchObject({ type: 'task.decline', payload: { reason: 'agent home busy: 1 active attempt(s)' } });
    expect(adapter.starts).toHaveLength(starts);
    expect(adapter.sessions.has('same-home-side')).toBe(false);
    adapter.sessions.get('side-1')!.finish({ contract: BTW_RESULT_CONTRACT, answer: 'An independent answer' }); await terminal('side-1');
    expect((await host.reconcileBtw('side', sent.revision)).value).toMatchObject({ status: 'complete', answer: 'An independent answer', destination: 'btw:side' });
    expect(host.goal('goal')).toEqual(main);
    expect((await byok.tasks.attempt('step-1'))?.status).toBe('running');
    expect(adapter.starts[0]!.manifest.workspace.workspaceDir).not.toBe(adapter.starts[1]!.manifest.workspace.workspaceDir);
    expect(adapter.sessions.get('step-1')!.steered).toBe(0);
  });

  it('refuses a profile-only different home and shared-destination btw', async () => {
    await startStep();
    const base = { id: 'bad', taskId: 'bad-task', mainTaskId: 'step-1', mainDestination: 'main', destination: 'side',
      snapshotRevision: '1', snapshot: '', question: 'question', target: target('side-agent') };
    await expect(host.reserveBtw({ ...base, target: { ...target('main-agent'), agentRef: { agentId: 'main-agent', profileRevision: '2' } } })).rejects.toThrow('different Agent home');
    await expect(host.reserveBtw({ ...base, destination: 'main' })).rejects.toThrow('independent');
    expect(adapter.starts).toHaveLength(1); expect(await byok.tasks.offer('bad-task')).toBeUndefined();
  });

  it('cancel btw targets only B and leaves A running', async () => {
    const main = await startStep(); const sent = await side();
    await host.cancelBtw('side', sent.revision); await terminal('side-1');
    expect((await byok.tasks.attempt('side-1'))?.cancellation).toBeDefined();
    expect((await byok.tasks.attempt('step-1'))?.cancellation).toBeUndefined();
    expect(host.goal('goal')).toEqual(main);
  });

  it('cancel main leaves an existing btw free to complete', async () => {
    const main = await startStep(); const sent = await side();
    await host.cancelGoal('goal', main.revision);
    expect((await byok.tasks.attempt('side-1'))?.cancellation).toBeUndefined();
    adapter.sessions.get('side-1')!.finish({ contract: BTW_RESULT_CONTRACT, answer: 'Side survived' }); await terminal('side-1');
    expect((await host.reconcileBtw('side', sent.revision)).value.status).toBe('complete');
    expect(host.goal('goal').value.status).toBe('cancelled');
  });

  it('SQLite restart after reserve recovers the exact taskId and cannot submit twice', async () => {
    const goal = newGoal(); const reservation = host.reserveGoalStep('goal', goal.revision, 'restart-step', 'frozen');
    store.close(); store = new SqliteGoalBtwStore(dbPath, 'goal-btw-test'); host = new GoalBtwHost(byok, store, () => now, () => true);
    expect(host.goal('goal')).toEqual(reservation);
    const sent = await host.recoverGoalStep('goal', reservation.revision); await running('restart-step');
    await host.recoverGoalStep('goal', sent.revision);
    expect(adapter.starts).toHaveLength(1);
    await expect(host.sendGoalStep('goal', sent.revision)).rejects.toThrow('explicit recovery');
  });

  it('recovery after SDK offer commit but lost acknowledgement reads the existing offer', async () => {
    const goal = newGoal(); const reserved = host.reserveGoalStep('goal', goal.revision, 'lost-ack', 'frozen');
    reserved.value.pending!.phase = 'sending';
    const sending = store.write('goal:goal', reserved.revision, reserved.value);
    await byok.dispatchFreshAgentEgress(sending.value.pending!.input); await running('lost-ack');
    store.close(); store = new SqliteGoalBtwStore(dbPath, 'goal-btw-test'); host = new GoalBtwHost(byok, store, () => now, () => true);
    await host.recoverGoalStep('goal', sending.revision);
    expect(adapter.starts).toHaveLength(1); expect((await byok.tasks.offer('lost-ack'))?.delivered).toBe(true);
  });

  it('CAS across two SQLite connections permits one reservation; IDs survive settlement', () => {
    const goal = newGoal(); const secondStore = new SqliteGoalBtwStore(dbPath, 'goal-btw-test'); extraStores.push(secondStore);
    const secondHost = new GoalBtwHost(byok, secondStore, () => now, () => true);
    const won = host.reserveGoalStep('goal', goal.revision, 'cas-first', '');
    expect(() => secondHost.reserveGoalStep('goal', goal.revision, 'cas-loser', '')).toThrow(HostRevisionConflict);
    expect(host.goal('goal')).toEqual(won);
    const other = newGoal('other', 3, now + 10000, 'other-agent');
    expect(() => host.reserveGoalStep('other', other.revision, 'cas-first', '')).toThrow('Host taskId has already been reserved');
    expect(host.goal('other').value.steps).toBe(0);
  });

  it.each(['failed', 'cancelled', 'declined', 'home-busy'] as const)('%s is blocked with no automatic new execution', async mode => {
    let sent;
    if (mode === 'home-busy') {
      await startStep('occupier', 'occupying');
      const goal = newGoal(); const r = host.reserveGoalStep('goal', goal.revision, 'blocked-step', ''); sent = await host.sendGoalStep('goal', r.revision);
    } else {
      if (mode === 'declined') adapter.rejectNext = true;
      const goal = newGoal(); const r = host.reserveGoalStep('goal', goal.revision, 'blocked-step', ''); sent = await host.sendGoalStep('goal', r.revision);
      if (mode === 'failed') { await running('blocked-step'); adapter.sessions.get('blocked-step')!.fail(); }
      if (mode === 'cancelled') { await running('blocked-step'); await byok.tasks.cancel('blocked-step'); }
    }
    await terminal('blocked-step');
    expect((await byok.tasks.attempt('blocked-step'))?.status).toMatch(/failed|cancelled|cancel_requested/);
    const starts = adapter.starts.length;
    expect((await host.reconcileGoal('goal', sent.revision)).value.status).toBe('blocked');
    expect(adapter.starts).toHaveLength(starts);
    expect(() => host.reserveGoalStep('goal', host.goal('goal').revision, 'unapproved-retry', '')).toThrow('not active');
  });

  it('pause while in-flight retains complete verdict; resume is refused', async () => {
    const sent = await startStep(); const paused = host.pauseGoal('goal', sent.revision);
    adapter.sessions.get('step-1')!.finish(result('complete')); await terminal('step-1');
    const complete = await host.reconcileGoal('goal', paused.revision);
    expect(complete.value.status).toBe('complete');
    expect(() => host.resumeGoal('goal', complete.revision)).toThrow('cannot be resumed');
  });

  it('wait uses persisted notBefore and injected Host time without a background loop', async () => {
    const sent = await startStep(); adapter.sessions.get('step-1')!.finish(result('wait', { reason: 'external event', resumeAt: now + 100 })); await terminal('step-1');
    const waiting = await host.reconcileGoal('goal', sent.revision);
    expect(waiting.value.status).toBe('waiting');
    expect(() => host.reserveGoalStep('goal', waiting.revision, 'too-soon', '')).toThrow('not active');
    now += 100;
    const ready = host.reserveGoalStep('goal', waiting.revision, 'due-step', 'external event arrived');
    expect(ready.value.pending!.phase).toBe('reserved'); expect(adapter.starts).toHaveLength(1);
  });

  it('maxSteps is a cumulative bound, and repeated/late verdicts do not advance twice', async () => {
    const goal = newGoal('goal', 1); const r = host.reserveGoalStep('goal', goal.revision, 'budget-step', ''); const sent = await host.sendGoalStep('goal', r.revision);
    await running('budget-step'); adapter.sessions.get('budget-step')!.finish(result('continue')); await terminal('budget-step');
    const exhausted = await host.reconcileGoal('goal', sent.revision);
    expect(exhausted.value).toMatchObject({ status: 'exhausted', steps: 1 });
    expect(await host.reconcileGoal('goal', exhausted.revision)).toEqual(exhausted);
    await expect(host.reconcileGoal('goal', sent.revision)).rejects.toThrow(HostRevisionConflict);
    expect(() => host.reserveGoalStep('goal', exhausted.revision, 'over-budget', '')).toThrow('Goal is not active');
  });

  it('deadline tick cancels only its pending task, leaves another goal and btw running, and never dispatches', async () => {
    const main = await startStep(); const sideRun = await side();
    const another = newGoal('other', 3, now + 30_000, 'other-agent'); const reserved = host.reserveGoalStep('other', another.revision, 'other-step', '');
    await host.sendGoalStep('other', reserved.revision); await running('other-step');
    const starts = adapter.starts.length; now += 10_000;
    const timedOut = await host.tickGoal('goal', main.revision);
    expect(timedOut.value.status).toBe('exhausted'); expect((await byok.tasks.attempt('step-1'))?.cancellation).toBeDefined();
    expect((await byok.tasks.attempt('other-step'))?.cancellation).toBeUndefined(); expect((await byok.tasks.attempt('side-1'))?.cancellation).toBeUndefined();
    expect(host.btw('side')).toEqual(sideRun); expect(adapter.starts).toHaveLength(starts);
  });

  it('cancel after SDK offer exists wins against a late complete result', async () => {
    const sent = await startStep(); const cancelled = await host.cancelGoal('goal', sent.revision);
    adapter.sessions.get('step-1')!.finish(result('complete')); await terminal('step-1');
    const state = await host.reconcileGoal('goal', cancelled.revision);
    expect(state.value.status).toBe('cancelled'); expect(adapter.starts).toHaveLength(1);
  });

  it('cancel in sending-before-offer window is persisted and replayed to exactly that task', async () => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = new GoalBtwHost({ tasks: byok.tasks, dispatchFreshAgentEgress: async input => {
      enter(); await gate; return byok.dispatchFreshAgentEgress(input);
    } }, store, () => now, () => true);
    const goal = newGoal(); const reservation = host.reserveGoalStep('goal', goal.revision, 'cancel-before-offer', '');
    const pending = delayed.sendGoalStep('goal', reservation.revision); await entered;
    expect(await byok.tasks.offer('cancel-before-offer')).toBeUndefined();
    const sending = host.goal('goal'); const cancelled = await host.cancelGoal('goal', sending.revision);
    expect(cancelled.value.status).toBe('cancelled'); release(); await pending;
    expect((await byok.tasks.attempt('cancel-before-offer'))?.cancellation).toBeDefined();
    await host.recoverGoalStep('goal', host.goal('goal').revision);
    expect(adapter.starts.length).toBeLessThanOrEqual(1); expect(host.goal('goal').value.status).toBe('cancelled');
    expect(adapter.sessions.get('cancel-before-offer')?.steered ?? 0).toBe(0);
  });

  it('malformed verdict is blocked by the real result extractor', async () => {
    const sent = await startStep(); adapter.sessions.get('step-1')!.finish({ contract: GOAL_RESULT_CONTRACT, outcome: 'complete', surprise: true }); await terminal('step-1');
    expect((await byok.tasks.deviceTerminal('step-1'))?.envelope.type).toBe('task.fail');
    expect((await host.reconcileGoal('goal', sent.revision)).value.status).toBe('blocked');
  });

  it('Host acceptance can refuse a well-formed model completion claim', async () => {
    const refusing = new GoalBtwHost(byok, store, () => now, () => false); const sent = await startStep();
    adapter.sessions.get('step-1')!.finish(result('complete')); await terminal('step-1');
    expect((await refusing.reconcileGoal('goal', sent.revision)).value).toMatchObject({ status: 'blocked', reason: 'goal_result_not_accepted' });
  });

  it('extractor dispatches exact contract and refuses non-JSON/unknown fields', () => {
    const task = (contract: string) => ({ taskId: 't', sessionRef: 's', terminalProjection: { mode: 'result-document' as const, contract } });
    expect(extractBotResult('not JSON', task('some-other-contract'))).toBeUndefined();
    expect(() => extractBotResult('```json\n{}\n```', task(GOAL_RESULT_CONTRACT))).toThrow();
    expect(() => extractBotResult(JSON.stringify({ contract: BTW_RESULT_CONTRACT, answer: 'x', extra: 1 }), task(BTW_RESULT_CONTRACT))).toThrow();
    expect(extractBotResult(JSON.stringify(result('complete')), task(GOAL_RESULT_CONTRACT))).toEqual(result('complete'));
  });

  it('sending a reserved step after its deadline never creates an SDK offer', async () => {
    const goal = newGoal('goal', 3, now + 100); const reserved = host.reserveGoalStep('goal', goal.revision, 'expired-before-send', '');
    now += 100;
    const stopped = await host.sendGoalStep('goal', reserved.revision);
    expect(stopped.value.status).toBe('exhausted'); expect(await byok.tasks.offer('expired-before-send')).toBeUndefined();
    expect(adapter.starts).toHaveLength(0);
  });

  it.each(['continue', 'wait'])('paused %s remains paused until explicit resume', async outcome => {
    const sent = await startStep(); const paused = host.pauseGoal('goal', sent.revision);
    adapter.sessions.get('step-1')!.finish(result(outcome, outcome === 'wait' ? { reason: 'waiting', resumeAt: now + 100 } : {})); await terminal('step-1');
    const settled = await host.reconcileGoal('goal', paused.revision);
    expect(settled.value.status).toBe('paused');
    expect(() => host.reserveGoalStep('goal', settled.revision, 'paused-extra', '')).toThrow('Goal is not active');
    expect(host.resumeGoal('goal', settled.revision).value.status).toBe('active'); expect(adapter.starts).toHaveLength(1);
  });

  it('cancel reserved-before-send persists intent without dispatching even on recovery', async () => {
    const goal = newGoal(); const reserved = host.reserveGoalStep('goal', goal.revision, 'never-sent', '');
    const stopped = await host.cancelGoal('goal', reserved.revision);
    await host.recoverGoalStep('goal', stopped.revision);
    expect(await byok.tasks.offer('never-sent')).toBeUndefined(); expect(adapter.starts).toHaveLength(0);
  });

  it('explicit recovery refuses an existing SDK offer whose frozen input changed', async () => {
    const sent = await startStep(); const changed = structuredClone(sent.value);
    changed.pending!.input.instruction = 'a different instruction';
    const corrupt = store.write('goal:goal', sent.revision, changed);
    await expect(host.recoverGoalStep('goal', corrupt.revision)).rejects.toThrow('differs from the reserved');
    expect(adapter.starts).toHaveLength(1);
  });

  it('a racing second sender cannot dispatch or consume a second goal step', async () => {
    const goal = newGoal(); const reserved = host.reserveGoalStep('goal', goal.revision, 'sender-race', '');
    const attempts = await Promise.allSettled([host.sendGoalStep('goal', reserved.revision), host.sendGoalStep('goal', reserved.revision)]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
    await running('sender-race'); expect(adapter.starts).toHaveLength(1); expect(host.goal('goal').value.steps).toBe(1);
  });

  it('past wait time passes the extractor shape check but is blocked by Host policy', async () => {
    const sent = await startStep(); adapter.sessions.get('step-1')!.finish(result('wait', { reason: 'past deadline', resumeAt: now - 1 })); await terminal('step-1');
    expect((await byok.tasks.deviceTerminal('step-1'))?.envelope.type).toBe('task.complete');
    expect((await host.reconcileGoal('goal', sent.revision)).value).toMatchObject({ status: 'blocked', reason: 'invalid_goal_result' });
  });

  it('btw cannot reserve against a main task that is not running', async () => {
    const input = { id: 'not-running', taskId: 'side-not-running', mainTaskId: 'missing-main', mainDestination: 'main', destination: 'side',
      snapshotRevision: '1', snapshot: '', question: 'question', target: target('side-agent') };
    await expect(host.reserveBtw(input)).rejects.toThrow('main task is not running');
    const sent = await startStep(); await host.cancelGoal('goal', sent.revision);
    await expect(host.reserveBtw({ ...input, mainTaskId: 'step-1' })).rejects.toThrow('main task is not running');
    expect(await byok.tasks.offer('side-not-running')).toBeUndefined();
  });

  it('synchronous public dispatch rejection retains sending input for exact-ID recovery', async () => {
    let reject = true;
    const onceRejected = new GoalBtwHost({ tasks: byok.tasks, dispatchFreshAgentEgress: input => {
      if (reject) { reject = false; throw new Error('simulated pre-submit rejection'); }
      return byok.dispatchFreshAgentEgress(input);
    } }, store, () => now, () => true);
    const goal = newGoal(); const reserved = host.reserveGoalStep('goal', goal.revision, 'retry-same-id', 'immutable context');
    await expect(onceRejected.sendGoalStep('goal', reserved.revision)).rejects.toThrow('simulated pre-submit rejection');
    const unknown = host.goal('goal'); expect(unknown.value.pending!.phase).toBe('sending');
    expect(unknown.value.pending!.input).toEqual(reserved.value.pending!.input); expect(unknown.value.steps).toBe(1);
    await onceRejected.recoverGoalStep('goal', unknown.revision); await running('retry-same-id');
    expect(adapter.starts).toHaveLength(1);
    expect((await byok.tasks.list()).tasks.map(t => t.taskId)).toEqual(['retry-same-id']);
  });

  it('Host namespace isolates shared SQLite files', () => {
    newGoal(); const other = new SqliteGoalBtwStore(dbPath, 'different-host'); extraStores.push(other);
    expect(other.read('goal:goal')).toBeUndefined();
    expect(() => newGoal()).toThrow(HostRevisionConflict);
    expect(host.goal('goal').value.steps).toBe(0);
  });
});
