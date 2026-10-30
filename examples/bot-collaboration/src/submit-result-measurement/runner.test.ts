// End-to-end runs of the #610 runner against a fake runtime only: an embedded
// Host, a paired daemon and the real submit_result helper. No provider call.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '@byok-sdk/client';
import { afterEach, expect, it } from 'vitest';
import { main } from './cli';
import { FAKE_CAPACITY_REASON, FakeMeasurementAdapter, type FakeBehavior } from './fake-runtime.test-support';
import type { NotStartedRow, RunManifest, TrialRecord } from './records';

// The client's fake codex app-server: a real MCP stdio client of the session's result helper.
const FAKE_CODEX = fileURLToPath(new URL('../../../../packages/client/src/__tests__/fixtures/fake-codex.mjs', import.meta.url));
const savedSubmitResult = process.env.FAKE_CODEX_SUBMIT_RESULT;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (savedSubmitResult === undefined) delete process.env.FAKE_CODEX_SUBMIT_RESULT; else process.env.FAKE_CODEX_SUBMIT_RESULT = savedSubmitResult;
});

async function tempDir(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function readRun(out: string) {
  const lines = async (name: string) => (await readFile(path.join(out, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    manifest: JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')) as RunManifest,
    trials: await lines('trials.jsonl') as TrialRecord[],
    notStarted: await lines('not-started.jsonl') as NotStartedRow[],
    summary: JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8')),
    markdown: await readFile(path.join(out, 'summary.md'), 'utf8'),
  };
}

async function allText(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return text;
}

async function execute(script: readonly FakeBehavior[], extra: readonly string[]) {
  const out = await tempDir('m610-out-');
  const adapter = new FakeMeasurementAdapter(index => script[index] ?? 'exact');
  const lines: string[] = [];
  const code = await main(['--runtime', 'pi', '--model', 'fake-model', '--run-id', 'test', '--rounds', '1', '--execute',
    '--authorization', 'synthetic-test', '--max-spend', '0', '--out', out, ...extra], { adapters: () => [adapter], stdout: line => lines.push(line) });
  return { code, out, adapter, lines, run: await readRun(out) };
}

it('a dry run prints the plan and the runtime task count and builds no adapter', async () => {
  const lines: string[] = [];
  const code = await main(['--runtime', 'codex', '--model', 'gpt-test'], {
    adapters: () => { throw new Error('a dry run must not build an adapter'); }, stdout: line => lines.push(line),
  });
  expect(code).toBe(0);
  const text = lines.join('\n');
  expect(text).toContain('DRY RUN: no daemon, no runtime and no provider call.');
  expect(text).toContain('1 uncounted calibration trial + 20 rounds x 6 cases = 120 counted trials');
  expect(text).toContain('Runtime tasks: 121');
  expect(text).toContain('Instruction bytes: 65850 per round, 1317000 in all counted rounds.');
  expect(text).toContain('preflight ok');
});

it('a real run refuses to start without an authorization, a deadline, a spend limit and an output directory', async () => {
  const errors: string[] = [];
  const code = await main(['--runtime', 'claude', '--model', 'test', '--execute'], {
    adapters: () => { throw new Error('a refused run must not build an adapter'); }, stderr: line => errors.push(line),
  });
  expect(code).toBe(2);
  expect(errors.join('\n')).toContain('--execute requires --authorization, --deadline-ms, --max-spend, --out');
});

it('refuses repeated cases and operator facts that would replace generated facts', async () => {
  for (const extra of [['--cases', 'C01-small,C01-small'], ['--cell', 'model=other'], ['--cell', 'platform=other'], ['--cell', 'sdkBuild=x']]) {
    const errors: string[] = [];
    const code = await main(['--runtime', 'pi', '--model', 'test', ...extra], {
      adapters: () => { throw new Error('a refused run must not build an adapter'); }, stdout: () => {}, stderr: line => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors.join('\n')).toMatch(extra[0] === '--cases' ? /must not repeat a case/ : /is set by the runner/);
  }
});

it('classifies every case from Host-captured evidence after a calibration confirms the call label', async () => {
  const { code, out, adapter, run } = await execute(
    ['exact', 'exact', 'reject-then-correct', 'wrong', 'reject-only', 'no-call', 'capacity'],
    ['--deadline-ms', '60000'],
  );
  expect(code).toBe(0);
  expect(adapter.behaviors).toHaveLength(7);
  const { manifest, trials, notStarted, summary, markdown } = run;
  expect(manifest).toMatchObject({ mode: 'synthetic', synthetic: true, completion: 'complete', startedTrials: 6, notStartedTrials: 0,
    predicate: { confirmed: true, label: { tool: 'submit_result' }, source: 'calibration:calibration-1' },
    calibration: { trialId: 'calibration-1', caseId: 'C01-small', category: 'valid' } });
  expect(manifest.cell).toMatchObject({ runtime: 'pi', model: 'fake-model', concurrency: 1, agentMemory: 'none', replyDelivery: 'not_configured' });
  expect(manifest.cell).toMatchObject({ eventSource: 'adapter-boundary', activityMaxBytes: expect.any(Number) });
  expect(notStarted).toEqual([]);
  const byCase = Object.fromEntries(trials.map(trial => [trial.caseId, trial]));
  expect(byCase['C01-small']).toMatchObject({ category: 'valid', exactTarget: true, firstCallValid: true, replyDelivery: 'not_configured', usage: [{ type: 'usage', inputTokens: 10, outputTokens: 5 }] });
  expect(byCase['C01-small']!.submissions).toEqual([expect.objectContaining({ index: 0, validation: 'staged', label: { tool: 'submit_result' } })]);
  expect(byCase['C02-scalars']).toMatchObject({ category: 'valid', exactTarget: true, firstCallValid: false });
  expect(byCase['C02-scalars']!.submissions.map(submission => submission.validation)).toEqual(['rejected', 'staged']);
  expect(byCase['C03-array']).toMatchObject({ category: 'valid', exactTarget: false, firstCallValid: true });
  expect(byCase['C04-union']).toMatchObject({ category: 'invalid', exactTarget: false, terminal: { status: 'task.fail', reason: expect.stringMatching(/^result_not_submitted:/) } });
  expect(byCase['C05-unicode']).toMatchObject({ category: 'missing', submissions: [] });
  expect(byCase['C06-large']).toMatchObject({ category: 'terminal_failure', cause: FAKE_CAPACITY_REASON, terminal: { status: 'task.fail', reason: FAKE_CAPACITY_REASON } });
  expect(summary.cell).toMatchObject({ planned: 6, started: 6, valid: { successes: 3, n: 6 }, exactTarget: { successes: 2, n: 6 }, firstCallValid: { successes: 2, n: 6 } });
  expect(summary.byCase['C06-large'].categories.terminal_failure.successes).toBe(1);
  expect(markdown).toContain('synthetic: plumbing only, not model behavior');
  const text = await allText(out);
  expect(text).not.toContain(os.homedir());
  expect(text).not.toContain(os.tmpdir());
}, 180_000);

it('without a confirmed label, records no missing; it records a decline as not started and a hang as a timeout', async () => {
  const { code, run } = await execute(
    ['no-call', 'no-call', 'runtime-error', 'decline', 'hang'],
    ['--cases', 'C01-small,C02-scalars,C03-array,C04-union', '--deadline-ms', '15000'],
  );
  expect(code).toBe(0);
  const { manifest, trials, notStarted, summary } = run;
  expect(manifest.predicate).toEqual({ confirmed: false, label: null, source: 'none' });
  expect(manifest.calibration).toMatchObject({ category: 'unobservable', label: null });
  const byCase = Object.fromEntries(trials.map(trial => [trial.caseId, trial]));
  expect(byCase['C01-small']).toMatchObject({ category: 'unobservable', cause: 'no_confirmed_call_predicate' });
  expect(byCase['C02-scalars']).toMatchObject({ category: 'terminal_failure', cause: null, terminal: { status: 'task.fail', reason: 'fake runtime crashed' } });
  expect(byCase['C04-union']).toMatchObject({ category: 'timeout', elapsedMs: null, submissionSeen: false });
  expect(notStarted).toEqual([expect.objectContaining({ caseId: 'C03-array', stage: 'decline', reason: 'fake runtime declined' })]);
  expect(summary.cell).toMatchObject({ planned: 4, started: 3, notStarted: 1, latencyMs: { censoredTimeouts: 1 } });
  // A counted trial that did not start leaves the batch incomplete.
  expect(manifest).toMatchObject({ completion: 'incomplete', startedTrials: 3, notStartedTrials: 1 });
}, 180_000);

it('records the admission timings that the claim and the decline carried (#1014)', async () => {
  const { code, run } = await execute(['exact', 'exact', 'decline'], ['--cases', 'C01-small,C02-scalars', '--deadline-ms', '15000']);
  expect(code).toBe(0);
  const byCase = Object.fromEntries(run.trials.map(trial => [trial.caseId, trial]));
  expect(byCase['C01-small']!.admission).toEqual(expect.objectContaining({ totalMs: expect.any(Number), resultHelperPreflightMs: expect.any(Number) }));
  expect(run.notStarted).toEqual([expect.objectContaining({ caseId: 'C02-scalars', stage: 'decline', admission: expect.objectContaining({ totalMs: expect.any(Number) }) })]);
}, 180_000);

it('stops at max-trials and marks the cell incomplete', async () => {
  const { run } = await execute([], ['--cases', 'C01-small,C02-scalars', '--max-trials', '1', '--deadline-ms', '60000']);
  expect(run.manifest).toMatchObject({ completion: 'incomplete', startedTrials: 1, plan: { plannedTrials: 2, runtimeTasks: 2 } });
  expect(run.summary.cell).toMatchObject({ planned: 2, started: 1 });
}, 120_000);

// Windows is skipped as in the client's submit_result CLI smoke: the fake codex is a shebang script.
it.skipIf(process.platform === 'win32')('observes a real CodexAdapter through the adapter-boundary wrapper and confirms the Codex label', async () => {
  process.env.FAKE_CODEX_SUBMIT_RESULT = JSON.stringify({ text: 'measurement-ok' });
  const out = await tempDir('m610-codex-');
  const code = await main(['--runtime', 'codex', '--model', 'fake-codex-model', '--run-id', 'codex', '--rounds', '1', '--cases', 'C01-small',
    '--execute', '--authorization', 'synthetic-test', '--max-spend', '0', '--deadline-ms', '60000', '--out', out], {
    // The test sets FAKE_CODEX_SUBMIT_RESULT itself: a Host variable reaches the runtime only through pass (#1095).
    adapters: () => [new CodexAdapter({ resolveBin: () => ({ command: FAKE_CODEX, source: 'path' }), runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_CODEX_SUBMIT_RESULT'] } })], stdout: () => {},
  });
  expect(code).toBe(0);
  const { manifest, trials } = await readRun(out);
  const label = { tool: 'mcp_tool_call', mcp: { server: 'byokagentresult', tool: 'submit_result' } };
  expect(manifest).toMatchObject({ completion: 'complete', predicate: { confirmed: true, label }, calibration: { category: 'valid', label } });
  expect(manifest.cell).toMatchObject({ runtime: 'codex', dispatchSelection: { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'fake-codex-model' } });
  expect(trials).toEqual([expect.objectContaining({ caseId: 'C01-small', category: 'valid', exactTarget: true, firstCallValid: true })]);
  expect(trials[0]!.submissions).toEqual([expect.objectContaining({ validation: 'staged', label })]);
}, 120_000);
