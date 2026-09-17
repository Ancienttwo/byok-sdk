import { describe, expect, it, vi } from 'vitest';
import { defaultRuntimeAdapters, probeRuntimes } from '../bin/runtime-probe';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

describe('bin/runtime-probe: defaultRuntimeAdapters', () => {
  it('with no allowlist, returns all three bundled runtimes in canonical order', () => {
    const adapters = defaultRuntimeAdapters(undefined);
    expect(adapters.map((a) => a.descriptor.id)).toEqual(['pi', 'claude', 'codex']);
  });

  it('with an allowlist, returns exactly (and only) those runtimes', () => {
    const adapters = defaultRuntimeAdapters(['claude', 'codex']);
    expect(adapters.map((a) => a.descriptor.id).sort()).toEqual(['claude', 'codex']);
  });

  it('silently ignores an unknown id in the allowlist', () => {
    const adapters = defaultRuntimeAdapters(['pi', 'not-a-real-runtime']);
    expect(adapters.map((a) => a.descriptor.id)).toEqual(['pi']);
  });

  it('an empty allowlist yields no adapters at all', () => {
    expect(defaultRuntimeAdapters([])).toEqual([]);
  });
});

describe('bin/runtime-probe: probeRuntimes', () => {
  it('maps a present adapter\'s detect()+capabilities() into a flattened ProbedRuntime', async () => {
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available', version: '1.2.3', authPresent: true });
    const [probed] = await probeRuntimes([adapter]);
    expect(probed).toEqual({
      id: 'pi',
      present: true,
      outcome: 'available',
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
    const adapter = new StubRuntimeAdapter('claude', { kind: 'not-found' });
    const [probed] = await probeRuntimes([adapter]);
    expect(probed).toEqual({
      id: 'claude',
      present: false,
      outcome: 'not-found',
      version: undefined,
      authPresent: undefined,
      steer: true,
      resume: true,
      permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
    });
  });

  it('probes multiple adapters in parallel, preserving input order', async () => {
    const pi = new StubRuntimeAdapter('pi', { kind: 'available' });
    const claude = new StubRuntimeAdapter('claude', { kind: 'not-found' });
    const codex = new StubRuntimeAdapter('codex', { kind: 'available', version: '9.9.9' });
    const probed = await probeRuntimes([pi, claude, codex]);
    expect(probed.map((r) => r.id)).toEqual(['pi', 'claude', 'codex']);
    expect(probed.map((r) => r.present)).toEqual([true, false, true]);
  });

  it('reports a throwing detect() as probe-failed without rejecting other probes', async () => {
    const broken: StubRuntimeAdapter = new StubRuntimeAdapter('broken');
    broken.detect = () => Promise.reject(new Error('boom'));
    const [probed] = await probeRuntimes([broken]);
    expect(probed?.present).toBe(false);
    expect(probed?.outcome).toBe('probe-failed');
    expect(probed?.id).toBe('broken');
  });

  it('a wrapper deadline stays timeout after a late typed refusal, without claiming cancellation', async () => {
    vi.useFakeTimers();
    try {
      let settle!: (value: { kind: 'refused'; reason: 'install_record_mismatch' }) => void;
      const adapter = Object.assign(new StubRuntimeAdapter('pi'), {
        detectInstallation: vi.fn(() => new Promise<{ kind: 'refused'; reason: 'install_record_mismatch' }>(resolve => { settle = resolve; })),
      });
      const pending = probeRuntimes([adapter], { timeoutMs: 25, toolImplementationAuthority: { resolve: async () => ({ kind: 'unavailable', reason: 'resolver_unconfigured' }) } });
      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;
      expect(result[0]).toMatchObject({ outcome: 'timeout', present: false });
      settle({ kind: 'refused', reason: 'install_record_mismatch' });
      await Promise.resolve();
      expect(result[0]).not.toHaveProperty('reason');
      expect(adapter.detectInstallation).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('does not parse a custom error message into a trusted reason or expose it', async () => {
    const adapter = Object.assign(new StubRuntimeAdapter('pi'), {
      detectInstallation: async () => { throw new Error('install_record_mismatch /private/PRIVATE_SENTINEL credential=PRIVATE_SENTINEL'); },
    });
    const [result] = await probeRuntimes([adapter], { toolImplementationAuthority: { resolve: async () => ({ kind: 'unavailable', reason: 'resolver_unconfigured' }) } });
    expect(result).toMatchObject({ outcome: 'probe-failed', present: false });
    expect(result).not.toHaveProperty('reason');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  });
});
