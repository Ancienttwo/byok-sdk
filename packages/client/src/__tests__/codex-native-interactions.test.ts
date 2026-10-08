import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { CodexNativeInteractions } from '../adapters/codex/native-interactions';
import type { NativeInteractionChannel, NativeInteractionRequest, NativeInteractionHostOptions } from '../native-interactions';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';
const fixture = fileURLToPath(new URL('./fixtures/fake-codex-native-interactions.mjs', import.meta.url));
const sessions: Session[] = []; const directories: string[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); vi.useRealTimers(); });
async function open(scenario = 'approval', host?: Partial<NativeInteractionHostOptions>, resume?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'byok-native-codex-')); directories.push(dir); const receipt = path.join(dir, 'frames.jsonl');
  const requests: { request: NativeInteractionRequest; channel: NativeInteractionChannel }[] = [];
  const adapter = new CodexAdapter({ resolveBin: () => ({ command: fixture, source: 'path' }), nativeInteractions: { timeoutMs: 1000, onRequest: (request, channel) => { requests.push({ request, channel }); }, ...host } });
  const session = await startPreparedOperation(adapter, { instruction: 'fixture', ...(resume ? { sessionRef: resume } : {}) }, {
    workspaceDir: dir, env: { PATH: process.env.PATH, FAKE_NATIVE_SCENARIO: scenario, FAKE_NATIVE_RECEIPT: receipt },
  });
  sessions.push(session);
  return { adapter, session, requests, frames: async () => (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as Record<string, any>[] };
}
async function finish(session: Session) { for await (const event of session.events) if (event.type === 'turn_end') break; }
async function first(f: Awaited<ReturnType<typeof open>>) { await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(0)); return f.requests[0]!; }
const approve = (request: NativeInteractionRequest, decision: 'allow-once' | 'allow-session' | 'deny' | 'cancel' = 'allow-once') => ({ requestId: request.requestId, kind: 'approval' as const, decision });
describe('Codex native interaction prepared-adapter bridge', () => {
  it('advertises only explicit opt-in and keeps legacy confirm unsupported', async () => {
    expect(new CodexAdapter().descriptor.capabilities.nativeInteractions).toBeUndefined();
    const f = await open();
    expect(f.adapter.descriptor.capabilities).toMatchObject({ approvalInteractive: false, nativeInteractions: { approvalDecisions: ['allow-once', 'allow-session', 'deny', 'cancel'], structuredQuestions: true } });
    const r = await first(f); await f.session.interactions!.respond(approve(r.request)); await finish(f.session);
    expect((await f.frames()).find(frame => frame.method === 'thread/start')?.params.approvalPolicy).toBe('on-request');
  });
  it.each([['allow-once', 'accept'], ['allow-session', 'acceptForSession'], ['deny', 'decline'], ['cancel', 'cancel']] as const)('maps %s exactly to native %s once', async (decision, native) => {
    const f = await open(); const r = await first(f);
    expect(r.request.native).toMatchObject({ id: 'approval-1', method: 'item/commandExecution/requestApproval', sessionRef: f.session.sessionRef, turnId: 'turn-1', itemId: 'item-1' });
    expect(r.request.kind === 'approval' && r.request.details?.command).toBe('echo fixture');
    const response = approve(r.request, decision); const a = f.session.interactions!.respond(response); const b = f.session.interactions!.respond(response);
    expect(await a).toEqual(await b); await finish(f.session);
    const frames = await f.frames(); expect(frames.filter(frame => frame.id === 'approval-1')).toEqual([{ id: 'approval-1', result: { decision: native } }]);
    expect(frames.some(frame => frame.method === 'turn/steer')).toBe(false);
    await expect(f.session.interactions!.respond(approve(r.request, decision === 'deny' ? 'allow-once' : 'deny'))).rejects.toMatchObject({ code: 'response_conflict' });
  });
  it('keeps structured question IDs/answers and never sends another prompt or steer', async () => {
    const f = await open('question'); const r = await first(f); expect(r.request.kind).toBe('question');
    await r.channel.respond({ requestId: r.request.requestId, kind: 'question', answers: [{ questionId: 'color', selectedOptionIds: ['Blue'] }, { questionId: 'note', selectedOptionIds: [], text: 'Keep it brief' }] });
    await finish(f.session); const frames = await f.frames();
    expect(frames.find(frame => frame.id === 'question-1')).toEqual({ id: 'question-1', result: { answers: { color: { answers: ['Blue'] }, note: { answers: ['Keep it brief'] } } } });
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1); expect(frames.some(frame => frame.method === 'turn/steer')).toBe(false);
  });
  it('echoes numeric and string IDs without collisions, including file approvals', async () => {
    const f = await open('numeric-string'); await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    await Promise.all(f.requests.map(r => r.channel.respond(approve(r.request)))); await finish(f.session);
    expect((await f.frames()).filter(frame => 'result' in frame)).toEqual([{ id: 7, result: { decision: 'accept' } }, { id: '7', result: { decision: 'accept' } }]);
  });
  it('provider resolution withdraws pending requests without a fabricated response', async () => {
    const f = await open('cancel'); const r = await first(f); await finish(f.session);
    await expect(r.channel.respond(approve(r.request))).rejects.toMatchObject({ code: 'request_settled' });
    expect((await f.frames()).some(frame => frame.id === 'approval-1')).toBe(false);
  });
  it('timeout returns a native cancel, not allow or empty answers', async () => {
    const f = await open('approval', { timeoutMs: 30 }); const r = await first(f); await finish(f.session);
    expect((await f.frames()).find(frame => frame.id === 'approval-1')).toEqual({ id: 'approval-1', result: { decision: 'cancel' } });
    await expect(r.channel.respond(approve(r.request))).rejects.toMatchObject({ code: 'request_settled' });
  });
  it('question cancellation returns an RPC error rather than answer text', async () => {
    const f = await open('question'); const r = await first(f); await r.channel.respond({ requestId: r.request.requestId, kind: 'cancel' }); await finish(f.session);
    expect((await f.frames()).find(frame => frame.id === 'question-1')).toEqual({ id: 'question-1', error: { code: -32000, message: 'native user input cancelled' } });
  });
  it('process exit clears pending requests and rejects old answers', async () => {
    const f = await open('exit'); const r = await first(f); await expect(finish(f.session)).rejects.toThrow('exited');
    await expect(r.channel.respond(approve(r.request))).rejects.toMatchObject({ code: 'request_settled' });
  });
  it('interrupt invalidates pending requests and sends only the native interrupt', async () => {
    const f = await open(); const r = await first(f); await f.session.interrupt();
    await expect(r.channel.respond(approve(r.request))).rejects.toMatchObject({ code: 'request_settled' });
    const frames = await f.frames(); expect(frames.some(frame => frame.method === 'turn/interrupt')).toBe(true); expect(frames.some(frame => frame.id === 'approval-1')).toBe(false);
  });
  it('resume has a fresh interaction generation even when the native request ID repeats', async () => {
    const old = await open(); const oldR = await first(old); await old.session.close();
    const fresh = await open('approval', undefined, old.session.sessionRef); const freshR = await first(fresh);
    expect(freshR.request.native.id).toBe(oldR.request.native.id); expect(freshR.request.generation).not.toBe(oldR.request.generation);
    await expect(freshR.channel.respond(approve(oldR.request))).rejects.toMatchObject({ code: 'unknown_request' });
    await freshR.channel.respond(approve(freshR.request)); await finish(fresh.session);
    expect((await fresh.frames()).find(frame => frame.method === 'thread/resume')?.params.approvalPolicy).toBe('on-request');
  });
  it.each(['unknown', 'malformed'])('rejects %s requests without exposing an approval', async scenario => {
    const f = await open(scenario); await finish(f.session); expect(f.requests).toHaveLength(0);
    expect((await f.frames()).find(frame => frame.id === scenario)?.error).toBeDefined();
  });
  it('rejects a wrong resume thread before replaying buffered native callbacks', async () => {
    const onRequest = vi.fn(); await expect(open('wrong-resume', { onRequest }, 'expected-thread')).rejects.toThrow('different thread id');
    expect(onRequest).not.toHaveBeenCalled();
  });
  it('a refused follow-up disables native callbacks until another valid prompt', async () => {
    const f = await open('refused-followup'); const r = await first(f); await r.channel.respond(approve(r.request)); await finish(f.session);
    await expect(f.session.followUp({ instruction: 'refused' })).rejects.toThrow('fixture prompt refused');
    await expect(finish(f.session)).rejects.toThrow(); expect(f.requests).toHaveLength(1);
  });
  it('rejects a mismatched provider policy readback before the first prompt', async () => {
    await expect(open('bad-policy')).rejects.toThrow('approval policy readback mismatch');
  });
});
describe('Codex native notification identity', () => {
  it('admits only the active native turn before exposing Host callbacks', async () => {
    const onRequest = vi.fn(); const bridge = new CodexNativeInteractions(() => 'thread', { onRequest }, vi.fn());
    const reply = { respond: vi.fn(async () => {}), reject: vi.fn(async () => {}), cancelled: vi.fn() };
    bridge.beginTurn();
    bridge.receive('before-start', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'old', itemId: 'item' }, reply);
    bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } });
    bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'new' } });
    bridge.receive('superseded', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'old', itemId: 'item' }, reply);
    expect(onRequest).not.toHaveBeenCalled(); expect(reply.reject).toHaveBeenCalledTimes(2);
    bridge.receive('active', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'new', itemId: 'item' }, reply); expect(onRequest).toHaveBeenCalledOnce();
    bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'new' } });
    expect(() => bridge.receive('after-complete', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'new', itemId: 'item' }, reply)).toThrowError(expect.objectContaining({ code: 'closed' }));
    expect(onRequest).toHaveBeenCalledOnce(); bridge.close();
  });
  it('bounds duplicate IDs across supported and rejected methods, including after close', () => {
    const bridge = new CodexNativeInteractions(() => 'thread', { onRequest: vi.fn(), maxRequests: 2 }, vi.fn());
    const reply = { respond: vi.fn(async () => {}), reject: vi.fn(async () => {}), cancelled: vi.fn() };
    bridge.beginTurn(); bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
    bridge.receive('one', 'unsupported', {}, reply);
    expect(() => bridge.receive('one', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'item' }, reply)).toThrowError(expect.objectContaining({ code: 'duplicate_request' }));
    bridge.receive('two', 'unsupported', {}, reply);
    expect(() => bridge.receive('three', 'unsupported', {}, reply)).toThrowError(expect.objectContaining({ code: 'capacity' }));
    bridge.close(); expect(() => bridge.receive('four', 'unsupported', {}, reply)).toThrowError(expect.objectContaining({ code: 'closed' }));
    expect(reply.reject).toHaveBeenCalledTimes(2);
  });
  it('interrupt fences newly arriving requests until another explicit prompt', () => {
    const onRequest = vi.fn(); const bridge = new CodexNativeInteractions(() => 'thread', { onRequest }, vi.fn());
    const reply = { respond: vi.fn(async () => {}), reject: vi.fn(async () => {}), cancelled: vi.fn() };
    bridge.interrupt();
    expect(() => bridge.receive('late', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'item' }, reply)).toThrowError(expect.objectContaining({ code: 'closed' }));
    expect(onRequest).not.toHaveBeenCalled(); bridge.beginTurn();
    bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'next' } });
    bridge.receive('fresh', 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'next', itemId: 'item' }, reply);
    expect(onRequest).toHaveBeenCalledOnce(); bridge.close();
  });
  it('a different thread or ID cannot withdraw a request; exact turn completion can', async () => {
    let pending!: NativeInteractionRequest;
    const bridge = new CodexNativeInteractions(() => 'thread', { onRequest: r => { pending = r; } }, vi.fn());
    const reply = { respond: vi.fn(async () => {}), reject: vi.fn(async () => {}), cancelled: vi.fn() };
    bridge.beginTurn(); bridge.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
    bridge.receive(7, 'item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'item' }, reply);
    bridge.notification('serverRequest/resolved', { threadId: 'other', requestId: 7 }); bridge.notification('serverRequest/resolved', { threadId: 'thread', requestId: '7' });
    expect(bridge.channel.pending()).toHaveLength(1);
    bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'other' } }); expect(bridge.channel.pending()).toHaveLength(1);
    bridge.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
    expect(reply.cancelled).toHaveBeenCalledOnce(); expect(reply.respond).not.toHaveBeenCalled();
    await expect(bridge.channel.respond(approve(pending))).rejects.toMatchObject({ code: 'request_settled' }); bridge.close();
  });
});
