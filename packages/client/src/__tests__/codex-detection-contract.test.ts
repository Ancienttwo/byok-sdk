import { expect, it } from 'vitest';
import { validateRuntimeDetectResult } from '../runtime-detection';
it('preserves typed Codex refusal app_server_unavailable', () => {
  expect(validateRuntimeDetectResult({ kind: 'refused', reason: 'app_server_unavailable' })).toEqual({
    kind: 'refused',
    reason: 'app_server_unavailable',
  });
});
it('has no version refusal: a runtime version is observed, never gated', () => {
  expect(() => validateRuntimeDetectResult({ kind: 'refused', reason: 'runtime_version_unsupported' })).toThrow();
});
it('preserves an unqualified-version warning on an available result', () => {
  const available = { kind: 'available', version: 'codex-cli 0.161.0', versionVerdict: { state: 'warn', qualifiedVersion: '0.160.0' } };
  expect(validateRuntimeDetectResult(available)).toEqual(available);
  expect(() => validateRuntimeDetectResult({ ...available, versionVerdict: { ...available.versionVerdict, note: 'x' } })).toThrow();
});
it('does not accept free-form unsupported vocabulary', () => {
  expect(() => validateRuntimeDetectResult({ kind: 'unsupported' })).toThrow();
  expect(() =>
    validateRuntimeDetectResult({ kind: 'refused', reason: 'anything' }),
  ).toThrow();
});
