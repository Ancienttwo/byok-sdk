import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import * as mutationGate from '../../util/path-mutation-gate';

/**
 * Replaces only the `service-lifecycle` kernel gate with an in-process one
 * for the calling test file; every other scope stays the real OS lock. The
 * real gate is one lock per user, so test files in parallel workers would
 * refuse each other with `lifecycle_owner_busy`. `lifecycle-service-unit.test.ts`
 * exercises the real gate, across OS processes included.
 */
export function useInProcessServiceLifecycleGate(): void {
  let spy: MockInstance<typeof mutationGate.acquirePathMutationGate> | undefined;
  beforeEach(() => {
    const original = mutationGate.acquirePathMutationGate;
    let held = false;
    spy = vi.spyOn(mutationGate, 'acquirePathMutationGate').mockImplementation(async (input, options) => {
      if (input.scope !== 'service-lifecycle') return original(input, options);
      if (held) throw new mutationGate.PathMutationGateBusyError('service-lifecycle', '*');
      held = true;
      let released = false;
      return {
        scope: 'service-lifecycle',
        targetPath: '*',
        identity: 'service-lifecycle',
        async release() {
          if (!released) { released = true; held = false; }
        },
      };
    });
  });
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });
}
