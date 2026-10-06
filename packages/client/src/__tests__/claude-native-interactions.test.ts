import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { createClaudeControlChannel } from '../adapters/claude/control-channel';
import { ClaudeNativeInteractionBridge } from '../adapters/claude/native-interactions';
import type { NativeInteractionHostOptions, NativeInteractionReceipt, NativeInteractionRequest } from '../native-interactions';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixture = fileURLToPath(new URL('./fixtures/claude-native-interactions.mjs', import.meta.url));
const sessions: Session[] = [];
const directories: string[] = [];
const task = { instruction: 'Offline native interaction test', policy: { mode: 'auto' as const } };

async function start(scenario: string, native: NativeInteractionHostOptions | undefined, sessionRef?: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-native-'));
  directories.push(directory);
  const transcript = path.join(directory, 'transcript.jsonl');
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: fixture, source: 'path' }), nativeInteractions: native });
  const session = await startPreparedOperation(adapter, { ...task, ...(sessionRef === undefined ? {} : { sessionRef }) }, {
    workspaceDir: directory, policy: task.policy,
    env: { ...process.env, CLAUDE_NATIVE_SCENARIO: scenario, CLAUDE_NATIVE_TRANSCRIPT: transcript },
  });
  sessions.push(session);
  const frames = async () => (await fs.readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, any>);
  return { adapter, session, frames };
}
async function takeTurn(session: Session) {
  const events = [];
  for await (const event of session.events) { events.push(event); if (event.type === 'turn_end') break; }
  return events;
}
async function requested(requests: NativeInteractionRequest[]) {
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  return requests[0]!;
}
function responseFrames(frames: Record<string, any>[]) { return frames.filter(frame => frame.type === 'control_response'); }

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe('Claude native interactions through prepared process transport', () => {
  it('omits native capability, handshake and stdio flag by default', async () => {
    const { adapter, session, frames } = await start('approval', undefined);
    expect(adapter.descriptor.capabilities.nativeInteractions).toBeUndefined();
    expect(adapter.descriptor.capabilities.approvalInteractive).toBe(false);
    expect(session.interactions).toBeUndefined();
    await takeTurn(session);
    const sent = await frames();
    expect(sent[0]!.argv).not.toContain('--permission-prompt-tool');
    expect(sent.filter(frame => frame.type === 'control_request')).toEqual([]);
  });

  it('initializes before the user frame and sends exact one-shot approval without persistent grants', async () => {
    const requests: NativeInteractionRequest[] = [];
    const { adapter, session, frames } = await start('approval', { onRequest: request => { requests.push(request); } });
    expect(await adapter.detect()).toMatchObject({ kind: 'available', version: '2.1.0-native-fixture', authPresent: true });
    expect(adapter.descriptor.capabilities.nativeInteractions).toEqual({ approvalDecisions: ['allow-once', 'deny', 'cancel'], structuredQuestions: true });
    expect(adapter.descriptor.capabilities.approvalInteractive).toBe(false);
    const request = await requested(requests);
    expect(request.native).toEqual({ id: 'native-request-1', method: 'can_use_tool', sessionRef: session.sessionRef, itemId: 'tool-use-1' });
    expect(request.requestId).not.toBe(request.native.id);
    expect(request.requestId).not.toBe(request.native.itemId);
    expect(request).toMatchObject({ kind: 'approval', details: { toolName: 'Bash', input: { command: 'echo offline-fixture', nested: { exact: true } } } });
    await expect(session.interactions!.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-session' })).rejects.toMatchObject({ code: 'invalid_response' });
    const answer = { kind: 'approval' as const, requestId: request.requestId, decision: 'allow-once' as const };
    const receipt = await session.interactions!.respond(answer);
    expect(receipt.status).toBe('responded');
    expect(await session.interactions!.respond(answer)).toEqual(receipt);
    await expect(session.interactions!.respond({ ...answer, decision: 'deny' })).rejects.toMatchObject({ code: 'response_conflict' });
    expect((await takeTurn(session)).map(event => event.type)).toContain('turn_end');
    const sent = await frames();
    expect(sent[0]!.argv).toContain('--permission-prompt-tool');
    expect(sent[1]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', hooks: null } });
    expect(sent[2]!.type).toBe('user');
    expect(responseFrames(sent)).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'native-request-1', response: { behavior: 'allow', updatedInput: { command: 'echo offline-fixture', nested: { exact: true } } } } }]);
    expect(JSON.stringify(sent)).not.toContain('updatedPermissions');
    await expect(session.resolveApproval(true)).rejects.toThrow();
    await expect(session.steer('do this instead')).rejects.toThrow();
  });

  it('returns structured multi-question answers with original text and labels and no extra user frame', async () => {
    const requests: NativeInteractionRequest[] = [];
    const { session, frames } = await start('questions', { onRequest: request => { requests.push(request); } });
    const request = await requested(requests);
    expect(request.kind).toBe('question');
    if (request.kind !== 'question') throw new Error('expected questions');
    expect(request.questions.map(question => question.id)).toEqual(['0', '1', '2']);
    const answers = [
      { questionId: '0', selectedOptionIds: ['1'] },
      { questionId: '1', selectedOptionIds: ['1', '0'] },
      { questionId: '2', selectedOptionIds: [], text: 'Exact free text' },
    ];
    await expect(session.interactions!.respond({ kind: 'question', requestId: request.requestId, answers: [{ ...answers[0]!, text: 'ambiguous' }, ...answers.slice(1)] })).rejects.toMatchObject({ code: 'invalid_response' });
    await session.interactions!.respond({ kind: 'question', requestId: request.requestId, answers });
    await takeTurn(session);
    const sent = await frames();
    expect(sent.filter(frame => frame.type === 'user')).toHaveLength(1);
    const wire = responseFrames(sent);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.response).toMatchObject({ request_id: 'native-request-1', subtype: 'success', response: { behavior: 'allow', updatedInput: { answers: { 'Which framework?': 'Vue', 'Which checks?': ['Unit', 'Integration'] } } } });
    expect(Object.hasOwn(wire[0]!.response.response.updatedInput.answers, '__proto__')).toBe(true);
    expect(wire[0]!.response.response.updatedInput.answers.__proto__).toBe('Exact free text');
    expect(wire[0]!.response.response.updatedInput.questions).toEqual(request.questions.map(question => ({ question: question.prompt, header: question.header, options: question.options.map(({ label, description }) => ({ label, description })), multiSelect: question.multiple })));
    expect(JSON.stringify(sent)).not.toContain('updatedPermissions');
  });

  it.each(['deny', 'cancel'] as const)('sends %s through control_response only', async decision => {
    const requests: NativeInteractionRequest[] = [];
    const { session, frames } = await start('approval', { onRequest: request => { requests.push(request); } });
    const request = await requested(requests);
    await session.interactions!.respond({ kind: 'approval', requestId: request.requestId, decision });
    await takeTurn(session);
    const sent = responseFrames(await frames());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.response).toMatchObject({ request_id: 'native-request-1', response: { behavior: 'deny' } });
    expect(sent[0]!.response.response.interrupt).toBe(decision === 'cancel' ? true : undefined);
    expect(sent[0]!.response.response.updatedPermissions).toBeUndefined();
  });

  it('cancels a question with deny+interrupt rather than fabricated answers', async () => {
    const requests: NativeInteractionRequest[] = [];
    const { session, frames } = await start('questions', { onRequest: request => { requests.push(request); } });
    const request = await requested(requests);
    await session.interactions!.respond({ kind: 'cancel', requestId: request.requestId });
    await takeTurn(session);
    expect(responseFrames(await frames())[0]!.response.response).toEqual({ behavior: 'deny', message: 'Native interaction cancelled', interrupt: true });
  });

  it('timeout sends deny+interrupt and rejects a late answer', async () => {
    const requests: NativeInteractionRequest[] = [];
    const receipts: NativeInteractionReceipt[] = [];
    const { session, frames } = await start('approval', { timeoutMs: 60, onRequest: request => { requests.push(request); }, onResolved: receipt => { receipts.push(receipt); } });
    const request = await requested(requests);
    await takeTurn(session);
    expect(receipts).toContainEqual({ requestId: request.requestId, status: 'timed-out', reason: 'deadline' });
    await expect(session.interactions!.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-once' })).rejects.toMatchObject({ code: 'request_settled' });
    expect(responseFrames(await frames())[0]!.response.response).toEqual({ behavior: 'deny', message: 'Native interaction timed out', interrupt: true });
  });

  it.each([['provider-cancel', 'provider-cancelled'], ['turn-end', 'turn-ended'], ['process-exit', 'process-exited']] as const)('%s invalidates the request without a response', async (scenario, reason) => {
    const requests: NativeInteractionRequest[] = [];
    const receipts: NativeInteractionReceipt[] = [];
    const { session, frames } = await start(scenario, { onRequest: request => { requests.push(request); }, onResolved: receipt => { receipts.push(receipt); } });
    const request = await requested(requests);
    await vi.waitFor(() => expect(receipts).toContainEqual({ requestId: request.requestId, status: 'cancelled', reason }));
    await expect(session.interactions!.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-once' })).rejects.toMatchObject({ code: 'request_settled' });
    expect(session.interactions!.pending()).toEqual([]);
    expect(responseFrames(await frames())).toEqual([]);
  });

  it('interrupt withdraws before the native ACK and does not write an approval response', async () => {
    const requests: NativeInteractionRequest[] = [];
    const receipts: NativeInteractionReceipt[] = [];
    const { session, frames } = await start('approval', { onRequest: request => { requests.push(request); }, onResolved: receipt => { receipts.push(receipt); } });
    const request = await requested(requests);
    await session.interrupt();
    expect(receipts).toContainEqual({ requestId: request.requestId, status: 'cancelled', reason: 'interrupted' });
    await expect(session.interactions!.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-once' })).rejects.toMatchObject({ code: 'request_settled' });
    expect(responseFrames(await frames())).toEqual([]);
    expect((await frames()).filter(frame => frame.type === 'control_request').map(frame => frame.request.subtype)).toEqual(['initialize', 'interrupt']);
  });

  it('close invalidates and resume assigns a new generation even when native IDs repeat', async () => {
    const firstRequests: NativeInteractionRequest[] = [];
    const first = await start('approval', { onRequest: request => { firstRequests.push(request); } });
    const oldRequest = await requested(firstRequests);
    await first.session.close();
    expect(first.session.interactions!.pending()).toEqual([]);
    const resumedRequests: NativeInteractionRequest[] = [];
    const resumed = await start('approval', { onRequest: request => { resumedRequests.push(request); } }, first.session.sessionRef);
    const newRequest = await requested(resumedRequests);
    expect(newRequest.native.id).toBe(oldRequest.native.id);
    expect(newRequest.native.sessionRef).toBe(oldRequest.native.sessionRef);
    expect(newRequest.generation).not.toBe(oldRequest.generation);
    await expect(resumed.session.interactions!.respond({ kind: 'approval', requestId: oldRequest.requestId, decision: 'allow-once' })).rejects.toMatchObject({ code: 'unknown_request' });
    await resumed.session.interactions!.respond({ kind: 'approval', requestId: newRequest.requestId, decision: 'deny' });
    await takeTurn(resumed.session);
  });

  it('re-arms native requests for a follow-up turn on the same generation', async () => {
    const requests: NativeInteractionRequest[] = [];
    const { session, frames } = await start('approval', { onRequest: request => { requests.push(request); } });
    const first = await requested(requests);
    await session.interactions!.respond({ kind: 'approval', requestId: first.requestId, decision: 'allow-once' });
    await takeTurn(session);
    await session.followUp({ ...task, instruction: 'Second offline turn' });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const second = requests[1]!;
    expect(second.generation).toBe(first.generation);
    expect(second.native.id).toBe('native-request-2');
    await session.interactions!.respond({ kind: 'approval', requestId: second.requestId, decision: 'allow-once' });
    await takeTurn(session);
    expect(responseFrames(await frames())).toHaveLength(2);
  });

  it('refuses a mismatched resume identity before exposing a native callback', async () => {
    const onRequest = vi.fn();
    await expect(start('wrong-resume', { onRequest }, 'requested-session')).rejects.toThrow();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'missing-id', 'duplicate-question', 'duplicate-option', 'duplicate-id'])('fails closed and disposes for %s', async scenario => {
    const requests: NativeInteractionRequest[] = [];
    const { session, frames } = await start(scenario, { onRequest: request => { requests.push(request); } });
    await expect(takeTurn(session)).rejects.toThrow(/ended before a terminal result/);
    expect(requests).toHaveLength(scenario === 'duplicate-id' ? 1 : 0);
    expect(session.interactions!.pending()).toEqual([]);
    expect(responseFrames(await frames())).toEqual([]);
  });

  it.each(['init-error', 'init-exit'])('fails startup before sending a user message on %s', async scenario => {
    await expect(start(scenario, { onRequest: () => {} })).rejects.toThrow(/initialization failed/);
    const transcript = path.join(directories[directories.length - 1]!, 'transcript.jsonl');
    const frames = (await fs.readFile(transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type?: string });
    expect(frames.some(frame => frame.type === 'user')).toBe(false);
  });

  it.each(['readonly', 'plan', 'confirm'] as const)('keeps %s policy unsupported with native callbacks enabled', async mode => {
    const resolveBin = vi.fn(() => ({ command: fixture, source: 'path' as const }));
    const adapter = new ClaudeAdapter({ resolveBin, nativeInteractions: { onRequest: () => {} } });
    const result = await adapter.prepare({ offer: task, policy: { mode }, descriptor: adapter.descriptor, requiredToolsetIds: [] });
    expect(result).toMatchObject({ kind: 'reject', retryable: false });
    expect(resolveBin).not.toHaveBeenCalled();
  });
});

describe('Claude native bridge transport fencing', () => {
  const permission = { type: 'control_request', request_id: 'native-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fixture' }, tool_use_id: 'tool-1' } };
  function bridge(write: (frame: Record<string, unknown>) => Promise<void>, onFatal = vi.fn(), extras: Partial<NativeInteractionHostOptions> = {}) {
    const requests: NativeInteractionRequest[] = [];
    const native = new ClaudeNativeInteractionBridge({ onRequest: request => { requests.push(request); }, onFatal, ...extras });
    native.bind(write);
    native.beginTurn();
    native.receive({ type: 'system', subtype: 'init', session_id: 'session-1' });
    native.receive(permission);
    return { native, request: requests[0]!, onFatal };
  }

  it('does not expose or answer a tool outside sealed policy authority', () => {
    const onFatal = vi.fn(); const onRequest = vi.fn(); const write = vi.fn(async () => {});
    const native = new ClaudeNativeInteractionBridge({ onRequest, onFatal }, undefined, name => name === 'Read');
    native.bind(write); native.beginTurn(); native.receive({ type: 'system', subtype: 'init', session_id: 'session' }); native.receive(permission);
    expect(onRequest).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(onFatal).toHaveBeenCalledOnce(); native.close();
  });
  it('provider cancellation fences a response queued in the same tick', async () => {
    const write = vi.fn(async () => {});
    const { native, request } = bridge(write);
    const responding = native.channel.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-once' });
    native.receive({ type: 'control_cancel_request', request_id: 'native-1' });
    expect(await responding).toMatchObject({ status: 'cancelled', reason: 'provider-cancelled' });
    expect(write).not.toHaveBeenCalled();
    native.close();
  });

  it('cancel with interrupt invalidates all other requests in that turn', async () => {
    const receipts: NativeInteractionReceipt[] = [];
    const write = vi.fn(async () => {});
    const { native, request } = bridge(write, vi.fn(), { onResolved: receipt => { receipts.push(receipt); } });
    native.receive({ ...permission, request_id: 'native-2' });
    const other = native.channel.pending().find(pending => pending.requestId !== request.requestId)!;
    await native.channel.respond({ kind: 'cancel', requestId: request.requestId });
    expect(receipts).toContainEqual({ requestId: other.requestId, status: 'cancelled', reason: 'interrupted' });
    await expect(native.channel.respond({ kind: 'approval', requestId: other.requestId, decision: 'allow-once' })).rejects.toMatchObject({ code: 'request_settled' });
    expect(write).toHaveBeenCalledTimes(1);
    native.close();
  });

  it.each([
    { ...permission, request_id: 1 },
    { ...permission, request: { ...permission.request, input: [] } },
    { ...permission, request: { ...permission.request, tool_use_id: 1 } },
    { ...permission, request: { ...permission.request, input: { large: 'x'.repeat(65_536) } } },
  ])('disposes malformed control input without opening or answering it', message => {
    const onFatal = vi.fn();
    const onRequest = vi.fn();
    const write = vi.fn(async () => {});
    const native = new ClaudeNativeInteractionBridge({ onRequest, onFatal });
    native.bind(write);
    native.beginTurn();
    native.receive({ type: 'system', subtype: 'init', session_id: 'session-1' });
    native.receive(message);
    expect(onRequest).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('bounds initialization and never mistakes an initialize ACK for an interrupt ACK', async () => {
    vi.useFakeTimers();
    const control = createClaudeControlChannel(20);
    const write = vi.fn(async (_frame: Record<string, unknown>) => {});
    control.bind(write);
    const initialized = control.initialize();
    expect(await control.interrupt()).toBe(false);
    control.receive({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await initialized).toBe(false);
    const interrupted = control.interrupt();
    control.receive({ type: 'control_response', response: { subtype: 'success', request_id: write.mock.calls[0]![0].request_id } });
    await vi.advanceTimersByTimeAsync(20);
    expect(await interrupted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('write rejection invokes owner fatal handling exactly once and settles outstanding requests', async () => {
    const { native, request, onFatal } = bridge(async () => { throw new Error('pipe failed'); });
    expect(await native.channel.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-once' })).toMatchObject({ status: 'failed', reason: 'transport' });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(native.channel.pending()).toEqual([]);
  });

  it('an uncertain write remains fatal after provider cancellation', async () => {
    vi.useFakeTimers();
    const write = vi.fn(() => new Promise<void>(() => {}));
    const { native, request, onFatal } = bridge(write, vi.fn(), { writeTimeoutMs: 20 });
    const responding = native.channel.respond({ kind: 'approval', requestId: request.requestId, decision: 'allow-once' });
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    native.receive({ type: 'control_cancel_request', request_id: 'native-1' });
    expect(await responding).toMatchObject({ status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(20);
    expect(onFatal).toHaveBeenCalledTimes(1);
    native.close();
  });
});
