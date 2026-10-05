import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { argsDigest, canonicalArgs, CLOUD_LIVE_IPO_TOOLS, CLOUD_SAFE_REPLAY_TOOLS, invocationId, replayForTool } from '../src/tools';
import type { InvocationInput, InvocationRow, ExecutionRow } from '../src/invocation-ledger';

let mf: Miniflare;
let script: string;
let persist: string;
function runtime() {
  return new Miniflare({ resourcePersistencePath: persist, workers: [{ config: {
    name: 'cloud-ledger-test', type: 'worker', compatibilityDate: '2026-08-18',
    compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
    exports: { LedgerDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { LEDGERS: { type: 'durable-object', workerName: 'cloud-ledger-test', exportName: 'LedgerDO' } },
  } }] });
}
beforeAll(async () => {
  const result = await build({ entryPoints: [path.resolve(import.meta.dirname, 'invocation-ledger-worker.ts')],
    bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  script = result.outputFiles![0]!.text;
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-ledger-'));
  mf = runtime(); await mf.ready;
});
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });
async function rpc<T>(name: string, operation: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, now: 100, ...args }) });
  const body = await response.json() as T;
  if (!response.ok) throw new Error((body as { error: { code: string } }).error.code);
  return body;
}
async function input(assistantEntryId = 1, toolName = 'resolve_security', args: Record<string, unknown> = {}): Promise<InvocationInput> {
  return { invocationId: await invocationId(1, assistantEntryId, 'call_0'), sessionId: 'session', conversationId: 1,
    assistantEntryId, toolCallId: 'call_0', toolName, argsDigest: await argsDigest(toolName, args),
    argsJson: canonicalArgs(args), replay: replayForTool(toolName), deadlineAt: 500 };
}
const start = (name: string, deadlineAt = 1000) => rpc<ExecutionRow>(name, 'start-execution', { conversationId: 1, deadlineAt });
const begin = (name: string, invocation: InvocationInput) => rpc<{ kind: string; row: InvocationRow }>(name, 'begin', { input: invocation });
const finish = (name: string, id: string, args: Record<string, unknown> = {}) => rpc<InvocationRow>(name, 'finish', {
  id, state: 'succeeded', now: 100, result: { ok: true, usage: { credits: 1 } }, ...args,
});
const execution = (name: string) => rpc<ExecutionRow>(name, 'execution', { conversationId: 1 });

describe('invocation ledger in real workerd SQLite', () => {
  it('cohabits with native pi tables and reserves nullable job fields without alarms', async () => {
    const schema = await rpc<{ tables: string[]; columns: string[]; alarm: number | null }>('schema', 'schema');
    expect(schema.tables).toContain('pi_conversations');
    expect(schema.tables).toContain('cloud_invocations');
    expect(schema.tables).toContain('cloud_executions');
    expect(schema.columns).toEqual(expect.arrayContaining(['sessionId', 'seq', 'mode', 'segmentStartedAt', 'nextSegmentAt', 'jobStateJson', 'progressJson']));
    expect(schema.alarm).toBeNull();
  });
  it('gives only one of 20 concurrent duplicate calls dispatch ownership', async () => {
    const invocation = await input();
    const outcomes = await rpc<{ kind: string; row: InvocationRow }[]>('concurrent', 'parallel-begin', { input: invocation });
    expect(outcomes.filter(row => row.kind === 'started')).toHaveLength(1);
    expect(outcomes.filter(row => row.kind === 'pending')).toHaveLength(19);
    expect(new Set(outcomes.map(row => row.row.seq)).size).toBe(1);
    expect(outcomes.every(row => row.row.attempt === 1)).toBe(true);
  });
  it('stores all 15 frozen tools as safe and all 7 live IPO tools as unsafe', async () => {
    let entry = 0;
    for (const tool of [...CLOUD_SAFE_REPLAY_TOOLS, ...CLOUD_LIVE_IPO_TOOLS]) {
      const { row } = await begin('replay-policy', await input(++entry, tool));
      expect(row.replay).toBe(CLOUD_SAFE_REPLAY_TOOLS.includes(tool as typeof CLOUD_SAFE_REPLAY_TOOLS[number]) ? 'safe' : 'unsafe');
      expect(row).toMatchObject({ mode: 'inline', segmentStartedAt: null, nextSegmentAt: null, jobStateJson: null, progressJson: null });
    }
  });
  it('dispatches a repeated call id in another assistant entry and preserves monotonic session sequence', async () => {
    const a = await begin('entries', await input(1));
    const b = await begin('entries', await input(2));
    expect(a.kind).toBe('started'); expect(b.kind).toBe('started');
    expect(b.row.seq).toBeGreaterThan(a.row.seq);
    expect(b.row.invocationId).not.toBe(a.row.invocationId);
  });
  it('rejects changed arguments or tool identity under the same invocation id', async () => {
    const first = await input(); await begin('conflict', first);
    const changed = await input(1, 'resolve_security', { query: 'changed' });
    await expect(begin('conflict', changed)).rejects.toThrow('CLOUD_TOOL_INVOCATION_CONFLICT');
    const renamed = await input(1, 'get_quote_snapshot');
    await expect(begin('conflict', renamed)).rejects.toThrow('CLOUD_TOOL_INVOCATION_CONFLICT');
    expect((await rpc<InvocationRow>('conflict', 'read', { id: first.invocationId })).toolName).toBe('resolve_security');
  });
  it('returns a terminal duplicate and never overwrites any terminal state', async () => {
    const states = ['succeeded', 'failed', 'aborted', 'interrupted', 'timed_out'] as const;
    for (const state of states) {
      const name = `terminal-${state}`; const invocation = await input(); await begin(name, invocation);
      const original = await finish(name, invocation.invocationId, { state, code: state === 'succeeded' ? undefined : 'CLOUD_TOOL_FAILED' });
      expect((await begin(name, invocation)).kind).toBe('settled');
      expect(await finish(name, invocation.invocationId, { result: { changed: true } })).toEqual(original);
      expect(await rpc(name, 'recover')).toEqual([]);
    }
  });
  it('rejects late success at the exact call deadline and records fatal timeout atomically', async () => {
    await start('call-timeout'); const invocation = await input(); await begin('call-timeout', invocation);
    const result = await finish('call-timeout', invocation.invocationId, { now: 500 });
    expect(result).toMatchObject({ state: 'timed_out', resultJson: null, errorCode: 'CLOUD_TOOL_TIMEOUT' });
    expect((await execution('call-timeout')).fatalCode).toBe('CLOUD_TOOL_TIMEOUT');
  });
  it('rejects late success at the exact execution deadline', async () => {
    await start('turn-timeout', 200); const invocation = await input(); await begin('turn-timeout', invocation);
    expect(await finish('turn-timeout', invocation.invocationId, { now: 200 })).toMatchObject({ state: 'timed_out', resultJson: null, errorCode: 'CLOUD_EXECUTION_TIMEOUT' });
    expect((await execution('turn-timeout')).fatalCode).toBe('CLOUD_EXECUTION_TIMEOUT');
  });
  it('discards success after disconnect or abort', async () => {
    for (const kind of ['disconnect', 'abort']) {
      const name = `cancel-${kind}`; await start(name); const invocation = await input(); await begin(name, invocation);
      if (kind === 'abort') await rpc(name, 'abort', { conversationId: 1, code: 'CLOUD_EXECUTION_ABORTED' });
      expect(await finish(name, invocation.invocationId, { options: { clientConnected: kind !== 'disconnect' } }))
        .toMatchObject({ state: 'aborted', resultJson: null, errorCode: 'CLOUD_EXECUTION_ABORTED' });
    }
  });
  it('keeps the first fatal error and discards a peer success after a result limit', async () => {
    const name = 'fatal'; await start(name); const a = await input(1); const b = await input(2);
    await begin(name, a); await begin(name, b);
    await finish(name, a.invocationId, { state: 'failed', code: 'CLOUD_TOOL_RESULT_LIMIT' });
    expect((await execution(name)).fatalCode).toBe('CLOUD_TOOL_RESULT_LIMIT');
    await rpc(name, 'fail', { conversationId: 1, code: 'CLOUD_TOOL_TIMEOUT' });
    expect((await execution(name)).fatalCode).toBe('CLOUD_TOOL_RESULT_LIMIT');
    expect(await finish(name, b.invocationId)).toMatchObject({ state: 'failed', errorCode: 'CLOUD_TOOL_RESULT_LIMIT', resultJson: null });
  });
  it('claims safe rows once, interrupts unsafe IPO rows, and rejects an old attempt result', async () => {
    const name = 'claim'; const safe = await input(); const unsafe = await input(2, 'get_ipo_profile');
    await begin(name, safe); await begin(name, unsafe);
    const claimed = await rpc<InvocationRow[]>(name, 'recover');
    expect(claimed).toHaveLength(1); expect(claimed[0]).toMatchObject({ replayCount: 1, attempt: 2, invocationId: safe.invocationId });
    expect(await rpc(name, 'read', { id: unsafe.invocationId })).toMatchObject({ state: 'interrupted', errorCode: 'CLOUD_EXECUTION_INTERRUPTED', replayCount: 0 });
    expect(await finish(name, safe.invocationId, { options: { attempt: 1 } })).toMatchObject({ state: 'running', resultJson: null });
    expect(await finish(name, safe.invocationId, { options: { attempt: 2, recovery: true } })).toMatchObject({ state: 'succeeded' });
    expect(await rpc(name, 'recover')).toEqual([]);
  });
  it('allows explicit ledger recovery after the old execution was failed, while ordinary success is discarded', async () => {
    const name = 'recovery-finish'; await start(name); const invocation = await input(); await begin(name, invocation);
    const claimed = await rpc<InvocationRow[]>(name, 'recover');
    await rpc(name, 'fail', { conversationId: 1, code: 'CLOUD_EXECUTION_INTERRUPTED' });
    expect(await finish(name, invocation.invocationId, { options: { attempt: claimed[0]!.attempt, recovery: true } })).toMatchObject({ state: 'succeeded' });
  });
  it('does not replay an invocation with an abort request', async () => {
    const name = 'aborted-recovery'; await start(name); const invocation = await input(); await begin(name, invocation);
    await rpc(name, 'abort', { conversationId: 1, code: 'CLOUD_EXECUTION_ABORTED' });
    expect(await rpc(name, 'recover')).toEqual([]);
    expect(await rpc(name, 'read', { id: invocation.invocationId })).toMatchObject({ state: 'aborted', resultJson: null });
  });
  it('does not claim an expired call or execution for network replay', async () => {
    for (const kind of ['call', 'execution']) {
      const name = `expired-recovery-${kind}`;
      await start(name, kind === 'execution' ? 200 : 1000);
      const invocation = await input(); await begin(name, invocation);
      expect(await rpc(name, 'recover', { now: kind === 'call' ? 500 : 200 })).toEqual([]);
      expect(await rpc(name, 'read', { id: invocation.invocationId })).toMatchObject({ state: 'timed_out', replayCount: 0,
        errorCode: kind === 'call' ? 'CLOUD_TOOL_TIMEOUT' : 'CLOUD_EXECUTION_TIMEOUT' });
    }
  });
  it('persists a claim over two complete workerd restarts and never claims it twice', async () => {
    const name = 'restart'; const invocation = await input(); await begin(name, invocation);
    await mf.dispose(); mf = runtime(); await mf.ready;
    expect(await rpc<InvocationRow[]>(name, 'recover')).toHaveLength(1);
    await mf.dispose(); mf = runtime(); await mf.ready;
    expect(await rpc(name, 'recover')).toEqual([]);
    expect(await rpc(name, 'read', { id: invocation.invocationId })).toMatchObject({ state: 'failed', errorCode: 'CLOUD_EXECUTION_INTERRUPTED', replayCount: 1, attempt: 2 });
  });
});

describe('durable execution budgets in workerd', () => {
  it('allows 8 model steps and persists the 9th-step rejection without rollback', async () => {
    const name = 'models'; await start(name);
    for (let i = 1; i <= 8; i++) expect(await rpc(name, 'model', { conversationId: 1, now: 100 })).toMatchObject({ steps: i, fatalCode: null });
    await expect(rpc(name, 'model', { conversationId: 1, now: 100 })).rejects.toThrow('CLOUD_STEP_LIMIT');
    expect(await execution(name)).toMatchObject({ steps: 8, fatalCode: 'CLOUD_STEP_LIMIT' });
    await expect(rpc(name, 'model', { conversationId: 1, now: 100 })).rejects.toThrow('CLOUD_STEP_LIMIT');
  });
  it('counts each native tool task once, allows 12, and persists the 13th rejection', async () => {
    const name = 'tools'; await start(name);
    for (let i = 1; i <= 12; i++) {
      const args = { conversationId: 1, taskId: `task-${i}`, now: 100 };
      expect(await rpc(name, 'tool', args)).toMatchObject({ tools: i, fatalCode: null });
      expect(await rpc(name, 'tool', args)).toMatchObject({ tools: i, fatalCode: null });
    }
    await expect(rpc(name, 'tool', { conversationId: 1, taskId: 'task-13', now: 100 })).rejects.toThrow('CLOUD_TOOL_LIMIT');
    expect(await execution(name)).toMatchObject({ tools: 12, fatalCode: 'CLOUD_TOOL_LIMIT' });
  });
  it('supports configured model and tool budgets', async () => {
    await start('configured-model'); await rpc('configured-model', 'model', { conversationId: 1, now: 100, max: 1 });
    await expect(rpc('configured-model', 'model', { conversationId: 1, now: 100, max: 1 })).rejects.toThrow('CLOUD_STEP_LIMIT');
    await start('configured-tool'); await rpc('configured-tool', 'tool', { conversationId: 1, taskId: '1', now: 100, max: 1 });
    await expect(rpc('configured-tool', 'tool', { conversationId: 1, taskId: '2', now: 100, max: 1 })).rejects.toThrow('CLOUD_TOOL_LIMIT');
  });
  it('rejects an expired, aborted, or missing execution before counting work', async () => {
    await start('expired', 100);
    await expect(rpc('expired', 'model', { conversationId: 1, now: 100 })).rejects.toThrow('CLOUD_EXECUTION_TIMEOUT');
    expect(await execution('expired')).toMatchObject({ steps: 0, fatalCode: 'CLOUD_EXECUTION_TIMEOUT' });
    await start('aborted'); await rpc('aborted', 'abort', { conversationId: 1, code: 'CLOUD_EXECUTION_ABORTED' });
    await expect(rpc('aborted', 'tool', { conversationId: 1, taskId: '1', now: 100 })).rejects.toThrow('CLOUD_EXECUTION_ABORTED');
    expect(await execution('aborted')).toMatchObject({ tools: 0 });
    await expect(rpc('missing', 'model', { conversationId: 1, now: 100 })).rejects.toThrow('CLOUD_EXECUTION_INTERRUPTED');
  });
  it('does not reset an existing execution deadline or budgets', async () => {
    const name = 'start-once'; await start(name, 500);
    await rpc(name, 'model', { conversationId: 1, now: 100 });
    expect(await start(name, 1000)).toMatchObject({ deadlineAt: 500, steps: 1 });
  });
});

describe('model usage and dispatch accounting in real workerd', () => {
  const usage = (name: string, inputDelta: number, outputDelta: number) => rpc<ExecutionRow>(name, 'usage', { conversationId: 1, inputDelta, outputDelta });
  const model = (name: string, budget: { inputBytes: number; inputTokens: number; outputTokens: number }) => rpc<ExecutionRow>(name, 'model', { conversationId: 1, budget });
  it('migrates old executions to zero counters and keeps counters on repeated schema checks', async () => {
    const name = 'usage-migration'; await start(name);
    const columns = await rpc<string[]>(name, 'legacy-schema');
    expect(columns).not.toContain('inputTokens');
    expect(await execution(name)).toMatchObject({ inputTokens: 0, outputTokens: 0, credits: 0, sentRequests: 0 });
    await usage(name, 123, 45); await rpc(name, 'model', { conversationId: 1 });
    await rpc(name, 'sent', { conversationId: 1 });
    expect(await start(name)).toMatchObject({ inputTokens: 123, outputTokens: 45, steps: 1, sentRequests: 1 });
  });
  for (const field of ['input', 'output'] as const) it(`admits the exact ${field} bound and durably rejects one over before counting`, async () => {
    const name = `token-bound-${field}`; await start(name); await usage(name, 100, 20);
    const budget = { inputBytes: 17, inputTokens: 100 + 17 + 4096, outputTokens: 20 + 4096 };
    expect(await model(name, budget)).toMatchObject({ steps: 1, inputTokens: 100, outputTokens: 20, fatalCode: null });
    if (field === 'input') budget.inputBytes++;
    else budget.outputTokens--;
    await expect(model(name, budget)).rejects.toThrow('CLOUD_BUDGET_EXCEEDED');
    expect(await execution(name)).toMatchObject({ steps: 1, inputTokens: 100, outputTokens: 20, fatalCode: 'CLOUD_BUDGET_EXCEEDED' });
    await expect(model(name, { inputBytes: 0, inputTokens: 128000, outputTokens: 32768 })).rejects.toThrow('CLOUD_BUDGET_EXCEEDED');
  });
  it('adds exact per-request deltas and saturates both token counters', async () => {
    const name = 'usage-deltas'; await start(name);
    await usage(name, 100, 10); await usage(name, 0, 3); await usage(name, 20, 0);
    expect(await execution(name)).toMatchObject({ inputTokens: 120, outputTokens: 13 });
    await usage(name, Number.MAX_SAFE_INTEGER - 120, Number.MAX_SAFE_INTEGER - 13);
    expect(await usage(name, 11, 22)).toMatchObject({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER });
  });
  it('marks each counted request once and refuses missing or uncounted dispatches', async () => {
    const name = 'dispatch-intent'; await start(name);
    await expect(rpc(name, 'sent', { conversationId: 1 })).rejects.toThrow('CLOUD_MODEL_REQUEST_FAILED');
    await rpc(name, 'model', { conversationId: 1 });
    expect(await rpc(name, 'sent', { conversationId: 1 })).toMatchObject({ steps: 1, sentRequests: 1 });
    await expect(rpc(name, 'sent', { conversationId: 1 })).rejects.toThrow('CLOUD_MODEL_REQUEST_FAILED');
    await rpc(name, 'model', { conversationId: 1 });
    expect(await rpc(name, 'sent', { conversationId: 1 })).toMatchObject({ steps: 2, sentRequests: 2 });
    await expect(rpc('dispatch-missing', 'sent', { conversationId: 1 })).rejects.toThrow('CLOUD_MODEL_REQUEST_FAILED');
  });
});

describe('tool credits in real workerd', () => {
  it('keeps the crossing result, counts each finish once, and blocks the next paid gate', async () => {
    const name = 'credit-cap'; await start(name);
    const a = await input(1); const b = await input(2); await begin(name, a); await begin(name, b);
    const first = { ok: true, data: 'first', usage: { credits: 100 } };
    expect(await finish(name, a.invocationId, { result: first, options: { creditCap: 100 } })).toMatchObject({ state: 'succeeded', resultJson: JSON.stringify(first) });
    expect(await execution(name)).toMatchObject({ credits: 100, fatalCode: null });
    const crossing = { ok: true, data: 'crossing', usage: { credits: 1 } };
    expect(await finish(name, b.invocationId, { result: crossing, options: { creditCap: 100 } })).toMatchObject({ state: 'succeeded', resultJson: JSON.stringify(crossing) });
    await finish(name, b.invocationId, { result: { usage: { credits: 900 } }, options: { creditCap: 100 } });
    expect(await execution(name)).toMatchObject({ credits: 101, fatalCode: 'CLOUD_BUDGET_EXCEEDED' });
    await expect(rpc(name, 'model', { conversationId: 1 })).rejects.toThrow('CLOUD_BUDGET_EXCEEDED');
  });
  for (const reason of ['disconnect', 'abort', 'call-timeout', 'execution-timeout', 'fatal'] as const) it(`counts supplied paid credits when success flips for ${reason}`, async () => {
    const name = `credit-flipped-${reason}`; await start(name, reason === 'execution-timeout' ? 200 : 1000);
    const invocation = await input(); await begin(name, invocation);
    if (reason === 'abort') await rpc(name, 'abort', { conversationId: 1, code: 'CLOUD_EXECUTION_ABORTED' });
    if (reason === 'fatal') await rpc(name, 'fail', { conversationId: 1, code: 'CLOUD_TOOL_RESULT_LIMIT' });
    const row = await finish(name, invocation.invocationId, { now: reason === 'call-timeout' ? 500 : reason === 'execution-timeout' ? 200 : 100,
      options: { clientConnected: reason !== 'disconnect', creditCap: 100 }, result: { ok: true, usage: { credits: 9 } } });
    expect(row.state).toBe(reason === 'fatal' ? 'failed' : reason.endsWith('timeout') ? 'timed_out' : 'aborted');
    expect(row.resultJson).toBeNull();
    expect(await execution(name)).toMatchObject({ credits: 9 });
  });
  it('counts no stale-attempt or already-terminal result and saturates credits', async () => {
    const name = 'credit-stale'; await start(name); const invocation = await input(); await begin(name, invocation);
    await rpc(name, 'recover');
    await finish(name, invocation.invocationId, { result: { usage: { credits: 50 } }, options: { attempt: 1 } });
    expect(await execution(name)).toMatchObject({ credits: 0 });
    await finish(name, invocation.invocationId, { result: { ok: true, usage: { credits: Number.MAX_SAFE_INTEGER - 2 } }, options: { attempt: 2, recovery: true } });
    const next = await input(2); await begin(name, next);
    await finish(name, next.invocationId, { result: { ok: true, usage: { credits: 10 } } });
    expect(await execution(name)).toMatchObject({ credits: Number.MAX_SAFE_INTEGER });
    await finish(name, next.invocationId, { result: { usage: { credits: 99 } } });
    expect(await execution(name)).toMatchObject({ credits: Number.MAX_SAFE_INTEGER });
  });
  for (const credits of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null]) it(`ignores invalid supplied credits ${String(credits)}`, async () => {
    const name = `credit-invalid-${String(credits)}`; await start(name); const invocation = await input(); await begin(name, invocation);
    await finish(name, invocation.invocationId, { result: { usage: { credits } }, options: { creditCap: 100 } });
    expect(await execution(name)).toMatchObject({ credits: 0, fatalCode: null });
  });
});

describe('terminal accounting cut-off in real workerd', () => {
  it('does not count paid results that arrive after an invocation was cancelled', async () => {
    const name = 'credit-late-after-cancel'; await start(name);
    const invocation = await input(); await begin(name, invocation);
    const cancelled = await finish(name, invocation.invocationId, { state: 'aborted', code: 'CLOUD_EXECUTION_ABORTED', result: undefined });
    expect(cancelled).toMatchObject({ state: 'aborted', resultJson: null });
    expect(await finish(name, invocation.invocationId, { result: { ok: true, usage: { credits: 12 } }, options: { creditCap: 100 } })).toEqual(cancelled);
    expect(await execution(name)).toMatchObject({ credits: 0, fatalCode: null });
  });
});
