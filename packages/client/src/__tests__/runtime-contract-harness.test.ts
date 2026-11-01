import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapterDescriptor, type RuntimeCapabilities, type RuntimeDetectResult } from '../types';
import {
  CONTRACT_CASES,
  assertContractPlan,
  assertRuntimeCases,
  contractMode,
  contractTarget,
  expectDetectedVersion,
  type ContractPlan,
} from './runtime-contract/contract';

/**
 * #1103: the runtime contract suite's own admission rules, exercised without a
 * real runtime CLI. The suite's live cases need an installed CLI, but the
 * rules that decide whether a runtime may RUN AT ALL — the plan admits every
 * case, a skip names a reason, an advertised capability is never skipped, and
 * the version case rejects a broken detector parser — are pure and belong in
 * `bun run test`. Removing any of them makes a latest-CLI run report a false
 * pass.
 */

const CONTROL_KEYS = ['BYOK_RUNTIME_CONTRACT', 'BYOK_CONTRACT_CODEX_BIN', 'BYOK_CONTRACT_CODEX_VERSION'] as const;
const savedEnv = Object.fromEntries(CONTROL_KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  for (const key of CONTROL_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of CONTROL_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const skipEveryCase = (): ContractPlan => Object.fromEntries(
  Object.keys(CONTRACT_CASES).map((id) => [id, { skip: 'fixture case' }]),
) as unknown as ContractPlan;

const descriptor = (capabilities: Partial<RuntimeCapabilities> = {}): RuntimeAdapterDescriptor =>
  freezeRuntimeAdapterDescriptor({
    id: 'fixture-runtime',
    supportsDispatchSelection: false,
    capabilities: { steer: false, resume: false, approvalInteractive: false, ...capabilities },
  });

describe('runtime contract plan admission', () => {
  it('admits a complete plan whose every case is explicitly skipped with a reason', () => {
    expect(() => assertContractPlan(descriptor(), skipEveryCase())).not.toThrow();
  });

  it('refuses a plan that omits a case instead of running a smaller suite', () => {
    const plan: Record<string, unknown> = { ...skipEveryCase() };
    delete plan['detect.version'];
    expect(() => assertContractPlan(descriptor(), plan as unknown as ContractPlan)).toThrow(/missing the detect\.version case/);
  });

  it('refuses a skip with no reason', () => {
    const plan = { ...skipEveryCase(), drafts: { skip: '   ' } };
    expect(() => assertContractPlan(descriptor(), plan)).toThrow(/skip needs a reason/);
  });

  it('refuses a runtime case skipped with no reason', () => {
    expect(() => assertRuntimeCases('runtime cases', { 'x.case': ['a runtime case', { skip: '  ' }] })).toThrow(/x\.case skip needs a reason/);
  });

  it.each([
    ['mcp.submitResult', { mcpToolsets: true }],
    ['drafts', { messageDraft: true }],
    ['gate.auto', { toolAuthorizationAuto: true }],
    ['isolation.userContext', { isolation: { userContext: true, userMcpServers: false, sessionPersistence: false } }],
    ['isolation.userMcp', { isolation: { userContext: false, userMcpServers: true, sessionPersistence: false } }],
    ['isolation.sessionPersistence', { isolation: { userContext: false, userMcpServers: false, sessionPersistence: true } }],
  ] as const)('refuses to skip %s when the descriptor advertises it', (id, capabilities) => {
    const plan = { ...skipEveryCase(), [id]: { skip: 'hiding an advertised capability' } } as ContractPlan;
    expect(() => assertContractPlan(descriptor(capabilities), plan)).toThrow(/advertised by the descriptor and cannot be skipped/);
  });
});

describe('runtime contract run selection', () => {
  it('refuses to start without an explicit mode', () => {
    expect(() => contractMode()).toThrow(/BYOK_RUNTIME_CONTRACT must be qualified or latest/);
    process.env.BYOK_RUNTIME_CONTRACT = 'newest';
    expect(() => contractMode()).toThrow(/BYOK_RUNTIME_CONTRACT must be qualified or latest/);
  });

  it('reads the mode from the environment', () => {
    process.env.BYOK_RUNTIME_CONTRACT = 'latest';
    expect(contractMode()).toBe('latest');
    process.env.BYOK_RUNTIME_CONTRACT = 'qualified';
    expect(contractMode()).toBe('qualified');
  });

  it('fails a selected runtime with no executable instead of skipping it', async () => {
    process.env.BYOK_RUNTIME_CONTRACT = 'qualified';
    expect(() => contractTarget('codex', '0.160.0')).toThrow(/BYOK_CONTRACT_CODEX_BIN must name the installed codex executable/);
    process.env.BYOK_CONTRACT_CODEX_BIN = 'codex';
    expect(() => contractTarget('codex', '0.160.0')).toThrow(/BYOK_CONTRACT_CODEX_BIN must name the installed codex executable/);
    process.env.BYOK_CONTRACT_CODEX_BIN = path.join(os.tmpdir(), 'byok-contract-missing-codex');
    expect(() => contractTarget('codex', '0.160.0')).toThrow(/BYOK_CONTRACT_CODEX_BIN must name the installed codex executable/);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-contract-target-'));
    try {
      const bin = path.join(dir, 'codex');
      await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
      process.env.BYOK_CONTRACT_CODEX_BIN = bin;
      process.env.BYOK_RUNTIME_CONTRACT = 'latest';
      // A latest run must name the version it installed; the suite never
      // assumes the qualified token stands in for an untested latest one.
      expect(() => contractTarget('codex', '0.160.0')).toThrow(/BYOK_CONTRACT_CODEX_VERSION/);
      process.env.BYOK_CONTRACT_CODEX_VERSION = '0.170.0';
      expect(contractTarget('codex', '0.160.0')).toEqual({
        runtime: 'codex', mode: 'latest', qualifiedVersion: '0.160.0', expectedVersion: '0.170.0', bin,
      });
      process.env.BYOK_RUNTIME_CONTRACT = 'qualified';
      delete process.env.BYOK_CONTRACT_CODEX_VERSION;
      expect(contractTarget('codex', '0.160.0').expectedVersion).toBe('0.160.0');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime contract detect.version catches a forced detector break', () => {
  const identifies = (version: string, expected: string) => version.trim() === expected;
  const target = { expectedVersion: '0.160.0', qualifiedVersion: '0.160.0' };
  const detected = (overrides: { version?: string; state?: 'allow' | 'warn'; advisory?: boolean } = {}): RuntimeDetectResult => ({
    kind: 'available',
    version: overrides.version ?? '0.160.0',
    versionVerdict: { state: overrides.state ?? 'allow', qualifiedVersion: '0.160.0' },
    ...(overrides.advisory === true ? { advisory: { reason: 'runtime_version_unqualified' as const, qualifiedVersion: '0.160.0' } } : {}),
  });

  it('passes the qualified token with no advisory', () => {
    expect(() => expectDetectedVersion(detected(), target, identifies, true)).not.toThrow();
  });

  it('fails when a broken adapter parser returns text its own detector cannot identify', () => {
    // The file's own reading rejects the adapter's parsed value: the exact
    // failure a broken version parser produces on a latest run.
    expect(() => expectDetectedVersion(detected({ version: 'codex-cli 0.160.0' }), target, identifies, true))
      .toThrow(/detected "codex-cli 0\.160\.0", expected 0\.160\.0/);
  });

  it('fails when an unqualified version loses its advisory or its warn verdict', () => {
    process.env.BYOK_RUNTIME_CONTRACT = 'latest';
    const latestTarget = { expectedVersion: '0.161.0', qualifiedVersion: '0.160.0' };
    const latest = detected({ version: '0.161.0', state: 'warn', advisory: true });
    expect(() => expectDetectedVersion(latest, latestTarget, identifies, true)).not.toThrow();
    expect(() => expectDetectedVersion({ ...latest, advisory: undefined } as RuntimeDetectResult, latestTarget, identifies, true))
      .toThrow();
    expect(() => expectDetectedVersion(detected({ version: '0.161.0', state: 'allow', advisory: true }), latestTarget, identifies, true))
      .toThrow();
  });

  it('fails when a detector reports no version at all', () => {
    expect(() => expectDetectedVersion({ kind: 'not-found' } as RuntimeDetectResult, target, identifies, false))
      .toThrow(/detect\(\):/);
  });
});