// Pure parts of the #610 runner: corpus, digest, classification order,
// Wilson intervals and redaction. No daemon, no runtime.
import { expect, it } from 'vitest';
import { CORPUS, corpusCase, preflightCorpus } from './corpus';
import { resultDigest } from './digest';
import { classifyTrial, extractSubmissions, findHelperBody, type CallPredicate, type ObservedEvent, type TrialObservation } from './evidence';
import { planTrials } from './harness';
import { redact } from './records';
import { wilson } from './summary';

const at = '2026-10-23T00:00:00.000Z';
const confirmed: CallPredicate = { confirmed: true, label: { tool: 'submit_result' }, source: 'calibration:test' };
const staged = (receiptId: string) => ({ content: [{ type: 'text', text: JSON.stringify({ receiptId, state: 'staged' }) }] });
const rejected = { content: [{ type: 'text', text: JSON.stringify({ error: 'result_rejected', reason: 'schema-mismatch', issues: [], truncated: false }) }], isError: true };
const call = (id: string, input: unknown, output: unknown, isError = false): ObservedEvent[] => [
  { at, event: { type: 'tool_use', tool: 'submit_result', toolCallId: id, input } },
  { at, event: { type: 'tool_result', tool: 'submit_result', toolCallId: id, output, isError } },
];
const turnEnd: ObservedEvent = { at, event: { type: 'turn_end' } };
const observation = (overrides: Partial<TrialObservation>): TrialObservation => ({
  events: [], terminal: null, staged: null, deadlineExpired: false, infrastructure: null, operatorCancelled: false, ...overrides,
});
const fail = (reason: string) => ({ status: 'task.fail' as const, at, reason, hasDocument: false });
const complete = (document: unknown) => ({ status: 'task.complete' as const, at, reason: null, hasDocument: true, document });
const classify = (caseId: string, input: Partial<TrialObservation>, predicate: CallPredicate = confirmed) =>
  classifyTrial(observation(input), { corpusCase: corpusCase(caseId), predicate, capacityReasons: ['context_overflow'] });

it('keeps the frozen corpus bytes of the method doc and passes the pinned preflight', () => {
  expect(CORPUS.map(entry => entry.id)).toEqual(['C01-small', 'C02-scalars', 'C03-array', 'C04-union', 'C05-unicode', 'C06-large']);
  const sum = (pick: (entry: typeof CORPUS[number]) => number) => CORPUS.reduce((total, entry) => total + pick(entry), 0);
  expect(sum(entry => entry.bytes.instruction)).toBe(65_850);
  expect(corpusCase('C06-large').bytes.instruction).toBe(64_154);
  expect(sum(entry => entry.bytes.target)).toBe(64_992);
  expect(corpusCase('C06-large').bytes.target).toBe(64_011);
  expect(preflightCorpus()).toEqual({ ok: true, failures: [] });
  expect(preflightCorpus([{ ...corpusCase('C01-small'), target: { text: 'x'.repeat(65) } }]))
    .toEqual({ ok: false, failures: [expect.objectContaining({ caseId: 'C01-small', step: 'validateResultOutcome' })] });
});

it('compares documents by the key-sorted digest, not by JSON.stringify', () => {
  const target = corpusCase('C02-scalars').target;
  const reordered = { confirmed: false, count: 3, action: 'ask_user' };
  expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(target));
  expect(resultDigest(reordered)).toBe(corpusCase('C02-scalars').targetDigest);
  expect(resultDigest({ items: [{ id: 2 }, { id: 1 }] })).not.toBe(resultDigest({ items: [{ id: 1 }, { id: 2 }] }));
  expect(classify('C02-scalars', { events: [...call('a', reordered, staged('r1')), turnEnd], terminal: complete(reordered) }))
    .toMatchObject({ category: 'valid', exactTarget: true, firstCallValid: true });
});

it('reads the helper body from each runtime output shape and ignores a spilled preview', () => {
  expect(findHelperBody(staged('r1'))).toEqual({ kind: 'staged', receiptId: 'r1' });
  expect(findHelperBody({ status: 'completed', result: staged('r2') })).toEqual({ kind: 'staged', receiptId: 'r2' });
  expect(findHelperBody(rejected)).toEqual({ kind: 'rejected', reason: 'schema-mismatch' });
  expect(findHelperBody('plain text')).toBeUndefined();
  const spilled: ObservedEvent[] = [{ at, event: { type: 'tool_result', tool: 'submit_result', toolCallId: 's', output: staged('r3'), spill: { totalBytes: 1 } } }];
  expect(extractSubmissions(spilled, confirmed, null)).toEqual([expect.objectContaining({ validation: 'unknown' })]);
  // A Codex call: the result carries the label and `output.status`; no tool_use is required.
  const codex: ObservedEvent[] = [{ at, event: { type: 'tool_result', tool: 'mcp_tool_call', mcp: { server: 'byokagentresult', tool: 'submit_result' }, toolCallId: 'c', output: { status: 'failed', error: 'refused' } } }];
  const codexPredicate: CallPredicate = { confirmed: true, label: { tool: 'mcp_tool_call', mcp: { server: 'byokagentresult', tool: 'submit_result' } }, source: 'test' };
  expect(extractSubmissions(codex, codexPredicate, null)).toEqual([expect.objectContaining({ validation: 'error', label: codexPredicate.label })]);
  expect(extractSubmissions(codex, confirmed, null)).toEqual([]);
});

it('assigns one category in the order of the method doc', () => {
  const capacity = fail('context_overflow: provider call 1');
  // The C06 capacity rule comes before every other category.
  expect(classify('C06-large', { terminal: capacity, infrastructure: { stage: 'host', code: 'lost' } }))
    .toMatchObject({ category: 'terminal_failure', cause: 'context_overflow: provider call 1' });
  // Only C06 classifies from the reason string.
  expect(classify('C05-unicode', { terminal: capacity, events: [turnEnd] })).toMatchObject({ category: 'missing' });
  expect(classify('C01-small', { operatorCancelled: true, terminal: complete({ text: 'measurement-ok' }) })).toMatchObject({ category: 'infrastructure_abort', cause: 'operator_cancelled' });
  expect(classify('C01-small', { infrastructure: { stage: 'daemon', code: 'stopped' } })).toMatchObject({ category: 'infrastructure_abort', cause: 'daemon:stopped' });
  expect(classify('C01-small', { deadlineExpired: true, events: call('a', { text: 'x' }, rejected, true) })).toMatchObject({ category: 'timeout', submissionSeen: true });
  expect(classify('C01-small', {})).toMatchObject({ category: 'unobservable' });
  expect(classify('C01-small', { terminal: complete({ text: 'measurement-ok' }), staged: { outcome: { text: 'other' }, contentHash: resultDigest({ text: 'other' }), byteCount: 16, receiptId: 'r', createdAt: at } }))
    .toMatchObject({ category: 'unobservable', cause: 'staged_record_differs_from_terminal' });
  expect(classify('C01-small', { terminal: fail('result_not_submitted: x'), events: [...call('a', { bad: 1 }, rejected, true), turnEnd] })).toMatchObject({ category: 'invalid' });
  expect(classify('C01-small', { terminal: fail('result_not_submitted: x'), events: [turnEnd] })).toMatchObject({ category: 'missing' });
  expect(classify('C01-small', { terminal: fail('result_not_submitted: x'), events: [turnEnd] }, { confirmed: false, label: null, source: 'none' }))
    .toMatchObject({ category: 'unobservable', cause: 'no_confirmed_call_predicate' });
  // No turn_end: the runtime failed before the reply decision, so no call is not `missing`.
  expect(classify('C01-small', { terminal: fail('runtime crashed') })).toMatchObject({ category: 'terminal_failure' });
  // A valid staged submission followed by an execution failure.
  const record = { outcome: { text: 'measurement-ok' }, contentHash: corpusCase('C01-small').targetDigest, byteCount: 25, receiptId: 'r1', createdAt: at };
  expect(classify('C01-small', { terminal: fail('runtime crashed'), staged: record, events: call('a', { text: 'measurement-ok' }, staged('r1')) }))
    .toMatchObject({ category: 'terminal_failure', submissionSeen: true });
});

it('reports exact-target and first-call-valid separately from valid', () => {
  const truncated = { text: 'x'.repeat(10) };
  expect(classify('C06-large', { terminal: complete(truncated), events: call('a', truncated, staged('r1')) }))
    .toMatchObject({ category: 'valid', exactTarget: false, firstCallValid: true });
  const target = corpusCase('C01-small').target;
  expect(classify('C01-small', { terminal: complete(target), events: [...call('a', { bad: 1 }, rejected, true), ...call('b', target, staged('r1'))] }))
    .toMatchObject({ category: 'valid', exactTarget: true, firstCallValid: false });
  expect(classify('C01-small', { terminal: complete(target), events: [] }, { confirmed: false, label: null, source: 'none' }))
    .toMatchObject({ category: 'valid', firstCallValid: null });
});

it('computes 95% Wilson intervals and N/A at n = 0', () => {
  expect(wilson(0, 0)).toEqual({ successes: 0, n: 0, rate: null, wilson95: null });
  const twenty = wilson(20, 20);
  expect(twenty.rate).toBe(1);
  expect(twenty.wilson95!.low).toBeCloseTo(0.8389, 4);
  expect(twenty.wilson95!.high).toBe(1);
  const half = wilson(10, 20);
  expect(half.wilson95!.low).toBeCloseTo(0.2993, 4);
  expect(half.wilson95!.high).toBeCloseTo(0.7007, 4);
});

it('plans one uncounted calibration trial, then C01-C06 for each round', () => {
  const plan = planTrials({ rounds: 2, caseIds: CORPUS.map(entry => entry.id), calibrate: true });
  expect(plan).toHaveLength(13);
  expect(plan[0]).toEqual({ trialId: 'calibration-1', caseId: 'C01-small', round: 0, counted: false });
  expect(plan.slice(1, 7).map(trial => trial.caseId)).toEqual(CORPUS.map(entry => entry.id));
  expect(plan[12]).toEqual({ trialId: 'r02-C06-large', caseId: 'C06-large', round: 2, counted: true });
});

it('replaces local paths in every string form before a file is written', () => {
  const root = 'C:\\Users\\someone\\run';
  const value = { reason: `failed in ${root}\\homes`, nested: [`/home/someone/x and ${root.replaceAll('\\', '/')}`, JSON.stringify({ path: root })] };
  const clean = redact(value, [[root, '<run-root>'], ['/home/someone', '<home>']]);
  expect(JSON.stringify(clean)).not.toContain('someone');
  expect(clean.reason).toBe('failed in <run-root>\\homes');
});
