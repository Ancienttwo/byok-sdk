import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFixtureHost, type FixtureScenario } from '../index';

type Frame = Record<string, any>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function open(scenario: FixtureScenario = 'approval', timeoutMs = 10_000) {
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
  const answer = (r: Frame, data: Frame = { kind: 'approval', decision: 'allow-once' }) => ({
    hostSessionId: r.hostSessionId, taskId: r.taskId, generation: r.generation, requestId: r.requestId, ...data,
  });
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  return { ...run, input, output, settled, lines, frames, request, answer, send, rendered: () => rendered };
}

describe('local terminal -> public CodexAdapter -> synthetic app-server', () => {
  it.each([['allow-once', 'accept'], ['allow-session', 'acceptForSession'], ['deny', 'decline'], ['cancel', 'cancel']] as const)
  ('renders the exact native request and maps explicit %s to %s once', async (decision, native) => {
    const f = await open(); const r = await f.request();
    expect(r).toMatchObject({ kind: 'approval', native: { id: 7, method: 'item/commandExecution/requestApproval',
      sessionRef: 'synthetic-reference-thread', turnId: 'synthetic-turn', itemId: 'synthetic-item' },
      details: { command: 'echo synthetic-only' }, decisions: ['allow-once', 'allow-session', 'deny', 'cancel'] });
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    expect(f.session.interactions?.pending()).toHaveLength(1);
    f.send(f.answer(r, { kind: 'approval', decision }));
    expect(await f.settled).toBe('completed');
    const frames = await f.frames();
    expect(frames.filter(frame => !frame.method)).toEqual([{ id: 7, result: { decision: native } }]);
    expect(frames.find(frame => frame.method === 'thread/start')?.params.approvalPolicy).toBe('on-request');
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(frames.some(frame => frame.method === 'turn/steer')).toBe(false);
    expect(f.lines('receipt')).toEqual([expect.objectContaining({ requestId: r.requestId,
      status: 'responded', duplicate: false, meaning: 'local-transport-write-only' })]);
  });

  it('does not silently apply a session choice to a second displayed request and preserves numeric/string IDs', async () => {
    const f = await open('two-approvals'); await f.request(2); const [first, second] = f.lines('request');
    expect(first!.native.id).toBe(7); expect(second!.native.id).toBe('7');
    f.send(f.answer(first!, { kind: 'approval', decision: 'allow-session' }));
    await vi.waitFor(async () => expect((await f.frames()).filter(frame => !frame.method)).toHaveLength(1));
    expect(f.session.interactions?.pending().map(p => p.requestId)).toEqual([second!.requestId]);
    f.send(f.answer(second!, { kind: 'approval', decision: 'deny' })); await f.settled;
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([
      { id: 7, result: { decision: 'acceptForSession' } }, { id: '7', result: { decision: 'decline' } },
    ]);
  });

  it('delivers structured answers without ordinary prompt/steer or answer logging', async () => {
    const f = await open('question'); const r = await f.request();
    expect(r.questions).toEqual([expect.objectContaining({ id: 'color', multiple: false, allowText: false }),
      expect.objectContaining({ id: 'note', allowText: true })]);
    f.send(f.answer(r, { kind: 'question', answers: [
      { questionId: 'color', selectedOptionIds: ['Blue'] },
      { questionId: 'note', selectedOptionIds: [], text: 'LOCAL_ANSWER_NOT_FOR_LOGS' },
    ] })); await f.settled;
    const frames = await f.frames();
    expect(frames.find(frame => frame.id === 'question-1')).toEqual({ id: 'question-1', result: { answers: {
      color: { answers: ['Blue'] }, note: { answers: ['LOCAL_ANSWER_NOT_FOR_LOGS'] },
    } } });
    expect(f.rendered()).not.toContain('LOCAL_ANSWER_NOT_FOR_LOGS');
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(frames.some(frame => frame.method === 'turn/steer')).toBe(false);
  });

  it('cancels a question with an RPC error instead of manufacturing answer text', async () => {
    const f = await open('question'); const r = await f.request(); f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
    expect((await f.frames()).find(frame => frame.id === 'question-1')).toEqual({ id: 'question-1',
      error: { code: -32000, message: 'native user input cancelled' } });
    expect(f.lines('receipt')[0]?.status).toBe('cancelled');
  });

  it('returns repeated-answer receipts and rejects conflicts without a second native write', async () => {
    const f = await open(); const r = await f.request(); const response = f.answer(r);
    f.send(response); f.send(response); f.send(f.answer(r, { kind: 'approval', decision: 'allow-session' }));
    await f.settled;
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([{ id: 7, result: { decision: 'accept' } }]);
    expect(f.lines('receipt').map(r => r.duplicate)).toEqual([false, true]);
    expect(f.lines('error')).toContainEqual({ code: 'response_conflict' });
  });

  it('refuses wrong Host/task/generation, unknown request, malformed/extra fields and empty input', async () => {
    const f = await open(); const r = await f.request(); const response = f.answer(r);
    f.input.write('\nnot-json\n');
    for (const mutation of [{ hostSessionId: 'other' }, { taskId: 'other' }, { generation: 'old' },
      { requestId: 'other' }, { extra: true }, { decision: 'always-allow' }]) f.send({ ...response, ...mutation });
    await vi.waitFor(() => expect(f.lines('error')).toHaveLength(7));
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    f.send(response); await f.settled;
    expect((await f.frames()).filter(frame => !frame.method)).toHaveLength(1);
  });

  it('keeps an invalid structured answer pending for an explicit valid correction', async () => {
    const f = await open('question'); const r = await f.request();
    f.send(f.answer(r, { kind: 'question', answers: [{ questionId: 'color', selectedOptionIds: ['MISSING'] }] }));
    await vi.waitFor(() => expect(f.lines('error')).toContainEqual({ code: 'invalid_response' }));
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
    expect((await f.frames()).filter(frame => !frame.method)).toHaveLength(1);
  });

  it('an invalid-answer race cannot reset a valid in-flight answer or its repeat receipt', async () => {
    const f = await open(); const r = await f.request();
    f.send(f.answer(r, { kind: 'approval', decision: 'invalid' }));
    f.send(f.answer(r)); f.send(f.answer(r));
    await f.settled;
    expect(f.lines('error')).toEqual([{ code: 'invalid_response' }]);
    expect(f.lines('receipt').map(receipt => receipt.duplicate)).toEqual([false, true]);
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([{ id: 7, result: { decision: 'accept' } }]);
  });

  it('times out to native cancel and refuses a late answer', async () => {
    const f = await open('approval', 150); const r = await f.request(); await f.settled;
    expect(f.lines('receipt')[0]).toMatchObject({ status: 'timed-out', reason: 'deadline' });
    await f.host.answer(JSON.stringify(f.answer(r)));
    expect(f.lines('error')).toContainEqual({ code: 'host-closed' });
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([{ id: 7, result: { decision: 'cancel' } }]);
  });

  it.each(['withdrawn', 'exit'] as const)('invalidates unanswered requests on %s without a native allow', async scenario => {
    const f = await open(scenario); const r = await f.request(); await f.settled;
    expect(f.session.interactions?.pending()).toEqual([]);
    expect(f.lines('receipt')[0]?.status).toBe('cancelled');
    await f.host.answer(JSON.stringify(f.answer(r)));
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
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
    expect((await fresh.frames()).filter(frame => !frame.method)).toEqual([]);
    fresh.send(fresh.answer(r, { kind: 'approval', decision: 'deny' })); await fresh.settled;
  });

  it('EOF drops partial input and disposes the exact session without answering or retrying', async () => {
    const f = await open(); const r = await f.request();
    f.input.end(JSON.stringify(f.answer(r))); await f.settled;
    expect(f.session.interactions?.pending()).toEqual([]);
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    expect((await f.frames()).filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('a synchronous initial output failure retains disposal and cleans the owned cwd', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-output-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const receipt = path.join(dir, 'frames.jsonl'); const input = new PassThrough();
    const output = new Writable({ write() { throw new Error('synthetic output failure'); } });
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    await expect(startFixtureHost({ scenario: 'approval', input, output, fixtureReceiptPath: receipt }))
      .rejects.toThrow('Host output is unavailable');
    const frames: Frame[] = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const cwd = frames.find(frame => frame.method === 'thread/start')?.params.cwd;
    expect(typeof cwd).toBe('string'); await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(frames.filter(frame => !frame.method).some(frame => ['accept', 'acceptForSession'].includes(frame.result?.decision))).toBe(false);
  });

  it.each(['error', 'finish'] as const)('output %s closes the owned process and cleans its cwd without approval', async reason => {
    const f = await open(); const r = await f.request();
    if (reason === 'error') f.output.destroy(new Error('synthetic broken pipe'));
    else f.output.end();
    await f.settled;
    expect(f.session.interactions?.pending()).toEqual([]);
    await expect(access(r.details.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    expect((await f.frames()).filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('an abort during startup output retains disposal and cannot approve the pending request', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-abort-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const controller = new AbortController(); const input = new PassThrough();
    const receipt = path.join(dir, 'frames.jsonl');
    const output = new Writable({ write(_chunk, _encoding, next) { controller.abort(); next(); } });
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    const run = await startFixtureHost({ scenario: 'approval', input, output, signal: controller.signal, fixtureReceiptPath: receipt });
    await run.done;
    expect(input.listenerCount('data')).toBe(0);
    const frames: Frame[] = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const cwd = frames.find(frame => frame.method === 'thread/start')?.params.cwd;
    await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(frames.filter(frame => !frame.method).some(frame => ['accept', 'acceptForSession'].includes(frame.result?.decision))).toBe(false);
  });

  it('an already-aborted startup never starts the synthetic protocol process', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-host-pre-abort-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const controller = new AbortController(); controller.abort();
    const input = new PassThrough(); const output = new PassThrough(); const receipt = path.join(dir, 'frames.jsonl');
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    await expect(startFixtureHost({ scenario: 'approval', input, output, signal: controller.signal, fixtureReceiptPath: receipt }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(access(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a runtime synchronous output failure cannot reject the input handler or skip disposal', async () => {
    const f = await open(); const r = await f.request();
    // Only the local sink fails. Adapter, native transport and process ownership remain real.
    const failedWrite = vi.spyOn(f.output, 'write').mockImplementationOnce(() => { throw new Error('synthetic sync sink failure'); });
    f.input.write('not-json\n'); await f.settled; failedWrite.mockRestore();
    expect(f.session.interactions?.pending()).toEqual([]);
    expect(f.input.listenerCount('data')).toBe(0);
    await expect(access(r.details.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    expect((await f.frames()).filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('refused setup removes borrowed output listeners before any process can start', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    cleanup.push(async () => { input.destroy(); output.destroy(); });
    const listeners = ['error', 'close', 'finish'].map(event => output.listenerCount(event));
    await expect(startFixtureHost({ scenario: 'approval', input, output, timeoutMs: 0 })).rejects.toThrow('invalid interaction timeout');
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
    expect(f.rendered()).not.toContain('\u001b'); expect(f.rendered()).not.toContain('\u202e');
    expect(f.rendered()).toContain('\\u001b'); expect(f.rendered()).toContain('\\u202e');
    expect(f.lines('receipt')).toEqual([]); expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
  });

  it('bounds oversized input and can accept a new explicit line afterward', async () => {
    const f = await open(); const r = await f.request(); f.input.write(`${'x'.repeat(65_537)}\n`);
    await vi.waitFor(() => expect(f.lines('error')).toContainEqual({ code: 'input-too-large' }));
    expect((await f.frames()).filter(frame => !frame.method)).toEqual([]);
    f.send(f.answer(r, { kind: 'cancel' })); await f.settled;
  });
});
