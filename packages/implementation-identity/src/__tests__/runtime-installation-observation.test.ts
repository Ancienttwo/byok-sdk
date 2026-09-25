import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  measureRuntimeInstallation, reverifyRuntimeInstallation, resolveRuntimeImplementation,
  parseToolImplementationIdentity, type RuntimeImplementationLocatorV1,
  type ToolImplementationFsProbe, type ToolImplementationIdentityV1,
  type RuntimeInstallationMeasurementV1,
} from '../identity';
import { parseImplementationSpawnBinding } from '../spawn-binding';
const data = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../tests/fixtures/c07-runtime-record/official-pi-087.v1.json'), 'utf8'));
const vector = data.resolutionVectors[0];
function fixture() {
  const response = structuredClone(vector.response);
  const record = response.record;
  const hashes = new Map<string, string>([[record.installPath, record.closureDigest]]);
  if (record.interpreter) hashes.set(record.interpreter.path, record.interpreter.digest);
  for (const asset of record.assets ?? []) hashes.set(path.join(record.assetRoot, asset.path), asset.digest);
  const trace: string[] = [];
  const probe: ToolImplementationFsProbe = {
    realpath: async p => p,
    lstat: async p => { trace.push(`stat:${p}`); return { uid: 0, gid: 0, mode: 0o100555, size: 11, dev: 1, ino: 2, mtimeMs: 1000, isFile: true, isSymbolicLink: false }; },
    digest: async p => { trace.push(`hash:${p}`); const digest = hashes.get(p); if (!digest) throw new Error('missing'); return digest; },
  };
  return { response, record, hashes, trace, probe, authority: { resolve: vi.fn(async () => response) } };
}
it('separates physical facts structurally, without a synthetic launch env', async () => {
  const f = fixture();
  const result = await measureRuntimeInstallation(f.authority, vector.request, f.probe);
  expect(result.kind).toBe('measured-installation');
  if (result.kind !== 'measured-installation') throw new Error('fixture');
  expect(result).not.toHaveProperty('launchEnvNamesDigest');
  expect(result).not.toHaveProperty('loaderEnvValuesDigest');
  expect(parseToolImplementationIdentity(result)).toBeUndefined();
  expect(parseToolImplementationIdentity(result.record)).toBeUndefined();
  expect(parseImplementationSpawnBinding({ format: 'byok.implementation-spawn', version: 1, identity: result,
    command: f.record.interpreter?.path ?? f.record.installPath, entry: f.record.installPath,
    fixedArgv: f.record.launchArgv, cwd: f.record.launchCwd, envCommitments: {} })).toBeUndefined();
  // Type-level negative is compiled by the package typecheck, not only run by Vitest.
  const measured: RuntimeInstallationMeasurementV1 = result;
  // @ts-expect-error measured-installation has neither the attested discriminant nor environment measurements.
  const notALaunchIdentity: ToolImplementationIdentityV1 = measured;
  void notALaunchIdentity;
  expect(await reverifyRuntimeInstallation(result, f.probe)).toBe('ok');
  f.hashes.set(f.record.installPath, 'f'.repeat(64));
  expect(await reverifyRuntimeInstallation(result, f.probe)).toEqual({ reason: 'reverify_failed', subject: 'artifact' });
});
it('preserves old assets -> env callback -> interpreter order and physical facts', async () => {
  const f = fixture();
  const old = await resolveRuntimeImplementation(f.authority, vector.request, () => { f.trace.push('env'); return { HOME: '/fixture' }; }, f.probe);
  const envIndex = f.trace.indexOf('env');
  expect(envIndex).toBeGreaterThan(0);
  for (const asset of f.record.assets ?? []) expect(f.trace.indexOf(`hash:${path.join(f.record.assetRoot, asset.path)}`)).toBeLessThan(envIndex);
  if (f.record.interpreter) expect(f.trace.indexOf(`stat:${f.record.interpreter.path}`)).toBeGreaterThan(envIndex);
  const observed = await measureRuntimeInstallation(f.authority, vector.request, f.probe);
  if (old.kind !== 'attested' || observed.kind !== 'measured-installation') throw new Error('fixture');
  const { launchEnvNamesDigest: _names, loaderEnvValuesDigest: _values, installStat, interpreterStat, assetStats, ...record } = old.identity;
  expect(observed).toEqual({ kind: 'measured-installation', record, installStat, ...(interpreterStat ? { interpreterStat } : {}),
    ...(assetStats ? { assetStats } : {}), descendantPolicy: old.descendantPolicy, edges: old.edges });
});
it.each(['artifact', 'interpreter', 'asset'] as const)('remeasures %s and preserves exact physical refusal', async subject => {
  const f = fixture();
  const result = await measureRuntimeInstallation(f.authority, vector.request, f.probe);
  if (result.kind !== 'measured-installation') throw new Error('fixture');
  const target = subject === 'artifact' ? f.record.installPath : subject === 'interpreter' ? f.record.interpreter.path : path.join(f.record.assetRoot, f.record.assets[0].path);
  f.hashes.set(target, 'f'.repeat(64));
  expect(await reverifyRuntimeInstallation(result, f.probe)).toEqual({ reason: 'reverify_failed', subject });
  expect(await measureRuntimeInstallation(f.authority, vector.request, f.probe)).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
});
it('rejects bare records and wrong fixed prefixes without file measurement', async () => {
  const f = fixture(); const stat = vi.spyOn(f.probe, 'lstat');
  expect(await measureRuntimeInstallation({ resolve: async () => f.record }, vector.request, f.probe)).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  const other: RuntimeImplementationLocatorV1 = { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'pi-rpc' };
  expect(await measureRuntimeInstallation(f.authority, other, f.probe)).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  expect(stat).not.toHaveBeenCalled();
});
