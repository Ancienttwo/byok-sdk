import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeInteractionController, NativeInteractionError, type NativeInteractionInput, type NativeInteractionOptions, type NativeInteractionRequest, type NativeInteractionResponse } from '../native-interactions';
import { freezeRuntimeAdapterDescriptor } from '../types';
const approval = (id: string | number = 'native-1'): NativeInteractionInput => ({
  kind: 'approval', title: 'Run the command?', decisions: ['allow-once', 'deny'],
  native: { id, method: 'native/approval', sessionRef: 'provider-session', turnId: 'turn', itemId: 'item' },
});
const questions = (): NativeInteractionInput => ({
  kind: 'question', native: { id: 'questions', method: 'native/questions', sessionRef: 'provider-session' },
  questions: [
    { id: 'a', prompt: 'Pick a color', options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }], multiple: false, allowText: false },
    { id: 'b', prompt: 'Choose extras', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], multiple: true, allowText: true },
  ],
});
const controllers: NativeInteractionController[] = [];
function setup(options: Partial<NativeInteractionOptions> = {}) {
  const onFatal = vi.fn(); const onResolved = vi.fn(); const onRequest = vi.fn();
  const controller = new NativeInteractionController({ onRequest, onResolved, onFatal, timeoutMs: 100, writeTimeoutMs: 20, ...options });
  controllers.push(controller);
  const transport = { respond: vi.fn(async (_answer: NativeInteractionResponse) => {}), cancel: vi.fn(async (_reason: 'deadline' | 'cancelled') => {}) };
  return { controller, channel: controller.channel, transport, onFatal, onResolved, onRequest };
}
const answer = (r: NativeInteractionRequest, decision = 'allow-once'): NativeInteractionResponse => ({ requestId: r.requestId, kind: 'approval', decision } as NativeInteractionResponse);
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); vi.useRealTimers(); });
describe('native interaction process-lifetime contract', () => {
  it('preserves wire identity and immutable request snapshots without steering', async () => {
    const f = setup(); const input = approval(7); const r = f.controller.open(input, f.transport);
    expect(r.native).toEqual(input.native); expect(r.native.id).toBe(7);
    expect(r.requestId).not.toBe(r.native.id); expect(r.generation).toBe(f.channel.generation);
    expect(Object.isFrozen(r.native)).toBe(true); expect(Object.isFrozen(r)).toBe(true);
    expect(f.channel.pending()).toEqual([r]); expect(f.onRequest).toHaveBeenCalledWith(r, f.channel);
    expect(await f.channel.respond(answer(r))).toEqual({ requestId: r.requestId, status: 'responded' });
    expect(f.transport.respond).toHaveBeenCalledWith(answer(r)); expect(f.transport.cancel).not.toHaveBeenCalled();
    expect(f.channel.pending()).toEqual([]);
  });
  it('does not conflate numeric and string wire ids', () => {
    const f = setup(); const numeric = f.controller.open(approval(7), f.transport); const string = f.controller.open(approval('7'), f.transport);
    expect(numeric.requestId).not.toBe(string.requestId); expect(f.channel.pending()).toHaveLength(2);
  });
  it('rejects repeated native ids rather than silently opening a second callback', async () => {
    const f = setup(); const r = f.controller.open(approval(), f.transport);
    expect(() => f.controller.open(approval(), f.transport)).toThrowError(expect.objectContaining({ code: 'duplicate_request' }));
    await f.channel.respond(answer(r));
    expect(() => f.controller.open(approval(), f.transport)).toThrowError(expect.objectContaining({ code: 'duplicate_request' }));
  });
  it('joins concurrent equal answers and reuses their terminal receipt with one native write', async () => {
    const f = setup(); let release!: () => void; f.transport.respond.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const r = f.controller.open(approval(), f.transport); const first = f.channel.respond(answer(r));
    const second = f.channel.respond({ decision: 'allow-once', kind: 'approval', requestId: r.requestId });
    await Promise.resolve(); expect(f.transport.respond).toHaveBeenCalledTimes(1); release();
    expect(await first).toEqual(await second); expect(await f.channel.respond(answer(r))).toEqual(await first);
    expect(f.transport.respond).toHaveBeenCalledTimes(1); expect(f.onResolved).toHaveBeenCalledTimes(1);
  });
  it('rejects a conflicting second answer before another write', async () => {
    const f = setup(); const r = f.controller.open(approval(), f.transport); const first = f.channel.respond(answer(r));
    await expect(f.channel.respond(answer(r, 'deny'))).rejects.toMatchObject({ code: 'response_conflict' }); await first;
    await expect(f.channel.respond(answer(r, 'deny'))).rejects.toMatchObject({ code: 'response_conflict' });
    expect(f.transport.respond).toHaveBeenCalledTimes(1);
  });
  it('never broadens allow-once into a session or persistent grant', async () => {
    const f = setup(); const r = f.controller.open(approval(), f.transport);
    for (const decision of ['allow-session', 'allow-always']) await expect(f.channel.respond(answer(r, decision))).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.channel.pending()).toEqual([r]); await f.channel.respond(answer(r));
    expect(f.transport.respond).toHaveBeenCalledWith(answer(r));
  });
  it('allows session scope only when explicitly advertised on this native request', async () => {
    const f = setup(); const r = f.controller.open({ ...approval(), kind: 'approval', title: 'Approve?', decisions: ['allow-once', 'allow-session', 'deny'] }, f.transport);
    await f.channel.respond(answer(r, 'allow-session')); expect(f.transport.respond).toHaveBeenCalledWith(answer(r, 'allow-session'));
  });
  it('keeps structured multi-question answers and canonicalizes equivalent ordering', async () => {
    const f = setup(); const r = f.controller.open(questions(), f.transport);
    const reply: NativeInteractionResponse = { requestId: r.requestId, kind: 'question', answers: [
      { questionId: 'b', selectedOptionIds: ['y', 'x'], text: 'and Z' }, { questionId: 'a', selectedOptionIds: ['red'] },
    ] };
    await f.channel.respond(reply);
    await f.channel.respond({ ...reply, answers: [{ questionId: 'a', selectedOptionIds: ['red'] }, { questionId: 'b', selectedOptionIds: ['x', 'y'], text: 'and Z' }] });
    expect(f.transport.respond).toHaveBeenCalledTimes(1);
    expect(f.transport.respond.mock.calls[0]![0]).toEqual({ requestId: r.requestId, kind: 'question', answers: [
      { questionId: 'a', selectedOptionIds: ['red'] }, { questionId: 'b', selectedOptionIds: ['x', 'y'], text: 'and Z' },
    ] });
  });
  it.each([
    [],
    [{ questionId: 'a', selectedOptionIds: ['red'] }, { questionId: 'a', selectedOptionIds: ['blue'] }],
    [{ questionId: 'a', selectedOptionIds: ['red', 'blue'] }, { questionId: 'b', selectedOptionIds: ['x'] }],
    [{ questionId: 'a', selectedOptionIds: ['unknown'] }, { questionId: 'b', selectedOptionIds: ['x'] }],
    [{ questionId: 'a', selectedOptionIds: [], text: 'forbidden' }, { questionId: 'b', selectedOptionIds: ['x'] }],
    [{ questionId: 'a', selectedOptionIds: ['red'] }, { questionId: 'b', selectedOptionIds: ['x', 'x'] }],
    [{ questionId: 'a', selectedOptionIds: ['red'] }, { questionId: 'b', selectedOptionIds: [], text: '  ' }],
  ].map(answers => ({ answers })))('rejects malformed question answers without consuming the request ($answers)', async ({ answers }) => {
    const f = setup(); const r = f.controller.open(questions(), f.transport);
    await expect(f.channel.respond({ requestId: r.requestId, kind: 'question', answers })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.channel.pending()).toEqual([r]); expect(f.transport.respond).not.toHaveBeenCalled();
  });
  it('cancels explicitly through the native cancel transport, never an empty answer', async () => {
    const f = setup(); const r = f.controller.open(questions(), f.transport);
    expect(await f.channel.respond({ requestId: r.requestId, kind: 'cancel' })).toMatchObject({ status: 'cancelled' });
    expect(f.transport.cancel).toHaveBeenCalledWith('cancelled'); expect(f.transport.respond).not.toHaveBeenCalled();
  });
  it('timeout sends one fail-closed native cancellation and rejects late answers', async () => {
    vi.useFakeTimers(); const f = setup(); const r = f.controller.open(approval(), f.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.transport.cancel).toHaveBeenCalledExactlyOnceWith('deadline'); expect(f.onResolved).toHaveBeenCalledWith({ requestId: r.requestId, status: 'timed-out', reason: 'deadline' });
    await expect(f.channel.respond(answer(r))).rejects.toMatchObject({ code: 'request_settled' }); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['provider-cancelled', 'interrupted', 'turn-ended', 'process-exited', 'closed'] as const)('invalidates %s without writing another native reply', async reason => {
    const f = setup(); const r = f.controller.open(approval(), f.transport); f.controller.withdraw(r.requestId, reason);
    await expect(f.channel.respond(answer(r))).rejects.toMatchObject({ code: 'request_settled' });
    expect(f.transport.respond).not.toHaveBeenCalled(); expect(f.transport.cancel).not.toHaveBeenCalled();
    expect(f.onResolved).toHaveBeenCalledWith({ requestId: r.requestId, status: 'cancelled', reason });
  });
  it('process exit fences a response queued before its transport write', async () => {
    const f = setup(); const r = f.controller.open(approval(), f.transport); const receipt = f.channel.respond(answer(r)); f.controller.close('process-exited');
    expect(await receipt).toMatchObject({ status: 'cancelled', reason: 'process-exited' });
    await Promise.resolve(); expect(f.transport.respond).not.toHaveBeenCalled();
    expect(() => f.controller.open(approval('next'), f.transport)).toThrowError(expect.objectContaining({ code: 'closed' }));
  });
  it('provider cancellation wins a late write completion and never reopens a request', async () => {
    const f = setup(); let release!: () => void; f.transport.respond.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const r = f.controller.open(approval(), f.transport); const receipt = f.channel.respond(answer(r)); await Promise.resolve();
    f.controller.withdraw(r.requestId); release(); expect(await receipt).toMatchObject({ status: 'cancelled' });
    expect(f.onResolved).toHaveBeenCalledTimes(1); expect(f.channel.pending()).toEqual([]);
  });
  it.each(['hang', 'reject'] as const)('retains disposal ownership after cancellation of a started write (%s)', async outcome => {
    vi.useFakeTimers(); const f = setup(); let reject!: (error: Error) => void;
    f.transport.respond.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const r = f.controller.open(approval(), f.transport); const receipt = f.channel.respond(answer(r)); await Promise.resolve();
    f.controller.withdraw(r.requestId); expect(await receipt).toMatchObject({ status: 'cancelled' });
    if (outcome === 'reject') reject(new Error('late pipe error'));
    await vi.advanceTimersByTimeAsync(20);
    expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.onResolved).toHaveBeenCalledTimes(1);
    expect(() => f.controller.open(approval('next'), f.transport)).toThrowError(expect.objectContaining({ code: 'closed' }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('failed native writes invalidate the whole process generation and are never retried', async () => {
    const f = setup(); f.transport.respond.mockRejectedValue(new Error('pipe')); const r = f.controller.open(approval(), f.transport); const other = f.controller.open(approval('other'), f.transport);
    expect(await f.channel.respond(answer(r))).toMatchObject({ status: 'failed', reason: 'transport' });
    expect(await f.channel.respond(answer(r))).toMatchObject({ status: 'failed' });
    await expect(f.channel.respond(answer(other))).rejects.toMatchObject({ code: 'request_settled' });
    expect(f.transport.respond).toHaveBeenCalledTimes(1); expect(f.onFatal).toHaveBeenCalledOnce();
  });
  it('bounds an uncertain native write and ignores its eventual resolution', async () => {
    vi.useFakeTimers(); const f = setup(); let release!: () => void; f.transport.respond.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const r = f.controller.open(approval(), f.transport); const receipt = f.channel.respond(answer(r)); await vi.advanceTimersByTimeAsync(20);
    expect(await receipt).toMatchObject({ status: 'failed' }); release(); await Promise.resolve();
    expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.onResolved).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a timeout denial write as well', async () => {
    vi.useFakeTimers(); const f = setup(); f.transport.cancel.mockImplementation(() => new Promise(() => {})); f.controller.open(approval(), f.transport);
    await vi.advanceTimersByTimeAsync(120); expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
  it('fails closed when a host request observer throws', async () => {
    const f = setup({ onRequest: () => { throw new Error('observer'); } }); f.controller.open(approval(), f.transport);
    await Promise.resolve(); await Promise.resolve(); expect(f.transport.cancel).toHaveBeenCalledExactlyOnceWith('cancelled');
  });
  it('consumes async host callback failures and cancels an unanswered request once', async () => {
    const f = setup({ onRequest: async () => { throw new Error('host prompt failed'); }, onResolved: async () => { throw new Error('observer failed'); } });
    f.controller.open(approval(), f.transport);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.transport.cancel).toHaveBeenCalledExactlyOnceWith('cancelled'); expect(f.channel.pending()).toEqual([]);
  });
  it('consumes async fatal callback rejection without reopening or retrying', async () => {
    const f = setup({ onFatal: async () => { throw new Error('owner disposal failed'); } });
    f.transport.respond.mockRejectedValue(new Error('pipe')); const r = f.controller.open(approval(), f.transport);
    expect(await f.channel.respond(answer(r))).toMatchObject({ status: 'failed' });
    await new Promise(resolve => setImmediate(resolve));
    expect(() => f.controller.open(approval('next'), f.transport)).toThrowError(expect.objectContaining({ code: 'closed' }));
  });
  it('an observer can answer synchronously and observer failure cannot duplicate a write', async () => {
    const f = setup({ onRequest: (r, channel) => { void channel.respond(answer(r)); throw new Error('after answer'); }, onResolved: () => { throw new Error('observer'); } });
    const r = f.controller.open(approval(), f.transport); await f.channel.respond(answer(r));
    expect(f.transport.respond).toHaveBeenCalledTimes(1); expect(f.transport.cancel).not.toHaveBeenCalled();
  });
  it('resuming the same provider session starts with a new generation and no old requests', async () => {
    const first = setup(); const old = first.controller.open(approval(), first.transport); first.controller.close('process-exited');
    const resumed = setup(); const fresh = resumed.controller.open(approval(), resumed.transport);
    expect(fresh.native).toEqual(old.native); expect(fresh.generation).not.toBe(old.generation);
    await expect(resumed.channel.respond(answer(old))).rejects.toMatchObject({ code: 'unknown_request' });
    expect(resumed.channel.pending()).toEqual([fresh]);
  });
  it('counts a withdrawn but still-owned transport against the pending capacity', async () => {
    const f = setup({ maxPending: 1 }); f.transport.respond.mockImplementation(() => new Promise(() => {}));
    const r = f.controller.open(approval(), f.transport); void f.channel.respond(answer(r)); await Promise.resolve(); f.controller.withdraw(r.requestId);
    expect(f.channel.pending()).toEqual([]);
    expect(() => f.controller.open(approval('next'), f.transport)).toThrowError(expect.objectContaining({ code: 'capacity' }));
  });
  it('one process has one fatal disposal notification across simultaneous failed writes', async () => {
    vi.useFakeTimers(); const f = setup(); f.transport.respond.mockImplementation(() => new Promise(() => {}));
    const a = f.controller.open(approval('a'), f.transport); const b = f.controller.open(approval('b'), f.transport);
    void f.channel.respond(answer(a)); void f.channel.respond(answer(b)); await vi.advanceTimersByTimeAsync(20);
    expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.onResolved).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds both pending requests and retained lifetime identities without eviction', async () => {
    const f = setup({ maxPending: 1, maxRequests: 2 }); const first = f.controller.open(approval('1'), f.transport);
    expect(() => f.controller.open(approval('2'), f.transport)).toThrowError(expect.objectContaining({ code: 'capacity' }));
    await f.channel.respond(answer(first)); const second = f.controller.open(approval('2'), f.transport); await f.channel.respond(answer(second));
    expect(() => f.controller.open(approval('3'), f.transport)).toThrowError(expect.objectContaining({ code: 'capacity' }));
    expect(() => f.controller.open(approval('1'), f.transport)).toThrowError(expect.objectContaining({ code: 'duplicate_request' }));
  });
  it.each([0, -1, NaN, Infinity, 1.1, 2_147_483_648])('rejects invalid bounds before registration (%s)', value => {
    expect(() => setup({ timeoutMs: value })).toThrow(TypeError); expect(() => setup({ writeTimeoutMs: value })).toThrow(TypeError);
  });
  it('rejects invalid or oversized requests without a callback', () => {
    const f = setup();
    for (const input of [approval(NaN), { ...approval(), title: 'x'.repeat(65536) }, { ...approval(), decisions: ['allow-always'] }, { ...approval(), extra: 'unrecognized' }]) {
      expect(() => f.controller.open(input as NativeInteractionInput, f.transport)).toThrow(NativeInteractionError);
    }
    expect(f.onRequest).not.toHaveBeenCalled();
  });
  it('accepts explicit undefined only in typed optional fields without hiding unknown fields', async () => {
    const f = setup(); const r = f.controller.open({ kind: 'question', native: { ...approval().native, turnId: undefined, itemId: undefined }, questions: [
      { id: 'q', prompt: 'Choose', header: undefined, secret: undefined, options: [{ id: 'a', label: 'A', description: undefined }], multiple: false, allowText: false },
    ] }, f.transport);
    await f.channel.respond({ requestId: r.requestId, kind: 'question', answers: [{ questionId: 'q', selectedOptionIds: ['a'], text: undefined }] });
    expect(f.transport.respond).toHaveBeenCalledOnce();
    expect(() => f.controller.open({ ...approval('extra'), unknown: undefined } as unknown as NativeInteractionInput, f.transport)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    const next = f.controller.open(approval('next'), f.transport);
    await expect(f.channel.respond({ ...answer(next), unknown: undefined } as unknown as NativeInteractionResponse)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects accessors, proxies, custom prototypes and hidden fields without executing them', async () => {
    const f = setup(); const trap = vi.fn(() => 'native-1');
    const getter = { ...approval(), native: { ...approval().native, get id() { return trap(); } } };
    const proxy = new Proxy(approval(), { get: trap });
    const inherited = Object.assign(Object.create({ toJSON: trap }), approval());
    const hidden = Object.defineProperty(approval(), 'hidden', { value: 'data' });
    for (const input of [getter, proxy, inherited, hidden]) expect(() => f.controller.open(input as NativeInteractionInput, f.transport)).toThrow(NativeInteractionError);
    const r = f.controller.open(approval(), f.transport);
    await expect(f.channel.respond({ ...answer(r), get requestId() { return trap(); } })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(trap).not.toHaveBeenCalled();
  });
  it('freezes explicit capabilities and leaves omission unsupported', () => {
    const base = { id: 'custom', supportsDispatchSelection: false, environmentRequirements: { credentialNames: [] }, capabilities: { steer: false, resume: false, approvalInteractive: false, permissionModes: ['auto'] } };
    expect(freezeRuntimeAdapterDescriptor(base).capabilities.nativeInteractions).toBeUndefined();
    const declared = ['allow-once', 'deny'] as ('allow-once' | 'deny')[];
    const frozen = freezeRuntimeAdapterDescriptor({ ...base, capabilities: { ...base.capabilities, nativeInteractions: { approvalDecisions: declared, structuredQuestions: true } } });
    declared.pop(); expect(frozen.capabilities.nativeInteractions?.approvalDecisions).toEqual(['allow-once', 'deny']);
    expect(Object.isFrozen(frozen.capabilities.nativeInteractions)).toBe(true);
  });
});
