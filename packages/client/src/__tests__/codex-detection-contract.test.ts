import { expect, it } from 'vitest';
import { validateRuntimeDetectResult } from '../runtime-detection';
it.each(['app_server_unavailable', 'runtime_version_unsupported'] as const)(
  'preserves typed Codex refusal %s',
  (reason) => {
    expect(validateRuntimeDetectResult({ kind: 'refused', reason })).toEqual({
      kind: 'refused',
      reason,
    });
  },
);
it('does not accept free-form unsupported vocabulary', () => {
  expect(() => validateRuntimeDetectResult({ kind: 'unsupported' })).toThrow();
  expect(() =>
    validateRuntimeDetectResult({ kind: 'refused', reason: 'anything' }),
  ).toThrow();
});
