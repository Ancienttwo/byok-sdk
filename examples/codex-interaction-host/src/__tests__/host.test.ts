import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFixtureHost, type FixtureScenario } from '../index';

type Frame = Record<string, any>;
const ANSWER = { kind: 'question', answers: [
  { questionId: 'color', selectedOptionIds: ['Blue'] },
  { questionId: 'note', selectedOptionIds: [], text: 'LOCAL_ANSWER_NOT_FOR_LOGS' },
] };
const NATIVE_ANSWER = { id: 'question-1', result: { answers: {
  color: { answers: ['Blue'] }, note: { answers: ['LOCAL_ANSWER_NOT_FOR_LOGS'] },
} } };
const responses = (frames: Frame[]) => frames.filter(frame => !frame.method);
const threadCwd = (frames: Frame[]): string => frames.find(frame => frame.method === 'thread/start')?.params.cwd;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function open(scenario: FixtureScenario = 'question', timeoutMs = 10_000) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const receipt = path.join(dir, 'frames.jsonl');
  const input = new PassThrough(); const output = new PassThrough(); let rendered = '';
  output.setEncoding('utf8'); output.on('data', chunk => { rendered += chunk; });
  const run = await startFixtureHost({ scenario, input, output, timeoutMs, fixtureReceiptPath: receipt });
  const settled = run.done.then(() => 'completed' as const, () => 'failed' as const);
  cleanup.push(async () => { await run.close(); await settled; input.destroy(); output.destroy(); });
  const lines = (type: string): Frame[] => rendered.split('\n').filter(line => line.startsWith(`${type} `))
    .map(line => JSON.parse(line.slice(type.length + 1)) as Frame);
  const frames = async (): Promise<Frame[]> => (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const request = async (count = 1) => { await vi.waitFor(() => expect(lines('request')).toHaveLength(count)); return lines('request')[count - 1]!; };
  const answer = (r: Frame, data: Frame = ANSWER) => ({
    hostSessionId: r.hostSessionId, taskId: r.taskId, generation: r.generation, requestId: r.requestId, ...data,
  });
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  return { ...run, input, output, settled, lines, frames, request, answer, send, rendered: () => rendered };
}

describe('local terminal -> public CodexAdapter -> synthetic app-server', () => {
  it('renders the exact native question and delivers explicit answers once without prompt/steer or answer logging', async () => {
    const f = await open(); const r = await f.request();
    expect(r).toMatchObject({ kind: 'question', native: { id: 'question-1', method: 'item/tool/requestUserInput',
      sessionRef: 'synthetic-reference-thread', turnId: 'synthetic-turn', itemId: 'synthetic-item' } });
    expect(r.questions).toEqual([expect.objectContaining({ id: 'color', multiple: false, allowText: false }),
      expect.objectContaining({ id: 'note', allowText: true })]);
    expect(responses(await f.frames())).toEqual([]);
    expect(f.session.interactions?.pending()).toHaveLength(1);
    f.send(f.answer(r)); expect(await f.settled).toBe('completed');
    const frames = await f.frames();
    expect(responses(frames)).toEqual([NATIVE_ANSWER]);
    expect(frames.find(frame => frame.method === 'thread/start')?.params.approvalPolicy).toBe('never');
    expect(f.rendered()).not.toContain('LOCAL_ANSWER_NOT_FOR_LOGS');
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(frames.some(frame => frame.method === 'turn/steer')).toBe(false);
    expect(f.lines('receipt')).toEqual([expect.objectContaining({ requestId: r.requestId,
      status: 'responded', duplicate: false, meaning: 'local-transport-write-only' })]);
  });

  it('never relays a native approval request: the SDK refuses it before the Host and no approval UI exists', async () => {
    const f = await open('approval'); expect(await f.settled).toBe('completed');
    expect(f.lines('request')).toEqual([]); expect(f.lines('answer-template')).toEqual([]);
    expect(f.lines('receipt')).toEqual([]); expect(f.lines('error')).toEqual([]);
    const frames = await f.frames();
    expect(frames.find(frame => frame.method === 'thread/start')?.params.approvalPolicy).toBe('never');
    expect(responses(frames)).toEqual([{ id: 7, error: { code: -32601, message: 'unsupported native interaction' } }]);
  });

  it('answers each displayed question explicitly and preserves numeric/string IDs', async () => {
    const f = await open('two-questions'); await f.request(2); const [first, second] = f.lines('request');
    expect(first!.native.id).toBe(7); expect(second!.native.id).toBe('7');
    const pick = (label: string) => ({ kind: 'question', answers: [{ questionId: 'choice', selectedOptionIds: [label] }] });
    f.send(f.answer(first!, pick('Yes')));
    await vi.waitFor(async () => expect(responses(await f.frames())).toHaveLength(1));
    expect(f.session.interactions?.pending().map(p => p.requestId)).toEqual([second!.requestId]);
    f.send(f.answer(second!, pick('No'))); await f.settled;
    expect(responses(await f.frames())).toEqual([
      { id: 7, result: { answers: { choice: { answers: ['Yes'] } } } },
      { id: '7', result: { answers: { choice: { answers: ['No'] } } } },
    ]);
  });

  it('cancels a question with an RPC error instead of manufacturing answer text', async () => {
    const f = await open(); const r = await f.request(); f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
    expect(responses(await f.frames())).toEqual([{ id: 'question-1',
      error: { code: -32000, message: 'native user input cancelled' } }]);
    expect(f.lines('receipt')[0]?.status).toBe('cancelled');
  });

  it('returns repeated-answer receipts and rejects conflicts without a second native write', async () => {
    const f = await open(); const r = await f.request(); const response = f.answer(r);
    f.send(response); f.send(response);
    f.send(f.answer(r, { kind: 'question', answers: [{ questionId: 'color', selectedOptionIds: ['Red'] },
      { questionId: 'note', selectedOptionIds: [], text: 'other' }] }));
    await f.settled;
    expect(responses(await f.frames())).toEqual([NATIVE_ANSWER]);
    expect(f.lines('receipt').map(r => r.duplicate)).toEqual([false, true]);
    expect(f.lines('error')).toContainEqual({ code: 'response_conflict' });
  });

  it('refuses wrong Host/task/generation, unknown request, malformed/extra fields, approval envelopes and empty input', async () => {
    const f = await open(); const r = await f.request(); const response = f.answer(r);
    f.input.write('\nnot-json\n');
    for (const mutation of [{ hostSessionId: 'other' }, { taskId: 'other' }, { generation: 'old' },
      { requestId: 'other' }, { extra: true }, { kind: 'approval', decision: 'allow-once' }]) f.send({ ...response, ...mutation });
    await vi.waitFor(() => expect(f.lines('error')).toHaveLength(7));
    expect(responses(await f.frames())).toEqual([]);
    f.send(response); await f.settled;
    expect(responses(await f.frames())).toHaveLength(1);
  });

  it('keeps an invalid structured answer pending for an explicit valid correction', async () => {
    const f = await open(); const r = await f.request();
    f.send(f.answer(r, { kind: 'question', answers: [{ questionId: 'color', selectedOptionIds: ['MISSING'] }] }));
    await vi.waitFor(() => expect(f.lines('error')).toContainEqual({ code: 'invalid_response' }));
    expect(responses(await f.frames())).toEqual([]);
    f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
    expect(responses(await f.frames())).toHaveLength(1);
  });

  it('an invalid-answer race cannot reset a valid in-flight answer or its repeat receipt', async () => {
    const f = await open(); const r = await f.request();
    f.send(f.answer(r, { kind: 'question', answers: [{ questionId: 'color', selectedOptionIds: ['MISSING'] }] }));
    f.send(f.answer(r)); f.send(f.answer(r));
    await f.settled;
    expect(f.lines('error')).toEqual([{ code: 'invalid_response' }]);
    expect(f.lines('receipt').map(receipt => receipt.duplicate)).toEqual([false, true]);
    expect(responses(await f.frames())).toEqual([NATIVE_ANSWER]);
  });

  it('times out to native cancel and refuses a late answer', async () => {
    const f = await open('question', 150); const r = await f.request(); await f.settled;
    expect(f.lines('receipt')[0]).toMatchObject({ status: 'timed-out', reason: 'deadline' });
    await f.host.answer(JSON.stringify(f.answer(r)));
    expect(f.lines('error')).toContainEqual({ code: 'host-closed' });
    expect(responses(await f.frames())).toEqual([{ id: 'question-1',
      error: { code: -32000, message: 'native user input cancelled' } }]);
  });

  it.each(['withdrawn', 'exit'] as const)('invalidates unanswered requests on %s without a native answer', async scenario => {
    const f = await open(scenario); const r = await f.request(); await f.settled;
    expect(f.session.interactions?.pending()).toEqual([]);
    expect(f.lines('receipt')[0]?.status).toBe('cancelled');
    await f.host.answer(JSON.stringify(f.answer(r)));
    expect(responses(await f.frames())).toEqual([]);
    expect(f.lines('error')).toContainEqual({ code: 'host-closed' });
  });

  it('a new Host with reused native IDs cannot revive the old request or generation', async () => {
    const old = await open(); const oldR = await old.request(); await old.close(); await old.settled;
    const fresh = await open(); const r = await fresh.request();
    expect(r.native).toEqual(oldR.native); expect(r.generation).not.toBe(oldR.generation);
    fresh.send(old.answer(oldR));
    fresh.send({ ...fresh.answer(r), generation: oldR.generation });
    fresh.send({ ...fresh.answer(r), requestId: oldR.requestId });
    await vi.waitFor(() => expect(fresh.lines('error')).toHaveLength(3));
    expect(responses(await fresh.frames())).toEqual([]);
    fresh.send(fresh.answer(r, { kind: 'cancel' })); await fresh.settled;
  });

  it('EOF drops partial input and disposes the exact session without answering or retrying', async () => {
    const f = await open(); const r = await f.request();
    f.input.end(JSON.stringify(f.answer(r))); await f.settled;
    expect(f.session.interactions?.pending()).toEqual([]);
    expect(responses(await f.frames())).toEqual([]);
    expect((await f.frames()).filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('a synchronous initial output failure retains disposal and cleans the owned cwd', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-output-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const receipt = path.join(dir, 'frames.jsonl'); const input = new PassThrough();
    const output = new Writable({ write() { throw new Error('synthetic output failure'); } });
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    await expect(startFixtureHost({ scenario: 'question', input, output, fixtureReceiptPath: receipt }))
      .rejects.toThrow('Host output is unavailable');
    const frames: Frame[] = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const cwd = threadCwd(frames);
    expect(typeof cwd).toBe('string'); await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(responses(frames).some(frame => frame.result)).toBe(false);
  });

  it.each(['error', 'finish'] as const)('output %s closes the owned process and cleans its cwd without answering', async reason => {
    const f = await open(); await f.request();
    if (reason === 'error') f.output.destroy(new Error('synthetic broken pipe'));
    else f.output.end();
    await f.settled;
    expect(f.session.interactions?.pending()).toEqual([]);
    const frames = await f.frames();
    await expect(access(threadCwd(frames))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(responses(frames)).toEqual([]);
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('an abort during startup output retains disposal and cannot answer the pending request', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-abort-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const controller = new AbortController(); const input = new PassThrough();
    const receipt = path.join(dir, 'frames.jsonl');
    const output = new Writable({ write(_chunk, _encoding, next) { controller.abort(); next(); } });
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    const run = await startFixtureHost({ scenario: 'question', input, output, signal: controller.signal, fixtureReceiptPath: receipt });
    await run.done;
    expect(input.listenerCount('data')).toBe(0);
    const frames: Frame[] = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    await expect(access(threadCwd(frames))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(responses(frames).some(frame => frame.result)).toBe(false);
  });

  it('an already-aborted startup never starts the synthetic protocol process', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-pre-abort-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const controller = new AbortController(); controller.abort();
    const input = new PassThrough(); const output = new PassThrough(); const receipt = path.join(dir, 'frames.jsonl');
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    await expect(startFixtureHost({ scenario: 'question', input, output, signal: controller.signal, fixtureReceiptPath: receipt }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(access(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a runtime synchronous output failure cannot reject the input handler or skip disposal', async () => {
    const f = await open(); await f.request();
    // Only the local sink fails. Adapter, native transport and process ownership remain real.
    const failedWrite = vi.spyOn(f.output, 'write').mockImplementationOnce(() => { throw new Error('synthetic sync sink failure'); });
    f.input.write('not-json\n'); await f.settled; failedWrite.mockRestore();
    expect(f.session.interactions?.pending()).toEqual([]);
    expect(f.input.listenerCount('data')).toBe(0);
    const frames = await f.frames();
    await expect(access(threadCwd(frames))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(responses(frames)).toEqual([]);
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('refused setup removes borrowed output listeners before any process can start', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    const listeners = ['error', 'close', 'finish'].map(event => output.listenerCount(event));
    await expect(startFixtureHost({ scenario: 'question', input, output, timeoutMs: 0 })).rejects.toThrow('invalid interaction timeout');
    expect(['error', 'close', 'finish'].map(event => output.listenerCount(event))).toEqual(listeners);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('cancels secret prompts without rendering them or accepting secret input', async () => {
    const f = await open('secret'); await f.settled;
    expect(f.lines('request')).toEqual([]);
    expect(f.rendered()).not.toContain('SECRET_PROMPT_DO_NOT_RENDER');
    expect(f.lines('unavailable')).toEqual([expect.objectContaining({ reason: 'secret-input-unsupported' })]);
    expect((await f.frames()).find(frame => frame.id === 'question-1')?.error.code).toBe(-32000);
  });

  it('renders provider terminal controls as inert JSON and never treats them as answers', async () => {
    const f = await open('control-text'); const r = await f.request();
    expect(f.rendered()).not.toContain('\u001b'); expect(f.rendered()).not.toContain('‮');
    expect(f.rendered()).toContain('\\u001b'); expect(f.rendered()).toContain('\\u202e');
    expect(f.lines('receipt')).toEqual([]); expect(responses(await f.frames())).toEqual([]);
    f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
  });

  it('bounds oversized input and can accept a new explicit line afterward', async () => {
    const f = await open(); const r = await f.request(); f.input.write(`${'x'.repeat(65_537)}\n`);
    await vi.waitFor(() => expect(f.lines('error')).toContainEqual({ code: 'input-too-large' }));
    expect(responses(await f.frames())).toEqual([]);
    f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
  });
});
