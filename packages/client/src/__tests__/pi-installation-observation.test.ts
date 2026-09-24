import { locateOfficialPiPackage } from '../adapters/pi/official-pi-installation.mjs';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeRecordFixture } from './fixtures/runtime-resolution';
import type { ToolImplementationInstallRecordV1, ToolImplementationAuthority } from '@byok-sdk/implementation-identity';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolveInstalledPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { RUNTIME_LAUNCH_KINDS } from '../daemon/tool-implementation-identity';
import type { RuntimeInstallationObservationContext } from '../types';

const roots: string[] = [];
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(form: 'compiled-executable' | 'interpreter+bundle' = 'interpreter+bundle', ownershipSeam = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-observation-'))); roots.push(root);
  const artifact = path.join(root, 'entry'); const interpreter = path.join(root, 'interpreter');
  await fs.writeFile(artifact, 'synthetic artifact', { mode: 0o555 }); await fs.writeFile(interpreter, 'synthetic interpreter', { mode: 0o555 });
  const native = resolveInstalledPiRuntimeIdentity();
  const manifest = await fs.readFile(path.join(locateOfficialPiPackage(native.packageName, process.cwd()), 'package.json'), 'utf8');
  const manifestPath = path.join(root, 'package.json'); await fs.writeFile(manifestPath, manifest, { mode: 0o444 });
  const record: ToolImplementationInstallRecordV1 = { kind: 'attested', authority: 'host-install-record', manifestRevision: 'synthetic-observation',
    form, installPath: artifact, closureKind: 'artifact', closureDigest: sha('synthetic artifact'), launchCwd: await fs.realpath(path.parse(root).root),
    launchArgv: ['__byok_sdk_helper', 'pi-rpc'], assetRoot: root, assets: [{ path: 'package.json', digest: sha(manifest) }],
    ...(form === 'interpreter+bundle' ? { interpreter: { path: interpreter, digest: sha('synthetic interpreter'), loadCommandsDigest: '0'.repeat(64) } } : {}),
    nativeProvenance: { packageName: native.packageName, packageVersion: native.packageVersion, tarballIntegrity: native.tarballIntegrity,
      upstreamCommit: native.upstreamCommit, provenanceDigest: native.provenanceDigest, closureDigest: native.closureDigest, compilerVersion: native.compilerVersion } };
  if (ownershipSeam) {
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args); return String(args[0]).startsWith(root + path.sep) ? Object.assign(stat, { uid: 0 }) : stat;
    }) as typeof fs.lstat);
  }
  const resolve = vi.fn<ToolImplementationAuthority['resolve']>(async locator => {
    if (!('runtimeEntry' in locator)) throw new Error('wrong subject');
    return runtimeRecordFixture({ ...record, launchArgv: ['__byok_sdk_helper', locator.runtimeEntry] });
  });
  const authority = { resolve };
  const resolveBin = vi.fn(() => { throw new Error('dev discovery forbidden'); });
  const spawnFn = vi.fn();
  const adapter = new PiAdapter({ resolveBin, spawnFn });
  const context: RuntimeInstallationObservationContext = { authority, scope: 'enabled-top-level' };
  return { root, artifact, interpreter, manifestPath, record, native, authority, resolve, resolveBin, spawnFn, adapter, context };
}
it.each(['compiled-executable', 'interpreter+bundle'] as const)('measures %s exact top-level set without execution/auth/env discovery', async form => {
  const f = await fixture(form); const open = vi.spyOn(fs, 'open');
  vi.stubEnv('PI_PACKAGE_DIR', '/poison'); vi.stubEnv('BYOK_PI_BIN', '/poison'); vi.stubEnv('NODE_OPTIONS', 'PRIVATE_SENTINEL');
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'available', version: f.native.packageVersion });
  expect(f.resolve.mock.calls.map(([loc]) => 'runtimeEntry' in loc ? loc.runtimeEntry : '')).toEqual(RUNTIME_LAUNCH_KINDS);
  expect(f.resolveBin).not.toHaveBeenCalled(); expect(f.spawnFn).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it.each(['pi-rpc', 'pi-prepared'] as const)('refuses incomplete installation missing %s without substitution', async missing => {
  const f = await fixture(); f.resolve.mockImplementation(async locator => 'runtimeEntry' in locator && locator.runtimeEntry === missing
    ? { kind: 'unavailable', reason: 'implementation_identity_unattested' }
    : runtimeRecordFixture({ ...f.record, launchArgv: ['__byok_sdk_helper', 'pi-rpc'] }));
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'refused', reason: 'implementation_identity_unattested' });
  expect(f.resolve).toHaveBeenCalledTimes(missing === 'pi-rpc' ? 1 : 2);
});
it('uses first finite refusal unchanged when both entries would fail', async () => {
  const f = await fixture(); f.resolve.mockImplementation(async locator => ({ kind: 'unavailable',
    reason: 'runtimeEntry' in locator && locator.runtimeEntry === 'pi-rpc' ? 'unencapsulated_source' : 'install_record_mismatch' }));
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'refused', reason: 'unencapsulated_source' });
  expect(f.resolve).toHaveBeenCalledTimes(1);
});
it('rejects different immutable policies despite matching physical files', async () => {
  const f = await fixture();
  f.resolve.mockImplementation(async locator => {
    if (!('runtimeEntry' in locator)) throw new Error('subject');
    const value = runtimeRecordFixture({ ...f.record, launchArgv: ['__byok_sdk_helper', locator.runtimeEntry] });
    return locator.runtimeEntry === 'pi-prepared' ? { ...value, descendantPolicy: { ...value.descendantPolicy, fanout: value.descendantPolicy.fanout + 1 } } : value;
  });
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'refused', reason: 'install_record_mismatch' });
});
it.each(['instruction', 'prepared'] as const)('does not lend successful observation to later %s admission after bytes change', async kind => {
  const f = await fixture();
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'available', version: f.native.packageVersion });
  await fs.chmod(f.artifact, 0o755); await fs.writeFile(f.artifact, 'replacement bytes'); await fs.chmod(f.artifact, 0o555);
  const policy = { mode: 'auto' as const };
  const prepared = await f.adapter.prepare({ offer: { instruction: 'never starts', policy }, policy, descriptor: f.adapter.descriptor, requiredToolsetIds: [] });
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  await expect(prepared.operation.resolveRuntimeLaunch!({ kind, cwd: f.root, env: {}, projectionRoot: path.join(f.root, 'unused'), authority: f.authority }))
    .rejects.toThrow('runtime implementation unavailable: install_record_mismatch');
  expect(f.resolveBin).not.toHaveBeenCalled(); expect(f.spawnFn).not.toHaveBeenCalled();
});
it('accepts explicit prepared scope without reading another entry', async () => {
  const f = await fixture();
  expect(await f.adapter.detectInstallation({ authority: f.authority, scope: 'entry', runtimeEntry: 'pi-prepared' })).toEqual({ kind: 'available', version: f.native.packageVersion });
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'pi-prepared' });
});
it.each(['pi-subagent-runner', 'pi-subagent-print', 'other'])('does not enable %s or resolve a replacement', async kind => {
  const f = await fixture();
  expect(await f.adapter.detectInstallation({ authority: f.authority, scope: 'entry', runtimeEntry: kind } as RuntimeInstallationObservationContext))
    .toEqual({ kind: 'refused', reason: 'installation_observation_unsupported' });
  expect(f.resolve).not.toHaveBeenCalled();
});
it('does not treat matching synthetic bytes as real owner evidence without the uid seam', async () => {
  const f = await fixture('compiled-executable', false);
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'refused', reason: 'install_record_mismatch' });
});
it.each(['installPath', 'prefix', 'manifestRevision', 'compilerVersion', 'upstreamCommit', 'cwd'] as const)('refuses changed %s with no dev fallback', async field => {
  const f = await fixture(); f.resolve.mockImplementation(async locator => {
    if (!('runtimeEntry' in locator)) throw new Error('subject');
    let record = { ...f.record, launchArgv: ['__byok_sdk_helper', locator.runtimeEntry] };
    if (field === 'installPath') record.installPath += '-missing';
    if (field === 'prefix') record.launchArgv = ['other'];
    if (field === 'manifestRevision' && locator.runtimeEntry === 'pi-prepared') record.manifestRevision += '-other';
    if (field === 'compilerVersion') record.nativeProvenance = { ...record.nativeProvenance!, compilerVersion: 999 };
    if (field === 'upstreamCommit') record.nativeProvenance = { ...record.nativeProvenance!, upstreamCommit: 'e'.repeat(40) };
    if (field === 'cwd') record.launchCwd = f.root; // real current-uid directory is observed unsafe, no wx needed
    return runtimeRecordFixture(record);
  });
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'refused', reason:
    field === 'cwd' ? 'launch_cwd_unavailable' : field === 'compilerVersion' || field === 'upstreamCommit' ? 'native_identity_mismatch' : 'install_record_mismatch' });
  expect(f.resolveBin).not.toHaveBeenCalled();
});
it('closes the physical read window after the second entry, without caching for prepare', async () => {
  const f = await fixture();
  f.resolve.mockImplementation(async locator => {
    if (!('runtimeEntry' in locator)) throw new Error('subject');
    if (locator.runtimeEntry === 'pi-prepared') {
      await fs.chmod(f.artifact, 0o755); await fs.writeFile(f.artifact, 'changed artifact'); await fs.chmod(f.artifact, 0o555);
    }
    return runtimeRecordFixture({ ...f.record, launchArgv: ['__byok_sdk_helper', locator.runtimeEntry] });
  });
  expect(await f.adapter.detectInstallation(f.context)).toEqual({ kind: 'refused', reason: 'install_record_mismatch' });
});
