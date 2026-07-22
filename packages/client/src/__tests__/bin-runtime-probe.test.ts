import { describe, expect, it } from 'vitest';
import { defaultRuntimeAdapters, probeRuntimes } from '../bin/runtime-probe';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

describe('bin/runtime-probe: defaultRuntimeAdapters', () => {
  it('with no allowlist, returns all three bundled runtimes in canonical order', () => {
    const adapters = defaultRuntimeAdapters(undefined);
    expect(adapters.map((a) => a.id)).toEqual(['pi', 'claude', 'codex']);
  });

  it('with an allowlist, returns exactly (and only) those runtimes', () => {
    const adapters = defaultRuntimeAdapters(['claude', 'codex']);
    expect(adapters.map((a) => a.id).sort()).toEqual(['claude', 'codex']);
  });

  it('silently ignores an unknown id in the allowlist', () => {
    const adapters = defaultRuntimeAdapters(['pi', 'not-a-real-runtime']);
    expect(adapters.map((a) => a.id)).toEqual(['pi']);
  });

  it('an empty allowlist yields no adapters at all', () => {
    expect(defaultRuntimeAdapters([])).toEqual([]);
  });
});

describe('bin/runtime-probe: probeRuntimes', () => {
  it('maps a present adapter\'s detect()+capabilities() into a flattened ProbedRuntime', async () => {
    const adapter = new StubRuntimeAdapter('pi', { present: true, version: '1.2.3', authPresent: true });
    const [probed] = await probeRuntimes([adapter]);
    expect(probed).toEqual({
      id: 'pi',
      present: true,
      version: '1.2.3',
      authPresent: true,
      steer: true,
      resume: true,
      // M5 batch-3: StubRuntimeAdapter's default capabilities are
      // deliberately maximally permissive (all four modes) — see
      // fixtures/stub-adapter.ts's `DEFAULT_STUB_CAPABILITIES` doc comment —
      // not modeled on the real pi adapter's own narrower declared set
      // (pi-adapter.test.ts pins that real set separately).
      permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
    });
  });

  it('maps an absent adapter without version/authPresent', async () => {
    const adapter = new StubRuntimeAdapter('claude', { present: false });
    const [probed] = await probeRuntimes([adapter]);
    expect(probed).toEqual({
      id: 'claude',
      present: false,
      version: undefined,
      authPresent: undefined,
      steer: true,
      resume: true,
      permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
    });
  });

  it('probes multiple adapters in parallel, preserving input order', async () => {
    const pi = new StubRuntimeAdapter('pi', { present: true });
    const claude = new StubRuntimeAdapter('claude', { present: false });
    const codex = new StubRuntimeAdapter('codex', { present: true, version: '9.9.9' });
    const probed = await probeRuntimes([pi, claude, codex]);
    expect(probed.map((r) => r.id)).toEqual(['pi', 'claude', 'codex']);
    expect(probed.map((r) => r.present)).toEqual([true, false, true]);
  });

  it('treats a throwing detect() as present:false rather than rejecting the whole probe', async () => {
    const broken: StubRuntimeAdapter = new StubRuntimeAdapter('broken');
    broken.detect = () => Promise.reject(new Error('boom'));
    const [probed] = await probeRuntimes([broken]);
    expect(probed?.present).toBe(false);
    expect(probed?.id).toBe('broken');
  });
});
