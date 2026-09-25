import { OFFICIAL_PI_PROVENANCE } from '../adapters/pi/official-pi-installation.mjs';
import { runtimeRecordFixture } from './fixtures/runtime-resolution';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as native from '../adapters/pi/input-preparation';
import * as identity from '../daemon/tool-implementation-identity';
import { resolvePiInputPreparationCompiler } from '../adapters/pi/input-preparation-runtime';
import { resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';

const pin = resolvePiRuntimeIdentity();
const env = Object.freeze({ PATH: '/bin' });
afterEach(() => vi.restoreAllMocks());

describe('preparation compiler authority selection', () => {
  it('uses installed discovery once only for an unconfigured authority', async () => {
    const dev = vi.spyOn(native, 'resolveInstalledPiRuntimeIdentity');
    const measured = vi.spyOn(identity, 'resolveRuntimeImplementation');
    const compiler = await resolvePiInputPreparationCompiler({ env, sessionCwd: '/workspace/session' });
    expect(dev).toHaveBeenCalledTimes(1);
    expect(measured).not.toHaveBeenCalled();
    expect(compiler.runtime.packageVersion).toBe(pin.version);
  });

  it.each(['resolver_unconfigured', 'implementation_identity_unattested', 'unencapsulated_source'] as const)(
    'configured refusal %s invokes no dev discovery', async reason => {
      const dev = vi.spyOn(native, 'resolveInstalledPiRuntimeIdentity');
      const resolve = vi.fn(async () => ({ kind: 'unavailable', reason }) as const);
      await expect(resolvePiInputPreparationCompiler({ authority: { resolve }, env, sessionCwd: '/workspace/session' }))
        .rejects.toThrow(reason);
      expect(dev).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledExactlyOnceWith({ subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'pi-prepared' });
    });

  it('measures real fixture bytes with the existing ownership seam, never invoking dev discovery', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'byok-prep-runtime-')));
    const installPath = path.join(root, 'app.js');
    const bytes = 'fixture artifact, not executable';
    const data = '{}';
    await writeFile(installPath, bytes, { mode: 0o644 });
    await writeFile(path.join(root, 'package.json'), data, { mode: 0o644 });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const resolve = vi.fn(async () => runtimeRecordFixture({
      kind: 'attested', authority: 'host-install-record', closureKind: 'artifact',
      manifestRevision: 'test-fixture', form: 'compiled-executable', installPath, closureDigest: hash(bytes),
      launchCwd: root, launchArgv: ['__byok_sdk_helper', 'pi-prepared'],
      assetRoot: root, assets: [{ path: 'package.json', digest: hash(data) }],
      nativeProvenance: { ...OFFICIAL_PI_PROVENANCE },
    }));
    const dev = vi.spyOn(native, 'resolveInstalledPiRuntimeIdentity');
    const actualResolve = identity.resolveRuntimeImplementation;
    const probe = identity.realToolImplementationFsProbe;
    // Only this test's files simulate an immutable privileged installation.
    // Path resolution and streamed hashes remain real. Not installer evidence.
    const measured = vi.spyOn(identity, 'resolveRuntimeImplementation').mockImplementation((authority, locator, environment) =>
      actualResolve(authority, locator, environment, { ...probe, lstat: async target => {
        const stat = await probe.lstat(target);
        return target.startsWith(root + path.sep) ? { ...stat, uid: 0, mode: stat.mode & ~0o222 } : stat;
      } }));
    try {
      const compiler = await resolvePiInputPreparationCompiler({ authority: { resolve }, env, sessionCwd: path.join(root, 'session') });
      expect(measured).toHaveBeenCalledTimes(1);
      expect(dev).not.toHaveBeenCalled();
      expect(compiler.runtime.packageVersion).toBe(pin.version);
      expect(compiler.runtime.upstreamCommit).toBe(OFFICIAL_PI_PROVENANCE.upstreamCommit);
      measured.mockImplementation(actualResolve); // Without seam, writable fixture must refuse.
      await expect(resolvePiInputPreparationCompiler({ authority: { resolve }, env, sessionCwd: path.join(root, 'session') }))
        .rejects.toThrow('install_record_mismatch');
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(dev).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses measured provenance and static pin without a dev lookup; pin drift still refuses', async () => {
    // Selection unit boundary only: physical measurement is separately covered by identity tests.
    const record = {
      kind: 'attested', form: 'compiled-executable', installPath: '/release/app',
      launchCwd: '/release/launch', launchArgv: ['__byok_sdk_helper', 'pi-prepared'],
      assetRoot: '/release/assets', assets: [],
      nativeProvenance: { ...OFFICIAL_PI_PROVENANCE },
    } as unknown as identity.ToolImplementationAttestedV1;
    const measured = vi.spyOn(identity, 'resolveRuntimeImplementation').mockResolvedValue({ kind: 'attested', identity: record, descendantPolicy: runtimeRecordFixture(record).descendantPolicy, edges: runtimeRecordFixture(record).edges });
    const dev = vi.spyOn(native, 'resolveInstalledPiRuntimeIdentity');
    const authority = { resolve: vi.fn() };
    const compiler = await resolvePiInputPreparationCompiler({ authority, env, sessionCwd: '/workspace/session' });
    expect(measured).toHaveBeenCalledTimes(1);
    expect(dev).not.toHaveBeenCalled();
    expect(compiler.runtime.upstreamCommit).toBe(OFFICIAL_PI_PROVENANCE.upstreamCommit);
    measured.mockResolvedValue({ kind: 'attested', identity: { ...record, nativeProvenance: { ...record.nativeProvenance!, packageVersion: '0.0.0' } }, descendantPolicy: runtimeRecordFixture(record).descendantPolicy, edges: runtimeRecordFixture(record).edges });
    await expect(resolvePiInputPreparationCompiler({ authority, env, sessionCwd: '/workspace/session' })).rejects.toThrow('install_record_mismatch');
    expect(dev).not.toHaveBeenCalled();
  });
});
