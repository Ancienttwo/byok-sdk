import { describe, expect, it } from 'vitest';
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

const teardownIsNotExecutionPhase = (): RuntimeFailurePhase => {
  // @ts-expect-error teardown evidence belongs to Sprint Row 3, not the execution failure union.
  return 'teardown';
};
void teardownIsNotExecutionPhase;

describe('RuntimeExecutionFailure', () => {
  it('projects the explicit retry disposition without inferring from category or reason text', () => {
    const failure = new RuntimeExecutionFailure({
      phase: 'run',
      category: 'semantic',
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
      category: 'infrastructure',
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
      category: 'infrastructure',
      retry: 'sometimes' as never,
      reason: 'invalid retry disposition',
    })).toThrow(/invalid RuntimeExecutionFailure input/);

    const failure = new RuntimeExecutionFailure({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      reason: 'manifest mismatch',
    });
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('carries a runtime failure class verbatim and rejects one the wire would refuse (#869)', () => {
    const base = { phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'quota' } as const;
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
