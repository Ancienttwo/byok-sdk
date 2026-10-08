import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createByokServer, type ByokServer } from '@byok-sdk/server';
import { createDaemonWithAdapters, type Daemon, type AgentEgressPolicy, type DaemonConfig } from '@byok-sdk/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { BotStubAdapter } from './goal-btw.test-support';
import { HostRevisionConflict } from './goal-btw-store';
import type { BotTarget } from './goal-btw';
import { SqliteClarificationStore } from './clarification-store';
import { ClarificationHost, CLARIFICATION_CONTRACT, extractClarification, parseClarification, type QuestionBinding } from './clarification';

const policy: AgentEgressPolicy = {
  policyRevision: 'clarification-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};
const result = (outcome: string, extra: object = {}) => ({ contract: CLARIFICATION_CONTRACT,outcome,...extra });
const question = (kind: 'text'|'single_choice' = 'single_choice') => result('needs_input', {
  questionId: 'model-proposal',question: 'Choose export scope',checkpoint: 'before_export',answerKind: kind,
  ...(kind === 'single_choice' ? { options: [{ id: 'current',label: 'This month' },{ id: 'all',label: 'All history' }] } : {}),
});

describe('Host clarification: real HTTP daemon, SQLite CAS, injected clock', () => {
  let root: string; let db: string; let now: number; let deviceId: string;
  let byok: ByokServer; let daemon: Daemon; let adapter: BotStubAdapter;
  let fixtureUrl: string; let closeHttp: () => Promise<void>; let store: SqliteClarificationStore; let host: ClarificationHost;
  let extraStores: SqliteClarificationStore[];
  const principal = { tenantId: 'tenant-a',userId: 'user-a' };
  const target = (agentId = 'agent-a'): BotTarget => ({ deviceId,agentRef: { agentId,profileRevision: '1' },runtime: 'pi',egressPolicy: policy });
  const start = (id = 'run', taskId = 'step-1', agentId = 'agent-a', budget = 3) => host.start({ id,sessionId: 'conversation-a',respondentId: 'user-a',destination: 'thread-a',target: target(agentId),
    contextRevision: 'context-1',context: 'Frozen product context',objective: 'Export approved scope',maxExecutions: budget,deadline: now + 10_000,questionTtlMs: 1000 },taskId);
  const row = () => host.run('run');
  const binding = (): QuestionBinding => structuredClone(row().value.tickets.at(-1)!.binding);
  const answer = (overrides: Partial<{ answerId: string;value: string;taskId: string;nextContextRevision: string }> = {}, b = binding()) => host.answer(principal,b,{ answerId: 'answer-1',value: 'current',taskId: 'step-2',nextContextRevision: 'context-2',...overrides });
  async function running(taskId: string) { await vi.waitFor(async () => expect((await byok.tasks.attempt(taskId))?.status).toBe('running'),{ timeout: 5000 }); }
  async function terminal(taskId: string) { await vi.waitFor(async () => expect(await byok.tasks.deviceTerminal(taskId)).toBeDefined(),{ timeout: 5000 }); }
  async function first() { const r = start(); await host.send('run',r.revision); await running('step-1'); }
  async function waiting(kind: 'text'|'single_choice' = 'single_choice') {
    await first(); adapter.sessions.get('step-1')!.finish(question(kind)); await terminal('step-1');
    const r = await host.reconcile('run',row().revision);
    await vi.waitFor(() => expect(adapter.sessions.get('step-1')!.closed).toBe(true),{ timeout: 5000 }); return r;
  }
  function reopen() {
    store.close(); store = new SqliteClarificationStore(db,'tenant-a'); host = new ClarificationHost(byok,store,() => now);
  }
  function secondHost(cap = 100) {
    const s = new SqliteClarificationStore(db,'tenant-a',cap); extraStores.push(s); return { store: s,host: new ClarificationHost(byok,s,() => now) };
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(),'cq-')); db = path.join(root,'host.sqlite'); now = 1_000_000; extraStores = [];
    byok = createByokServer({ productId: 'clarification-test',longPollHoldMs: 100 });
    const listening = await new Promise<{ url: string;close: () => Promise<void> }>(resolve => {
      const http = serve({ fetch: byok.hono.fetch,port: 0,hostname: '127.0.0.1' },info => resolve({ url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>(done => { http.close(() => done()); if ('closeAllConnections' in http) http.closeAllConnections(); }) }));
    }); closeHttp = listening.close; fixtureUrl = listening.url;
    adapter = new BotStubAdapter();
    daemon = createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-example-stub' },productName: 'Example Bot',productId: 'clarification-test',serverUrl: listening.url,
      workspaceRoot: path.join(root,'ws'),storeDir: path.join(root,'sdk'),agentHome: { hostStorageRoot: path.join(root,'homes') },agentEgress: { policy },resultDocument: { extract: extractClarification },
    },[adapter],{ longPoll: { retryDelayMs: 10,idleDelayMs: 10 } });
    const pair = await byok.pairing.createPairingCode({ productId: 'clarification-test' }); deviceId = (await daemon.pair(pair.code)).deviceId;
    await daemon.start(); await vi.waitFor(async () => expect((await byok.machines.list()).find(m => m.deviceId === deviceId)?.connected).toBe(true),{ timeout: 5000 });
    store = new SqliteClarificationStore(db,'tenant-a'); host = new ClarificationHost(byok,store,() => now);
  });
  afterEach(async () => {
    await daemon?.stop(); byok?.stop(); await closeHttp?.(); store?.close(); extraStores?.forEach(s => s.close());
    if (root) await rm(root,{ recursive: true,force: true });
  });

  it('single_choice: terminal -> ticket -> idempotent notification -> answer -> fresh completion', async () => {
    const r = await waiting(); const b = binding();
    expect(r.value.status).toBe('waiting_input'); expect(b.questionId).not.toBe('model-proposal'); expect(b.tenantId).toBe(principal.tenantId);
    expect((await byok.tasks.offer('step-1'))?.payload).not.toHaveProperty('messageEgress');
    const delivered = new Map<string,string>();
    const deliver = async (n: { deliveryId: string;binding: QuestionBinding }) => { delivered.set(n.deliveryId,n.binding.destination); };
    await host.notify('run',r.revision,deliver); await host.notify('run',row().revision,deliver);
    expect(delivered.size).toBe(1); expect(delivered.get(b.questionId)).toBe('thread-a');
    const receipt = answer({},b); const reserved = row();
    expect(answer({ taskId: 'must-not-reserve',nextContextRevision: 'unused' },b)).toEqual(receipt); expect(row()).toEqual(reserved);
    expect(await byok.tasks.offer('step-2')).toBeUndefined();
    await host.send('run',reserved.revision); await running('step-2');
    const offer = await byok.tasks.offer('step-2'); if (!offer || !('instruction' in offer.payload)) throw new Error('Missing fresh instruction'); expect(offer.payload.instruction).toContain('Validated clarification answer'); expect(offer.payload.instruction).toContain('"answer":"current"');
    expect(offer?.payload).not.toHaveProperty('sessionRef'); expect(offer?.payload).not.toHaveProperty('messageEgress');
    adapter.sessions.get('step-2')!.finish(result('complete')); await terminal('step-2');
    expect((await host.reconcile('run',row().revision)).value.status).toBe('complete');
    expect(adapter.starts).toHaveLength(2); expect([...adapter.sessions.values()].every(s => s.steered === 0 && s.followedUp === 0)).toBe(true);
  });
  it('text answer is frozen into the next input; invalid choices/text are refused', async () => {
    await waiting('text'); const b = binding();
    expect(() => answer({ value: ' '.repeat(2) },b)).toThrow('Invalid answer');
    expect(() => answer({ value: 'a'.repeat(4097) },b)).toThrow('Invalid answer');
    answer({ value: 'Only approved invoices' },b);
    expect(row().value.pending?.input.instruction).toContain('Only approved invoices');
    expect(() => answer({ value: 'different body' },b)).toThrow('Answer id conflicts');
  });
  it('two SQLite connections admit exactly one answer/continuation and reject revision CAS replay', async () => {
    const r = await waiting(); const b = binding(); const other = secondHost();
    const firstReceipt = answer({},b);
    expect(other.host.answer(principal,b,{ answerId: 'answer-1',value: 'current',taskId: 'ignored',nextContextRevision: 'ignored' })).toEqual(firstReceipt);
    expect(() => other.host.answer(principal,b,{ answerId: 'answer-2',value: 'all',taskId: 'third',nextContextRevision: 'context-3' })).toThrow('stale or question is closed');
    await expect(other.host.reconcile('run',r.revision)).rejects.toBeInstanceOf(HostRevisionConflict);
    expect(other.host.run('run').value.generation).toBe(2); expect(await byok.tasks.offer('third')).toBeUndefined();
  });
  it.each(['tenantId','sessionId','sourceTaskId','generation','contextRevision','questionId','questionRevision','agentId','profileRevision','deviceId','destination'] as const)('rejects wrong or stale binding %s without dispatch', async field => {
    await waiting(); const b = binding(); const wrong = { ...b,[field]: typeof b[field] === 'number' ? Number(b[field]) + 1 : `${b[field]}-wrong` };
    expect(() => answer({},wrong)).toThrow(field === 'tenantId' ? 'tenant unauthorized' : 'stale or question is closed');
    expect(row().value.status).toBe('waiting_input'); expect(await byok.tasks.offer('step-2')).toBeUndefined();
  });
  it('unauthorized respondent, invalid option, same context revision and task reuse leave ticket open', async () => {
    await waiting(); const b = binding(); const value = row();
    expect(() => host.answer({ ...principal,userId: 'attacker' },b,{ answerId: 'a',value: 'current',taskId: 'x',nextContextRevision: 'next' })).toThrow('respondent unauthorized');
    expect(() => answer({ value: 'unknown' },b)).toThrow('Invalid option answer');
    expect(() => answer({ nextContextRevision: 'context-1' },b)).toThrow('new context revision');
    expect(() => answer({ taskId: 'step-1' },b)).toThrow('Host taskId has already been reserved');
    expect(row()).toEqual(value);
  });
  it('stale SQLite writer cannot overwrite ticket/answer state across connections', async () => {
    await waiting(); const other = secondHost(); const snapshot = row(); const stale = other.host.run('run');
    store.write('run',snapshot.revision,snapshot.value,true);
    expect(() => other.store.write('run',stale.revision,stale.value,true)).toThrow(HostRevisionConflict);
  });
  it('old question from a previous generation cannot answer the new question', async () => {
    await waiting(); const old = binding(); answer({},old);
    await host.send('run',row().revision); await running('step-2');
    adapter.sessions.get('step-2')!.finish(question('text')); await terminal('step-2'); await host.reconcile('run',row().revision);
    expect(binding().generation).toBe(2); expect(binding().questionId).not.toBe(old.questionId);
    expect(() => answer({ answerId: 'late',taskId: 'third',nextContextRevision: 'context-3' },old)).toThrow('stale or question is closed');
    expect(row().value.tickets).toHaveLength(2); expect(await byok.tasks.offer('third')).toBeUndefined();
  });
  it('context change closes the ticket; old answer and late terminal cannot revive it', async () => {
    await waiting(); const b = binding(); await host.changeContext('run',row().revision,'context-changed');
    expect(row().value).toMatchObject({ status: 'obsolete',tickets: [{ state: 'obsolete' }] });
    expect(() => answer({},b)).toThrow('stale or question is closed');
    await host.reconcile('run',row().revision); expect(row().value.tickets).toHaveLength(1);
  });
  it('duplicate source terminal and old generation replay never creates a second question', async () => {
    const r = await waiting(); await host.reconcile('run',r.revision); expect(row()).toEqual(r);
    answer(); await host.reconcile('run',row().revision); expect(row().value.tickets).toHaveLength(1);
    expect(row().value.pending?.input.taskId).toBe('step-2');
  });
  it('notification failure/restart reuses deliveryId and never reexecutes the question source', async () => {
    await waiting(); const delivered = new Set<string>(); let firstId = '';
    await expect(host.notify('run',row().revision,async n => { firstId = n.deliveryId; delivered.add(n.deliveryId); throw new Error('ack lost'); })).rejects.toThrow('ack lost');
    reopen(); await host.notify('run',row().revision,async n => { expect(n.deliveryId).toBe(firstId); delivered.add(n.deliveryId); });
    expect(delivered.size).toBe(1); expect(adapter.starts).toHaveLength(1); expect(row().value.tickets[0]?.notification).toBe('delivered');
  });
  it('notification acknowledgement cannot overwrite a concurrent answer', async () => {
    await waiting(); await host.notify('run',row().revision,async () => { answer(); });
    expect(row().value.status).toBe('continuation_reserved'); expect(row().value.tickets[0]?.notification).toBe('closed');
  });
  it('restart after initial reserve and continuation reserve recovers exactly the same taskIds', async () => {
    start(); reopen(); await host.recover('run',row().revision); await running('step-1');
    await host.recover('run',row().revision); expect(adapter.starts).toHaveLength(1);
    adapter.sessions.get('step-1')!.finish(question()); await terminal('step-1'); await host.reconcile('run',row().revision);
    await vi.waitFor(() => expect(adapter.sessions.get('step-1')!.closed).toBe(true),{ timeout: 5000 });
    answer(); const saved = row(); reopen(); expect(row()).toEqual(saved);
    await host.recover('run',row().revision); await running('step-2'); await host.recover('run',row().revision);
    expect(adapter.starts.map(s => s.manifest.taskId)).toEqual(['step-1','step-2']);
  });
  it('synchronous dispatch failure leaves sending; exact recovery creates one offer/start', async () => {
    const dispatch = byok.dispatchFreshAgentEgress.bind(byok); let reject = true;
    host = new ClarificationHost({ tasks: byok.tasks,dispatchFreshAgentEgress: async input => { if (reject) { reject = false; throw new Error('pre-offer failure'); } return dispatch(input); } },store,() => now);
    start(); await expect(host.send('run',row().revision)).rejects.toThrow('pre-offer failure');
    expect(row().value.pending?.phase).toBe('sending'); expect(await byok.tasks.offer('step-1')).toBeUndefined();
    await host.recover('run',row().revision); await running('step-1'); await host.recover('run',row().revision);
    expect(adapter.starts).toHaveLength(1); expect((await byok.tasks.offer('step-1'))?.taskId).toBe('step-1');
  });
  it('restart after offer delivery but before Host dispatch returns does not duplicate start', async () => {
    const dispatch = byok.dispatchFreshAgentEgress.bind(byok);
    host = new ClarificationHost({ tasks: byok.tasks,dispatchFreshAgentEgress: async input => { await dispatch(input); throw new Error('response lost'); } },store,() => now);
    start(); await host.send('run',row().revision); await running('step-1'); reopen(); await host.recover('run',row().revision);
    expect(adapter.starts).toHaveLength(1);
  });
  it.each(['before_offer','after_offer'] as const)('cancel in sending %s hits exact task or zero starts', async window => {
    const dispatch = byok.dispatchFreshAgentEgress.bind(byok); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const seen = new Promise<void>(r => { entered = r; });
    host = new ClarificationHost({ tasks: byok.tasks,dispatchFreshAgentEgress: async input => {
      const handle = window === 'after_offer' ? await dispatch(input) : undefined; entered(); await gate;
      return handle ?? await dispatch(input);
    } },store,() => now);
    start(); const sending = host.send('run',row().revision); await seen;
    await host.cancel('run',row().revision); release(); await sending;
    await vi.waitFor(async () => expect((await byok.tasks.attempt('step-1'))?.cancellation).toBeDefined(),{ timeout: 5000 });
    expect(row().value.status).toBe('cancelled'); expect(adapter.starts.every(s => s.manifest.taskId === 'step-1')).toBe(true);
    await host.recover('run',row().revision); expect(await byok.tasks.offer('step-2')).toBeUndefined();
  });
  it('cancel waiting input rejects answers; a historical receipt after cancel cannot dispatch', async () => {
    await waiting(); const b = binding(); const receipt = answer({},b); await host.cancel('run',row().revision);
    expect(answer({},b)).toEqual(receipt); await host.recover('run',row().revision);
    expect(await byok.tasks.offer('step-2')).toBeUndefined(); expect(adapter.starts).toHaveLength(1);
  });
  it('cancel an open ticket rejects new answers and suppresses notification', async () => {
    await waiting(); const b = binding(); await host.cancel('run',row().revision);
    expect(() => answer({},b)).toThrow('stale or question is closed');
    const deliver = vi.fn(); await host.notify('run',row().revision,deliver); expect(deliver).not.toHaveBeenCalled();
    expect(row().value.tickets[0]?.state).toBe('cancelled');
  });
  it('deadline before initial send yields zero offer/start', async () => {
    start(); now += 10_000; await host.send('run',row().revision);
    expect(row().value.status).toBe('expired'); expect(await byok.tasks.offer('step-1')).toBeUndefined(); expect(adapter.starts).toHaveLength(0);
  });
  it('cancel before needs_input arrives never mints a ticket', async () => {
    await first(); await host.cancel('run',row().revision);
    adapter.sessions.get('step-1')!.finish(question()); await terminal('step-1'); await host.reconcile('run',row().revision);
    expect(row().value.tickets).toHaveLength(0); expect(row().value.status).toBe('cancelled');
  });
  it('fake clock expiry, tenant cap and keyset paging keep unanswered questions bounded', async () => {
    store.close(); store = new SqliteClarificationStore(db,'tenant-a',1); host = new ClarificationHost(byok,store,() => now);
    await waiting(); start('other','other-task','agent-b'); await host.send('other',host.run('other').revision); await running('other-task');
    adapter.sessions.get('other-task')!.finish(question()); await terminal('other-task');
    await expect(host.reconcile('other',host.run('other').revision)).rejects.toThrow('pending question cap reached');
    expect(store.pending('',1)).toEqual(['run']); expect(store.pending('run',1)).toEqual([]);
    now += 1000; expect(() => answer()).toThrow('stale or question is closed'); await host.tick('run',row().revision);
    expect(row().value.status).toBe('expired'); expect(store.pending()).toEqual([]);
    await host.reconcile('other',host.run('other').revision); expect(store.pending()).toEqual(['other']); expect(adapter.starts).toHaveLength(2);
  });
  it('deadline tick only cancels this pending task, leaving another Run running', async () => {
    await first(); start('other','other-task','agent-b'); await host.send('other',host.run('other').revision); await running('other-task');
    now += 10_000; await host.tick('run',row().revision);
    expect((await byok.tasks.attempt('step-1'))?.cancellation).toBeDefined(); expect((await byok.tasks.attempt('other-task'))?.cancellation).toBeUndefined();
    expect(adapter.starts).toHaveLength(2); expect(row().value.status).toBe('expired');
  });
  it.each(['failed','cancelled','declined'] as const)('execution %s blocks without retry/new execution', async kind => {
    start(); if (kind === 'declined') adapter.rejectNext = true;
    await host.send('run',row().revision);
    if (kind !== 'declined') { await running('step-1'); if (kind === 'failed') adapter.sessions.get('step-1')!.fail(); else await byok.tasks.cancel('step-1','external cancel'); }
    await terminal('step-1'); await host.reconcile('run',row().revision);
    expect(row().value.status).toBe('blocked'); expect(row().value.tickets).toHaveLength(0); expect(adapter.starts).toHaveLength(kind === 'declined' ? 0 : 1);
    expect(await byok.tasks.offer('step-2')).toBeUndefined();
  });
  it('real home busy decline blocks before stub starts; no lane/Agent fallback', async () => {
    await first(); start('other','other-task'); await host.send('other',host.run('other').revision); await terminal('other-task');
    expect((await byok.tasks.deviceTerminal('other-task'))?.envelope).toMatchObject({ type: 'task.decline',payload: { reason: 'agent home busy: 1 active attempt(s)' } });
    expect((await host.reconcile('other',host.run('other').revision)).value.status).toBe('blocked'); expect(adapter.starts).toHaveLength(1);
  });
  it('execution budget prevents an unbounded question/answer loop', async () => {
    const r = start('run','step-1','agent-a',1); await host.send('run',r.revision); await running('step-1');
    adapter.sessions.get('step-1')!.finish(question()); await terminal('step-1');
    expect((await host.reconcile('run',row().revision)).value).toMatchObject({ status: 'blocked',reason: 'execution_budget_exhausted',tickets: [] });
  });
  it('malformed terminal is rejected by the real extractor and blocks Host', async () => {
    await first(); adapter.sessions.get('step-1')!.finish(result('needs_input',{ question: 'missing fields' })); await terminal('step-1');
    expect((await host.reconcile('run',row().revision)).value.status).toBe('blocked'); expect(row().value.tickets).toHaveLength(0);
  });
  it.each(['missing','empty','unchecked','capability'] as const)('extractor %s fails closed with zero tickets', async mode => {
    await daemon.stop();
    const config: DaemonConfig = { localAgentRelease: { version: '0.0.0-example-stub' },productName: 'Example Bot',productId: 'clarification-test',serverUrl: fixtureUrl,
      workspaceRoot: path.join(root,'second-ws'),storeDir: path.join(root,'second-sdk'),...(mode !== 'capability' ? { agentHome: { hostStorageRoot: path.join(root,'second-homes') },agentEgress: { policy } } : {}),
      ...(mode === 'empty' ? { resultDocument: { extract: () => undefined } } : {}),
      ...(mode === 'unchecked' || mode === 'capability' ? { resultDocument: { extract: (output: string) => JSON.parse(output) as unknown } } : {}),
    };
    daemon = createDaemonWithAdapters(config,[adapter],{ longPoll: { retryDelayMs: 10,idleDelayMs: 10 } });
    const code = await byok.pairing.createPairingCode({ productId: 'clarification-test' }); deviceId = (await daemon.pair(code.code)).deviceId;
    await daemon.start(); await vi.waitFor(async () => expect((await byok.machines.list()).find(m => m.deviceId === deviceId)?.connected).toBe(true),{ timeout: 5000 });
    start();
    if (mode === 'capability') {
      await expect(host.send('run',row().revision)).rejects.toThrow('agent-home-contract');
      expect(await byok.tasks.offer('step-1')).toBeUndefined(); expect(adapter.starts).toHaveLength(0);
    } else {
      await host.send('run',row().revision);
      if (mode !== 'missing') { await running('step-1'); adapter.sessions.get('step-1')!.finish(mode === 'unchecked' ? result('complete',{ extra: true }) : question()); }
      await terminal('step-1');
      if (mode !== 'unchecked') expect((await byok.tasks.deviceTerminal('step-1'))?.envelope.type).not.toBe('task.complete');
      if (mode === 'missing') expect(adapter.starts).toHaveLength(0);
      expect((await host.reconcile('run',row().revision)).value.status).toBe('blocked');
      if (mode === 'unchecked') expect(row().value.reason).toBe('invalid_clarification_result');
    }
    expect(row().value.tickets).toHaveLength(0);
  });
  it('mismatched egress is a daemon failure, not a question', async () => {
    await first(); adapter.sessions.get('step-1')!.finish(result('complete')); await terminal('step-1');
    // Egress mismatch is a frozen offer admission failure on the running fixture.
    start('other','other-task','agent-b');
    const bad = { ...target('agent-b'),egressPolicy: { ...policy,policyRevision: 'different' },taskId: 'bad-egress',instruction: 'test',terminalProjection: { mode: 'result-document' as const,contract: CLARIFICATION_CONTRACT } };
    await byok.dispatchFreshAgentEgress(bad); await terminal('bad-egress');
    expect((await byok.tasks.deviceTerminal('bad-egress'))?.envelope.type).not.toBe('task.complete'); expect(adapter.sessions.has('bad-egress')).toBe(false);
  });
});

describe('strict clarification parser / contract dispatch', () => {
  it.each([
    null,[],{},result('complete',{ extra: true }),result('unknown'),result('needs_input',{ questionId: 'x',question: 'q',checkpoint: 'c',answerKind: 'multi_choice' }),
    { ...question(),options: [{ id: 'same',label: 'one' },{ id: 'same',label: 'two' }] },
    { ...question('text'),options: [] },{ ...question('text'),question: 'q'.repeat(4097) },
    { ...question(),contract: 'Unknown.v1' },
  ])('rejects invalid JSON document %#', doc => { expect(() => parseClarification(doc)).toThrow(); });
  it('rejects non-JSON text and leaves unknown contracts unhandled', () => {
    expect(() => extractClarification('prefix '+JSON.stringify(result('complete')),{ taskId: 'x',sessionRef: 'stub-session',terminalProjection: { mode: 'result-document',contract: CLARIFICATION_CONTRACT } })).toThrow();
    expect(extractClarification('invalid',{ taskId: 'x',sessionRef: 'stub-session',terminalProjection: { mode: 'result-document',contract: 'another.v1' } })).toBeUndefined();
  });
});
