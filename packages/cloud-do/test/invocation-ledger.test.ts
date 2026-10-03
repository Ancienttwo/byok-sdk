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
