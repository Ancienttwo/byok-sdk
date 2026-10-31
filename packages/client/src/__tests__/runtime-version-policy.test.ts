import { describe, expect, it } from 'vitest';
import { CLAUDE_VERSION_POLICY } from '../adapters/claude/claude-version';
import { CODEX_VERSION_POLICY } from '../adapters/codex/codex-version';
import { GROK_VERSION_POLICY } from '../adapters/grok/grok-version';
import { HERMES_VERSION_POLICY } from '../adapters/hermes/hermes-version';
import { PI_VERSION_POLICY } from '../adapters/pi/pi-version';
import {
  InvalidRuntimeVersionPolicyError,
  resolveRuntimeVersionPolicy,
  runtimeVersionDetectionFields,
  runtimeVersionPolicyIssues,
  runtimeVersionVerdict,
  type RuntimeVersionPolicyResolution,
} from '../runtime-version-policy';
import type { RuntimeVersionPolicy } from '../types';

const policy = (overrides: Partial<RuntimeVersionPolicy> = {}): RuntimeVersionPolicy => ({
  qualifiedVersion: '1.0.0',
  unqualified: 'allow',
  ...overrides,
});

function resolutionIssues(run: () => RuntimeVersionPolicyResolution) {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(InvalidRuntimeVersionPolicyError);
    return (error as InvalidRuntimeVersionPolicyError).issues;
  }
  throw new Error('expected the policy to be rejected');
}

describe('runtime version policy evaluation (#1103)', () => {
  it('matches exact tokens and component-boundary prefixes only', () => {
    const value = policy({
      allow: [{ kind: 'exact', version: '2.0.0' }],
      block: [{ kind: 'prefix', prefix: '0.16.' }],
    });
    expect(runtimeVersionVerdict(value, '1.0.0')).toEqual({ state: 'allow', qualifiedVersion: '1.0.0' });
    expect(runtimeVersionVerdict(value, '2.0.0')).toEqual({ state: 'allow', qualifiedVersion: '1.0.0', matched: '2.0.0' });
    expect(runtimeVersionVerdict(value, '0.16.0')).toEqual({ state: 'block', qualifiedVersion: '1.0.0', matched: '0.16.' });
    expect(runtimeVersionVerdict(value, '0.16.1')).toMatchObject({ state: 'block' });
    // The component boundary is why "0.16." must not match "0.160.0".
    expect(runtimeVersionVerdict(value, '0.160.0')).toEqual({ state: 'allow', qualifiedVersion: '1.0.0' });
    expect(runtimeVersionVerdict(value, '0.15.9')).toEqual({ state: 'allow', qualifiedVersion: '1.0.0' });
  });

  it('orders block above allow above warn above unqualified', () => {
    const value = policy({
      unqualified: 'warn',
      allow: [{ kind: 'prefix', prefix: '1.' }],
      warn: [{ kind: 'exact', version: '1.1.0' }],
    });
    expect(runtimeVersionVerdict(value, '1.1.0')).toMatchObject({ state: 'allow' });
    expect(runtimeVersionVerdict(value, '1.2.0')).toMatchObject({ state: 'allow' });
    expect(runtimeVersionVerdict(value, '2.0.0')).toEqual({ state: 'warn', qualifiedVersion: '1.0.0' });
    const blocked = policy({
      unqualified: 'warn',
      allow: [{ kind: 'prefix', prefix: '1.' }],
      block: [{ kind: 'prefix', prefix: '1.1.' }],
    });
    expect(runtimeVersionVerdict(blocked, '1.1.0')).toMatchObject({ state: 'block', matched: '1.1.' });
  });

  it('allows a Host to block every unmatched token, but never produces a verdict without a token', () => {
    expect(runtimeVersionVerdict(policy({ unqualified: 'block' }), '9.9.9')).toEqual({ state: 'block', qualifiedVersion: '1.0.0', matched: 'unqualified' });
    expect(runtimeVersionVerdict(policy(), undefined)).toBeUndefined();
    expect(runtimeVersionVerdict(undefined, '1.0.0')).toBeUndefined();
  });

  it('rejects a prefix without a component boundary and duplicate specs across lists', () => {
    const noBoundary = runtimeVersionPolicyIssues(policy({ block: [{ kind: 'prefix', prefix: '0.16' }] }), { path: 'versionPolicy', hostLayer: true });
    expect(noBoundary).toEqual([expect.objectContaining({ reason: 'invalid_spec', path: 'versionPolicy.block[0].prefix' })]);
    const duplicate = runtimeVersionPolicyIssues(policy({
      allow: [{ kind: 'exact', version: '9.9.9' }],
      warn: [{ kind: 'exact', version: '9.9.9' }],
    }), { path: 'versionPolicy', hostLayer: true });
    expect(duplicate).toEqual([expect.objectContaining({ reason: 'duplicate_spec', path: 'versionPolicy.warn[0]' })]);
    expect(runtimeVersionPolicyIssues(policy({ block: [{ kind: 'prefix', prefix: '0.' }] }), { path: 'versionPolicy', hostLayer: true })).toEqual([]);
  });
});

describe('resolveRuntimeVersionPolicy (#1103 O5)', () => {
  const descriptor = policy({ qualifiedVersion: 'descriptor', unqualified: 'warn', warn: [{ kind: 'exact', version: 'd' }] });
  const adapterOption = policy({ qualifiedVersion: 'adapter', unqualified: 'warn', allow: [{ kind: 'exact', version: 'a' }] });
  const daemonConfig = policy({ qualifiedVersion: 'daemon', unqualified: 'block', block: [{ kind: 'prefix', prefix: '0.16.' }] });

  it('picks daemonConfig > adapterOption > descriptor and never merges fields', () => {
    const resolved = resolveRuntimeVersionPolicy({ descriptor, adapterOption, daemonConfig });
    expect(resolved.source).toBe('daemon-config');
    expect(resolved.policy).toEqual(daemonConfig);
    expect(resolved.policy).not.toHaveProperty('allow');
    expect(resolved.policy).not.toHaveProperty('warn');
    expect(resolved.overridden).toEqual(['descriptor', 'adapter-option']);
    expect(Object.isFrozen(resolved.policy)).toBe(true);
    expect(Object.isFrozen(resolved.policy!.block)).toBe(true);
  });

  it('falls through to each lower layer wholesale', () => {
    expect(resolveRuntimeVersionPolicy({ descriptor, adapterOption })).toMatchObject({ source: 'adapter-option', policy: adapterOption, overridden: ['descriptor'] });
    expect(resolveRuntimeVersionPolicy({ descriptor })).toMatchObject({ source: 'descriptor', policy: descriptor, overridden: [] });
    expect(resolveRuntimeVersionPolicy({})).toEqual({ source: 'none', overridden: [] });
  });

  it('freezes a copy, not the caller object', () => {
    const source = policy({ allow: [{ kind: 'exact', version: '1.0.1' }] });
    const { policy: resolved } = resolveRuntimeVersionPolicy({ adapterOption: source });
    expect(resolved).not.toBe(source);
    expect(resolved!.allow).not.toBe(source.allow);
    expect(resolved).toEqual(source);
  });

  it.each([
    ['a descriptor block', policy({ block: [{ kind: 'exact', version: '1.0.1' }] })],
    ['a descriptor unqualified block', policy({ unqualified: 'block' })],
  ])('rejects %s (block_requires_host)', (_label, descriptorPolicy) => {
    const issues = resolutionIssues(() => resolveRuntimeVersionPolicy({ descriptor: descriptorPolicy }));
    expect(issues).toEqual([expect.objectContaining({ reason: 'block_requires_host' })]);
  });

  it('validates every present candidate, even a losing one', () => {
    const issues = resolutionIssues(() => resolveRuntimeVersionPolicy({
      descriptor: policy(),
      adapterOption: policy({ block: [{ kind: 'prefix', prefix: '0.16' }] }),
      daemonConfig,
    }));
    expect(issues).toEqual([expect.objectContaining({ reason: 'invalid_spec', path: 'adapterOption.versionPolicy.block[0].prefix' })]);
  });
});

describe('default policies preserve today behavior verbatim (#1103 D3)', () => {
  it.each([
    ['codex', CODEX_VERSION_POLICY, '0.160.0', '0.161.0', 'warn'],
    ['grok', GROK_VERSION_POLICY, '1.0.52', '1.0.62', 'warn'],
    ['hermes', HERMES_VERSION_POLICY, '0.22.2+2364.g0b10b9f', '0.23.0', 'warn'],
    ['claude', CLAUDE_VERSION_POLICY, '2.1.312', '2.1.313', 'allow'],
    ['pi', PI_VERSION_POLICY, PI_VERSION_POLICY.qualifiedVersion, '9.9.9', 'allow'],
  ] as const)('%s: qualified allow, unqualified %s', (_id, value, qualified, other, unqualified) => {
    expect(runtimeVersionVerdict(value, qualified)).toMatchObject({ state: 'allow' });
    const fields = runtimeVersionDetectionFields(value, other);
    expect(fields.versionVerdict).toMatchObject({ state: unqualified });
    // A warning verdict and the legacy advisory are one fact, never two.
    if (unqualified === 'warn') {
      expect(fields.advisory).toEqual({ reason: 'runtime_version_unqualified', qualifiedVersion: value.qualifiedVersion });
    } else {
      expect(fields).not.toHaveProperty('advisory');
    }
  });
});
