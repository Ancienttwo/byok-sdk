import { describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON,
  RuntimeExecutionFailure,
  isRuntimeExecutionFailure,
  projectRuntimeBoundaryFailure,
  projectRuntimeExecutionFailure,
} from '../runtime-failure';
import type { RuntimeFailurePhase } from '../runtime-failure';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oarStartClassifier, runtimeStartFailure } from '../adapters/runtime-start-failure';
import { SessionNotFoundError } from '../../vendor/oar/223703d/contracts/session-not-found-error';
import { SessionUnavailableError } from '../../vendor/oar/223703d/contracts/session-unavailable-error';
import { UnsupportedOptionError } from '../../vendor/oar/223703d/contracts/errors';
import { ModelConfirmationError } from '../../vendor/oar/223703d/contracts/model-confirmation-error';
import { RuntimeFailureError } from '../../vendor/oar/223703d/contracts/runtime-failure-error';
import { configureAntigravityModel } from '../../vendor/oar/223703d/runtimes/antigravity/model-selection';

const teardownIsNotExecutionPhase = (): RuntimeFailurePhase => {
  // @ts-expect-error teardown evidence belongs to Sprint Row 3, not the execution failure union.
  return 'teardown';
};
void teardownIsNotExecutionPhase;

describe('RuntimeExecutionFailure', () => {
  it('projects the explicit retry disposition without inferring from reason text', () => {
    const failure = new RuntimeExecutionFailure({
      phase: 'run',
      retry: 'non-retryable',
      reason: 'temporary network words are diagnostic text only',
    });

    expect(isRuntimeExecutionFailure(failure)).toBe(true);
    expect(projectRuntimeExecutionFailure(failure)).toEqual({
      reason: 'temporary network words are diagnostic text only',
      retryable: false,
      failure: { class: 'unknown' },
    });
  });

  it('fails closed for a bare throw without copying or parsing its message', () => {
    const projection = projectRuntimeBoundaryFailure(new Error('spawn ENOENT retry me'), 'start');
    expect(projection).toEqual({
      reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON.start,
      retryable: false,
      failure: { class: 'unknown' },
      contractViolation: true,
    });
  });

  it('fails closed when a typed failure crosses the wrong lifecycle phase', () => {
    const failure = new RuntimeExecutionFailure({
      phase: 'start',
      retry: 'retryable',
      reason: 'start transport unavailable',
    });
    expect(projectRuntimeBoundaryFailure(failure, 'run')).toEqual({
      reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON.run,
      retryable: false,
      failure: { class: 'unknown' },
      contractViolation: true,
    });
  });

  it('rejects invalid JavaScript construction and freezes valid failure authority', () => {
    expect(() => new RuntimeExecutionFailure({
      phase: 'run',
      retry: 'sometimes' as never,
      reason: 'invalid retry disposition',
    })).toThrow(/invalid RuntimeExecutionFailure input/);

    const failure = new RuntimeExecutionFailure({
      phase: 'start',
      retry: 'non-retryable',
      reason: 'manifest mismatch',
    });
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('carries a runtime failure class verbatim and rejects one the wire would refuse (#869)', () => {
    const base = { phase: 'run', retry: 'non-retryable', reason: 'quota' } as const;
    const quota = new RuntimeExecutionFailure({ ...base, failure: { class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' } });
    expect(projectRuntimeExecutionFailure(quota).failure).toEqual({ class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' });
    expect(Object.isFrozen(quota.failure)).toBe(true);
    expect(isRuntimeExecutionFailure(quota)).toBe(true);
    expect(projectRuntimeBoundaryFailure(new RuntimeExecutionFailure({ ...base, failure: { class: 'auth' } }), 'run').failure).toEqual({ class: 'auth' });

    for (const failure of [
      { class: 'logged_out' },
      { class: 'rate_limited', resetsAt: '2026-10-24T05:00:00.000Z' },
      { class: 'quota', resetsAt: '2026-10-24T05:00:00Z' },
      { class: 'quota', resetsAt: 'tomorrow' },
      { class: 'quota', resetsAt: '+055840-11-08T22:13:20.000Z' },
      { class: 'quota', resetsAt: '-000001-01-01T00:00:00.000Z' },
      { class: 'auth', scope: 'account' },
      { class: 'quota', scope: 'opus' },
      { class: 'unknown', status: 401 },
    ]) {
      expect(() => new RuntimeExecutionFailure({ ...base, failure: failure as never }), JSON.stringify(failure)).toThrow(/invalid RuntimeExecutionFailure input/);
    }
  });

  it('statically guards TaskRunner against message parsing and catch-all retry defaults', async () => {
    // TaskRunner's member bodies live in daemon/task-runner/ beside the class (#926).
    const moduleDir = fileURLToPath(new URL('../daemon/task-runner/', import.meta.url));
    const modules = (await fs.readdir(moduleDir)).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('.test.')).sort();
    const source = [
      await fs.readFile(fileURLToPath(new URL('../daemon/task-runner.ts', import.meta.url)), 'utf8'),
      ...(await Promise.all(modules.map((name) => fs.readFile(`${moduleDir}${name}`, 'utf8')))),
    ].join('\n');
    expect(source).not.toContain('runtime error: ${errorMessage(err)}');
    expect(source).not.toContain('adapter failed to start: ${errorMessage(err)}');
    expect(source).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*runtime[^}]*retryable\s*:\s*true/s);
    expect(source).toContain("projectRuntimeBoundaryFailure(err, 'start')");
    expect(source).toContain("projectRuntimeBoundaryFailure(err, 'run')");
  });
});

describe('runtime start failures', () => {
  const classify = oarStartClassifier({ SessionNotFoundError, SessionUnavailableError, UnsupportedOptionError, ModelConfirmationError, RuntimeFailureError });
  const details = { method: 'resume', native: {} };
  const typed = new RuntimeExecutionFailure({ phase: 'run', retry: 'retryable', reason: 'typed', failure: { class: 'quota' } });
  it.each([
    [typed, 'retryable', 'quota', 'typed'],
    [new SessionNotFoundError('id', 'missing', details), 'non-retryable', 'unknown', 'missing'],
    [new SessionUnavailableError('id', 'archived', { ...details, reason: 'archived' }), 'non-retryable', 'unknown', 'archived'],
    [new SessionUnavailableError('id', 'in use', { ...details, reason: 'in_use' }), 'retryable', 'unknown', 'in use'],
    [new UnsupportedOptionError('model', 'unsupported'), 'non-retryable', 'unknown', 'unsupported'],
    [new UnsupportedOptionError('effort', 'effort refused'), 'non-retryable', 'invalid_request', 'effort refused'],
    [new UnsupportedOptionError('serviceTier', 'tier refused'), 'non-retryable', 'invalid_request', 'tier refused'],
    [new UnsupportedOptionError('serviceTierFallback', 'fallback refused'), 'non-retryable', 'invalid_request', 'fallback refused'],
    [new ModelConfirmationError('kept', { requested: 'a', reported: 'b' }), 'non-retryable', 'model_unavailable', 'model_rejected'],
    [new RuntimeFailureError('auth', 'login'), 'non-retryable', 'auth', 'login'],
    [new Error('exit'), 'retryable', 'runtime_exited', 'exit'],
  ])('classifies %s', (error, retry, failureClass, message) => {
    const result = runtimeStartFailure(error, { classify, exitedOnItsOwn: true, runtime: 'codex' });
    expect(result).toMatchObject({ phase: 'start', retry, failure: { class: failureClass }, message, cause: error });
    expect(projectRuntimeBoundaryFailure(result, 'start').retryable).toBe(retry === 'retryable');
  });
  it('uses the runtime name for non-error throws and unknown for a live process', () => {
    expect(runtimeStartFailure(null, { classify, exitedOnItsOwn: false, runtime: 'grok' })).toMatchObject({ message: 'grok open failed', failure: { class: 'unknown' }, cause: null });
  });

  // OAR 0.111 refuses these agy selectors from the native catalog, before any model request; 0.110 sent them and agy refused them as model_unavailable (#2361).
  const catalog = (models: string[]) => ({ configOptions: [{ id: 'model', currentValue: models[0], options: models.map(value => ({ value })) }] });
  it.each([
    ['an unknown model', ['gemini-3-pro', 'gemini-3-flash'], 'claude-opus', undefined],
    ['an ambiguous model-effort selector', ['gemini-3', 'gemini-3-pro'], 'gemini-3-pro-high', undefined],
    ['an effort outside the model menu', ['gemini-3-pro'], 'gemini-3-pro-xhigh',
      { configOptions: [{ id: 'model', currentValue: 'gemini-3-pro' }, { id: 'thought_level', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] }] }],
  ])('fails an agy start with %s as the model_unavailable it was before', async (_case, models, model, menu) => {
    const setModel = vi.fn(async () => menu);
    const setEffort = vi.fn(async () => ({}));
    const refusal = await configureAntigravityModel({ options: { model } as never, response: catalog(models), setModel, setEffort }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ModelConfirmationError);
    expect(setModel).toHaveBeenCalledTimes(menu === undefined ? 0 : 1);
    expect(setEffort).not.toHaveBeenCalled();
    const after = runtimeStartFailure(refusal, { classify, exitedOnItsOwn: false, runtime: 'agy' });
    expect(after).toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'model_unavailable' }, message: 'model_rejected' });
  });
});
