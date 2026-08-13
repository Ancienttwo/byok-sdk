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
    });
  });

  it('fails closed for a bare throw without copying or parsing its message', () => {
    const projection = projectRuntimeBoundaryFailure(new Error('spawn ENOENT retry me'), 'start');
    expect(projection).toEqual({
      reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON.start,
      retryable: false,
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

  it('statically guards TaskRunner against message parsing and catch-all retry defaults', async () => {
    const source = await fs.readFile(fileURLToPath(new URL('../daemon/task-runner.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('runtime error: ${errorMessage(err)}');
    expect(source).not.toContain('adapter failed to start: ${errorMessage(err)}');
    expect(source).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*runtime[^}]*retryable\s*:\s*true/s);
    expect(source).toContain("projectRuntimeBoundaryFailure(err, 'start')");
    expect(source).toContain("projectRuntimeBoundaryFailure(err, 'run')");
  });
});
