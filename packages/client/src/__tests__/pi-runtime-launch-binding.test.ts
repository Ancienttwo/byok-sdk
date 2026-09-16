import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertImplementationSpawnBinding,
  type ToolImplementationInstallRecordV1,
  type ToolImplementationAuthority,
} from '@byok-sdk/implementation-identity';
import { resolvePiRuntimeLaunch } from '../adapters/pi/runtime-launch';
import { resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';
import { resolveTrustedLaunchCwd } from '../daemon/trusted-launch-cwd';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root,{recursive:true,force:true}))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-runtime-binding-')));
  roots.push(root);
  const sessionCwd = path.join(root,'session with spaces');
  await fs.mkdir(sessionCwd,{mode:0o700});
  return {
    root,
    options: {
      kind:'pi-rpc' as const, sessionCwd, projectionRoot:path.join(root,'private-projections'),
      keysSessionDir:path.join(root,'native-sessions'), devCommand:process.execPath, devEntry:path.join(root,'sdk entry.js'),
      env:{PATH:process.env.PATH!, HOME:sessionCwd, PI_PACKAGE_DIR:'/ambient-assets', BYOK_PI_PERMISSION_MODE:'invalid', OPENAI_API_KEY:'ambient-secret'},
    },
  };
}
function spawnInput(resources: Awaited<ReturnType<typeof resolvePiRuntimeLaunch>>) {
  const {binding,env} = resources;
  return {command:binding.command,entry:binding.entry,fixedArgv:binding.fixedArgv,cwd:binding.cwd,env};
}

describe('client runtime launch admission and resource binding', () => {
  it.each(['pi-rpc','pi-prepared'] as const)('passes only the runtime subject and %s entry to a configured resolver and refuses its denial', async (kind) => {
    const f = await fixture();
    const resolve = vi.fn(async () => ({kind:'unavailable' as const,reason:'implementation_identity_unattested' as const}));
    await expect(resolvePiRuntimeLaunch({...f.options,kind,authority:{resolve}})).rejects.toThrow(/runtime implementation unavailable/);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({subject:{kind:'runtime',runtimeId:'pi'},runtimeEntry:kind});
    expect(await fs.readdir(f.options.projectionRoot)).toEqual([]);
  });

  it('refuses a configured resolver claiming resolver_unconfigured instead of taking the dev path', async () => {
    const f = await fixture();
    const authority: ToolImplementationAuthority = {resolve:async () => ({kind:'unavailable',reason:'resolver_unconfigured'})};
    let result: Awaited<ReturnType<typeof resolvePiRuntimeLaunch>> | undefined;
    try {
      await expect(resolvePiRuntimeLaunch({...f.options,authority}).then((value) => {result=value;return value;}))
        .rejects.toThrow(/configured runtime authority returned resolver_unconfigured/);
    } finally { await result?.release(); }
  });

  it('declines a throwing resolver and cleans its preallocated projection without guessing a command', async () => {
    const f = await fixture();
    const resolve = vi.fn(async () => {throw new Error('authority offline');});
    await expect(resolvePiRuntimeLaunch({...f.options,authority:{resolve}})).rejects.toThrow(/runtime implementation unavailable/);
    expect(resolve.mock.calls).toEqual([[{subject:{kind:'runtime',runtimeId:'pi'},runtimeEntry:'pi-rpc'}]]);
    expect(await fs.readdir(f.options.projectionRoot)).toEqual([]);
  });

  it('uses explicit resolver-unconfigured dev launch with a sealed process cwd and a private client-owned projection', async () => {
    const f = await fixture();
    const resources = await resolvePiRuntimeLaunch(f.options);
    try {
      expect(resources.decision.kind).toBe('unconfigured');
      expect(resources.binding.identity).toEqual({kind:'unavailable',reason:'resolver_unconfigured'});
      const trusted = await resolveTrustedLaunchCwd();
      expect(trusted.kind).toBe('resolved');
      if (trusted.kind !== 'resolved') throw new Error(trusted.reason);
      expect(resources.binding.cwd).toBe(trusted.dir);
      expect(resources.binding.cwd).not.toBe(f.options.sessionCwd);
      expect(resources.sessionCwd).toBe(f.options.sessionCwd);
      expect(resources.binding.command).toBe(f.options.devCommand);
      expect(resources.binding.entry).toBe(f.options.devEntry);
      expect(resources.credentialSource).toBe('keys-profile');
      const projection = resources.env.PI_CODING_AGENT_DIR!;
      const stat = await fs.lstat(projection);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(await fs.realpath(projection)).toBe(projection);
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o700);
        expect(stat.uid).toBe(process.getuid!());
      }
      expect(await fs.readdir(projection)).toEqual([]);
      expect(path.dirname(projection)).toBe(f.options.projectionRoot);
      expect(resources.env.BYOK_PI_PERMISSION_MODE).toBeUndefined();
      expect(resources.env.OPENAI_API_KEY).toBeUndefined();
      expect(resources.env.PI_PACKAGE_DIR).toBeUndefined();
      expect(resources.binding.envCommitments).toEqual({PI_CODING_AGENT_DIR:projection,PI_CODING_AGENT_SESSION_DIR:f.options.keysSessionDir});
      await expect(assertImplementationSpawnBinding(resources.binding,spawnInput(resources))).resolves.toBeUndefined();
      await expect(assertImplementationSpawnBinding(resources.binding,{...spawnInput(resources),env:{...resources.env,PI_CODING_AGENT_DIR:'/changed'}})).rejects.toThrow(/changed Pi directory/);
      await resources.release(); await resources.release();
      await expect(fs.lstat(projection)).rejects.toMatchObject({code:'ENOENT'});
      expect(await fs.readdir(f.options.projectionRoot)).toEqual([]);
    } finally {await resources.release();}
  });

  it('rejects projection roots inside the session, including a symlinked ancestor', async () => {
    const f = await fixture();
    await expect(resolvePiRuntimeLaunch({...f.options,projectionRoot:path.join(f.options.sessionCwd,'projection')})).rejects.toThrow(/inside session cwd/);
    const alias = path.join(f.root,'alias'); await fs.symlink(f.options.sessionCwd,alias);
    await expect(resolvePiRuntimeLaunch({...f.options,projectionRoot:path.join(alias,'projection')})).rejects.toThrow(/resolves inside session cwd/);
  });

  it.skipIf(process.platform === 'win32')('derives expected controlled env from a measured install record before the final assertion', async () => {
    const f = await fixture();
    // Only uid is simulated: this unprivileged test cannot create root-owned
    // files. The shared authority still reads real bytes, mode and stat tuples
    // both at admission and at the final boundary. No process is launched.
    const executable = path.join(f.root, 'measured-artifact');
    await fs.writeFile(executable, 'measurement fixture bytes', {mode:0o444});
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      return args[0] === executable ? Object.assign(stat, {uid:0}) : stat;
    }) as typeof fs.lstat);
    const digest = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
    const pin = resolvePiRuntimeIdentity();
    const trusted = await resolveTrustedLaunchCwd();
    if (trusted.kind !== 'resolved') throw new Error(trusted.reason);
    const record: ToolImplementationInstallRecordV1 = {
      kind:'attested',authority:'host-install-record',manifestRevision:'binding-test',form:'compiled-executable',
      installPath:executable,closureDigest:digest,closureKind:'artifact',launchArgv:['__byok_sdk_helper','pi-rpc'],launchCwd:trusted.dir,
      assetRoot:path.dirname(executable),assets:[{path:path.basename(executable),digest}],
      nativeProvenance:{packageName:pin.name,packageVersion:pin.version,upstreamBase:'0.85.0',upstreamCommit:'c'.repeat(40),forkBuild:1005,compilerVersion:1},
    };
    const authority: ToolImplementationAuthority = {resolve:async () => record};
    const resources = await resolvePiRuntimeLaunch({...f.options,authority});
    try {
      expect(resources.decision.kind).toBe('attested');
      expect(resources.binding.envCommitments.PI_PACKAGE_DIR).toBe(record.assetRoot);
      expect(resources.env.PI_PACKAGE_DIR).toBe(record.assetRoot);
      expect(resources.binding.command).toBe(executable);
      expect(resources.binding.command).not.toBe(f.options.devCommand);
      await expect(assertImplementationSpawnBinding(resources.binding,spawnInput(resources))).resolves.toBeUndefined();
      await expect(assertImplementationSpawnBinding(resources.binding,{...spawnInput(resources),env:{...resources.env,PI_PACKAGE_DIR:'/changed-after-description'}})).rejects.toThrow(/changed Pi directory/);
    } finally {await resources.release();}
  });
});
