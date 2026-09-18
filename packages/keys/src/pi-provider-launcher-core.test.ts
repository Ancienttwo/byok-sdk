import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ChildProcess } from 'node:child_process';
import * as identity from '@byok-sdk/implementation-identity';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import {
  parsePiProviderLauncherOptions,
  assertPiProjectionDirectory,
  assertWindowsPiProjectionAcl,
  startPiProvider,
  buildPiProviderChildEnvironment,
  ensurePiSessionDirectory,
  resolvePiProviderSecret,
} from './pi-provider-launcher-core';
import { parseModelProviderProfile } from './provider-profile';

const timestamps = {
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
};
const CANARY = 'sk-canary-macos-0001';

function profile(authMode: 'bearer' | 'none') {
  return parseModelProviderProfile({
    ...timestamps,
    adapter: 'openai_compatible',
    auth_mode: authMode,
    base_url: 'http://127.0.0.1:11434/v1',
    capabilities: [],
    display_name: 'Local model',
    enabled: true,
    kind: 'model',
    model: 'local-model',
    profile_ref: 'custom',
    provider_kind: 'custom',
  });
}

function binding(projectionDir = '/projection', sessionDir = '/sessions', command = '/opt/pi', entry?: string): identity.ImplementationSpawnBindingV1 {
  return {
    format: 'byok.implementation-spawn', version: 1,
    identity: { kind: 'unavailable', reason: 'resolver_unconfigured' },
    command, ...(entry === undefined ? {} : { entry }), fixedArgv: ['__byok_sdk_helper', 'pi-rpc'], cwd: '/sealed',
    envCommitments: { PI_CODING_AGENT_DIR: projectionDir, PI_CODING_AGENT_SESSION_DIR: sessionDir },
  };
}
function launchFlags(command: string, sessionDir: string, entry?: string): string[] {
  const launch = binding('/projection', sessionDir, command, entry);
  return ['--launch-binding', JSON.stringify(launch), '--pi-cwd', launch.cwd, '--pi-fixed-args', JSON.stringify(launch.fixedArgv), '--pi-config-digest', 'a'.repeat(64)];
}
afterEach(() => { vi.restoreAllMocks(); });

describe('Pi provider launcher core', () => {
  it('does not forward old SDK extension environment across custody', () => {
    const mcp = path.join(os.tmpdir(), 'task-mcp.json');
    const env = buildPiProviderChildEnvironment({
      ambient: { BYOK_PI_MCP_CONFIG_PATH: mcp, BYOK_PI_PERMISSION_MODE: 'readonly', BYOK_PI_UNTRUSTED: 'discard', ZAI_API_KEY: CANARY },
      binding: binding(), sessionDir: '/sessions', secret: undefined,
    });
    expect(env.BYOK_PI_MCP_CONFIG_PATH).toBeUndefined();
    expect(env.BYOK_PI_PERMISSION_MODE).toBeUndefined();
    expect(env.BYOK_PI_UNTRUSTED).toBeUndefined();
    expect(env.ZAI_API_KEY).toBeUndefined();
  });
  it.each([
    { BYOK_PI_MCP_CONFIG_PATH: './relative' }, { BYOK_PI_MCP_CONFIG_PATH: '/bad\npath' },
    { BYOK_PI_PERMISSION_MODE: 'auto\n' }, { BYOK_PI_PERMISSION_MODE: 'confirm' },
  ])('discards obsolete SDK extension context', (ambient) => {
    expect(buildPiProviderChildEnvironment({ ambient, binding: binding(), sessionDir: '/sessions', secret: undefined })).toEqual({PI_CODING_AGENT_DIR:'/projection', PI_CODING_AGENT_SESSION_DIR:'/sessions'});
  });
  it('parses only the closed launcher contract and requires absolute custody paths', () => {
    const profileDbPath = path.join(os.tmpdir(), 'providers.sqlite');
    const sessionDir = path.join(os.tmpdir(), 'pi-sessions');
    const macosKeychainPath = '/private/tmp/byok-login.keychain-db';
    expect(parsePiProviderLauncherOptions([
      '--pi-bin',
      '/opt/pi',
      '--profile-db',
      profileDbPath,
      '--session-dir',
      sessionDir,
      '--provider',
      'custom',
      '--model',
      'local-model',
      '--macos-keychain-path',
      macosKeychainPath,
      ...launchFlags('/opt/pi', sessionDir),
      '--',
      '--mode',
      'rpc',
    ])).toMatchObject({
      profileDbPath,
      sessionDir,
      profileRef: 'custom',
      macosKeychainPath,
    });

    expect(parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'openrouter-primary',
      '--model', 'anthropic/claude-sonnet-4',
      '--profile-revision', '1787702400000',
      '--profile-hash', `sha256:${'a'.repeat(64)}`,
      '--required-capabilities', '["image-input"]',
      '--validate-only', 'true',
    ])).toMatchObject({
      profileRef: 'openrouter-primary',
      validateOnly: true,
      expectedBinding: {
        profileRef: 'openrouter-primary',
        profileRevision: '1787702400000',
        modelId: 'anthropic/claude-sonnet-4',
        requiredCapabilities: ['image-input'],
      },
    });

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'openrouter-primary',
      '--model', 'anthropic/claude-sonnet-4',
      '--profile-revision', '1787702400001',
      '--validate-only', 'true',
    ])).toThrow(/requires revision, hash, and required capabilities together/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', '../escape',
      '--model', 'local-model',
      '--', '--mode', 'rpc',
    ])).toThrow(/not a valid @byok-sdk\/keys identifier/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', 'providers.sqlite',
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model',
      '--', '--mode', 'rpc',
    ])).toThrow(/absolute/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model\nforged-log',
      '--', '--mode', 'rpc',
    ])).toThrow(/single-line/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model',
      '--macos-keychain-path', 'login.keychain-db',
      '--', '--mode', 'rpc',
    ])).toThrow(/absolute/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model',
      '--macos-keychain-path', '/private/tmp/byok-keychain\nforged-log',
      '--', '--mode', 'rpc',
    ])).toThrow(/single-line/);
  });

  it('does not construct or require a keychain for auth-free providers', async () => {
    const createStore = vi.fn(() => new InMemorySecretStore());
    await expect(resolvePiProviderSecret(profile('none'), createStore)).resolves.toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('reads the exact provider secret and fails closed when it is absent', async () => {
    const store = new InMemorySecretStore();
    await store.set(modelProviderSecretName('custom'), CANARY);
    await expect(resolvePiProviderSecret(profile('bearer'), () => store)).resolves.toBe(CANARY);

    await expect(
      resolvePiProviderSecret(profile('bearer'), () => new InMemorySecretStore()),
    ).rejects.toMatchObject({ code: 'PROVIDER_SECRET_MISSING' });
  });

  it('builds the Pi child environment from a closed baseline plus only the resolved key', () => {
    expect(buildPiProviderChildEnvironment({
      ambient: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy.example',
        OPENAI_API_KEY: 'ambient-provider-key',
        AWS_SECRET_ACCESS_KEY: 'ambient-cloud-key',
        GITHUB_TOKEN: 'ambient-other-secret',
        PI_PROVIDER_API_KEY: 'ambient-projection-key',
      },
      binding: binding('/private/projection', '/private/sessions'),
      sessionDir: '/private/sessions',
      secret: 'exact-custody-key',
      platform: 'darwin',
    })).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.example',
      PI_CODING_AGENT_DIR: '/private/projection',
      PI_CODING_AGENT_SESSION_DIR: '/private/sessions',
      PI_PROVIDER_API_KEY: 'exact-custody-key',
    });
  });

  it('secures a newly created session directory without chmodding an existing host directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-session-dir-'));
    try {
      const existing = path.join(root, 'existing');
      await fs.mkdir(existing, { mode: 0o700 });
      await ensurePiSessionDirectory(existing);
      if (process.platform !== 'win32') {
        expect((await fs.stat(existing)).mode & 0o777).toBe(0o700);
        const unsafeExisting = path.join(root, 'unsafe-existing');
        await fs.mkdir(unsafeExisting, { mode: 0o755 });
        await fs.chmod(unsafeExisting, 0o755);
        await expect(ensurePiSessionDirectory(unsafeExisting)).rejects.toThrow(/owner-only/);
        expect((await fs.stat(unsafeExisting)).mode & 0o777).toBe(0o755);
      }

      const created = path.join(root, 'new', 'sessions');
      await ensurePiSessionDirectory(created);
      if (process.platform !== 'win32') {
        expect((await fs.stat(created)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

 describe('explicit interpreter entry', () => {
  const args = ['--pi-bin', process.execPath, '--profile-db', path.join(os.tmpdir(), 'profiles.db'),
    '--session-dir', path.join(os.tmpdir(), 'sessions'), '--provider', 'custom', '--model', 'local-model'];
  it('preserves a spaced script path as one argument and leaves executable mode explicit', () => {
    const piEntry = path.join(os.tmpdir(), 'Pi package with spaces', 'cli.js');
    expect(parsePiProviderLauncherOptions([...args, '--pi-entry', piEntry, ...launchFlags(process.execPath, path.join(os.tmpdir(), 'sessions'), piEntry), '--', '--mode', 'rpc']).piEntry).toBe(piEntry);
    expect(parsePiProviderLauncherOptions([...args, ...launchFlags(process.execPath, path.join(os.tmpdir(), 'sessions')), '--', '--mode', 'rpc']).piEntry).toBeUndefined();
  });
  it.each(['relative.js', '', '/tmp/bad\nentry.js', '/tmp/bad\u0000entry.js'])('rejects invalid entry %j', entry => {
    expect(() => parsePiProviderLauncherOptions([...args, '--pi-entry', entry, '--', '--mode', 'rpc'])).toThrow();
  });
 });

describe('committed Pi spawn boundary', () => {
  async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keys-pi-binding-')));
    const projection = path.join(root, 'projection');
    const sessions = path.join(root, 'sessions');
    await fs.mkdir(projection, { mode: 0o700 });
    const launch = binding(projection, sessions, process.execPath, path.join(root, 'entry with spaces.js'));
    const options = parsePiProviderLauncherOptions([
      '--pi-bin', launch.command, '--pi-entry', launch.entry!, '--profile-db', path.join(root, 'db'),
      '--session-dir', sessions, '--provider', 'custom', '--model', 'local-model',
      '--launch-binding', JSON.stringify(launch), '--pi-cwd', launch.cwd, '--pi-fixed-args', JSON.stringify(launch.fixedArgv), '--pi-config-digest', 'a'.repeat(64),
      '--', '--config', path.join(root, 'task config.json'), '--mode', 'rpc', '--no-skills',
    ]);
    const provider = parseModelProviderProfile({ ...profile('bearer'), pi_model: PI_MODEL_FIXTURE });
    const store = new InMemorySecretStore();
    await store.set(modelProviderSecretName('custom'), CANARY);
    return { root, projection, sessions, launch, options, provider, store };
  }

  it('requires one launcher-owned digest and refuses delegated overrides', async () => {
    const f = await fixture();
    try {
      const base = ['--pi-bin',f.launch.command,'--pi-entry',f.launch.entry!,'--profile-db',path.join(f.root,'db'),
        '--session-dir',f.sessions,'--provider','custom','--model','local-model',...launchFlags(f.launch.command,f.sessions,f.launch.entry)];
      const withoutDigest = base.slice(0,-2);
      for (const own of [withoutDigest,[...withoutDigest,'--pi-config-digest','invalid'],[...base,'--pi-config-digest','a'.repeat(64)]]) {
        expect(()=>parsePiProviderLauncherOptions([...own,'--','--mode','rpc'])).toThrow(/pi-config-digest/);
      }
      expect(()=>parsePiProviderLauncherOptions([...base,'--',`--config-digest=${'b'.repeat(64)}`,'--mode','rpc'])).toThrow(/override/);
    } finally {await fs.rm(f.root,{recursive:true,force:true});}
  });

  it('programmatic custody entry rejects a delegated config digest before opening credentials', async () => {
    const f = await fixture();
    const createSecretStore = vi.fn(()=>f.store);
    const spawn = vi.fn(()=>new ChildProcess());
    try {
      await expect(startPiProvider(f.provider,{...f.options,piArgs:[...f.options.piArgs,`--config-digest=${'b'.repeat(64)}`]},
        {ambient:{},createSecretStore,spawn})).rejects.toThrow(/argument|config-digest/);
      expect(createSecretStore).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally {await fs.rm(f.root,{recursive:true,force:true});}
  });

  it('requires explicit binding for actual launch, while validate-only stays credential-blind', () => {
    const base = ['--pi-bin', '/opt/pi', '--profile-db', '/db', '--session-dir', '/sessions', '--provider', 'custom', '--model', 'local-model'];
    expect(() => parsePiProviderLauncherOptions([...base, '--', '--mode', 'rpc'])).toThrow(/launch-binding/);
    expect(parsePiProviderLauncherOptions([...base, '--validate-only', 'true']).launchBinding).toBeUndefined();
    const good = launchFlags('/opt/pi', '/sessions');
    for (const [flag, replacement] of [['--pi-cwd', '/other'], ['--pi-fixed-args', '["spoof"]'], ['--launch-binding', JSON.stringify({...binding(), identity:{kind:'unavailable',reason:'record_missing'}})]]) {
      const bad = [...good]; bad[bad.indexOf(flag!) + 1] = replacement!;
      expect(() => parsePiProviderLauncherOptions([...base, ...bad, '--', '--mode', 'rpc'])).toThrow();
    }
  });

  it('refuses undeclared or changed controlled directories and ignores ambient ones', async () => {
    const launch = binding();
    const env = buildPiProviderChildEnvironment({ ambient:{PI_PACKAGE_DIR:'/ambient', PI_CODING_AGENT_DIR:'/ambient'}, binding:launch, sessionDir:'/sessions', secret:undefined });
    expect(env.PI_PACKAGE_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBe('/projection');
    const actual = {command:launch.command, entry:launch.entry, fixedArgv:launch.fixedArgv, cwd:launch.cwd};
    await expect(identity.assertImplementationSpawnBinding(launch, {...actual, env:{...env, PI_PACKAGE_DIR:'/undeclared'}})).rejects.toThrow(/undeclared or changed/);
    await expect(identity.assertImplementationSpawnBinding(launch, {...actual, env:{...env, PI_CODING_AGENT_DIR:'/changed'}})).rejects.toThrow(/undeclared or changed/);
    expect(() => buildPiProviderChildEnvironment({ambient:{}, binding:launch, sessionDir:'/other', secret:undefined})).toThrow(/directories/);
  });

  it.each(['mode', 'nonempty', 'symlink', 'parent-symlink', 'owner', 'file'] as const)(
    'refuses invalid projection %s before credential access and leaves client files intact', async (kind) => {
      const f = await fixture();
      try {
        if (kind === 'mode') await fs.chmod(f.projection, 0o755);
        if (kind === 'nonempty') await fs.writeFile(path.join(f.projection, 'owned-by-client'), 'preserve');
        if (kind === 'file') { await fs.rmdir(f.projection); await fs.writeFile(f.projection, 'preserve'); }
        if (kind === 'symlink') {
          await fs.rmdir(f.projection); await fs.mkdir(path.join(f.root, 'other'), {mode:0o700});
          await fs.symlink(path.join(f.root, 'other'), f.projection);
        }
        if (kind === 'parent-symlink') {
          const alias = path.join(f.root, 'alias'); await fs.symlink(f.root, alias);
          f.options.launchBinding = {...f.options.launchBinding!, envCommitments:{...f.launch.envCommitments, PI_CODING_AGENT_DIR:path.join(alias,'projection')}};
        }
        if (kind === 'owner') {
          const stat = await fs.lstat(f.projection);
          const original = fs.lstat.bind(fs);
          vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
            if (args[0] === f.projection) return Object.assign(stat, {uid:stat.uid + 1});
            return original(...args);
          }) as typeof fs.lstat);
        }
        const openStore = vi.fn(() => f.store);
        const spawn = vi.fn(() => new ChildProcess());
        await expect(startPiProvider(f.provider, f.options, {ambient:{}, createSecretStore:openStore, spawn})).rejects.toThrow();
        expect(openStore).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
        if (kind === 'nonempty') expect(await fs.readFile(path.join(f.projection, 'owned-by-client'), 'utf8')).toBe('preserve');
      } finally { vi.restoreAllMocks(); await fs.rm(f.root, {recursive:true, force:true}); }
    },
  );

  it('rejects an exact-path mismatch', async () => {
    await expect(assertPiProjectionDirectory('/projection', '/other')).rejects.toThrow(/committed path/);
  });

  it('injects exactly one secret after layout checks, rechecks final env, and spawns the checked argv/cwd', async () => {
    const f = await fixture();
    try {
      const order: string[] = [];
      const read = f.store.get.bind(f.store);
      vi.spyOn(f.store, 'get').mockImplementation(async (name) => { order.push('secret'); return read(name); });
      const gate = identity.assertImplementationSpawnBinding;
      const snapshots: Record<string,string>[] = [];
      vi.spyOn(identity, 'assertImplementationSpawnBinding').mockImplementation(async (binding, actual) => {
        order.push('gate'); snapshots.push({...actual.env}); await gate(binding, actual);
      });
      const spawn = vi.fn(() => {order.push('spawn'); return new ChildProcess();});
      const launched = await startPiProvider(f.provider, f.options, {ambient:{PATH:'/usr/bin', OPENAI_API_KEY:'ambient-secret'}, createSecretStore:() => f.store, spawn});
      expect(order).toEqual(['gate','secret','gate','spawn']);
      const [command, args, spawnOptions] = spawn.mock.calls[0] as unknown as [string,string[],{cwd:string;env:Record<string,string>}];
      expect(command).toBe(f.launch.command);
      expect(args.slice(0,4)).toEqual([f.launch.entry,'__byok_sdk_helper','pi-rpc',`--config-digest=${'a'.repeat(64)}`]);
      expect(spawnOptions.cwd).toBe(f.launch.cwd);
      expect(spawnOptions.env).toEqual({...snapshots[0], PI_PROVIDER_API_KEY:CANARY});
      expect(snapshots[1]).toEqual(spawnOptions.env);
      expect(identity.toolImplementationLaunchEnvNamesDigest(snapshots[0]!)).toBe(identity.toolImplementationLaunchEnvNamesDigest(snapshots[1]!));
      expect(identity.toolImplementationLoaderEnvValuesDigest(snapshots[0]!)).toBe(identity.toolImplementationLoaderEnvValuesDigest(snapshots[1]!));
      expect(JSON.stringify(args)).not.toContain(CANARY);
      expect(JSON.stringify(f.options.launchBinding)).not.toContain(CANARY);
      expect(await fs.readFile(path.join(f.projection,'models.json'),'utf8')).not.toContain(CANARY);
      await launched.cleanup();
      expect(await fs.readdir(f.projection)).toEqual([]);
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  });

  it('refuses post-credential drift at the final gate with zero target spawns', async () => {
    const f = await fixture();
    try {
      const originalGet = f.store.get.bind(f.store);
      vi.spyOn(f.store,'get').mockImplementation(async (name) => {
        // Admission authority remains fixed; mutation after custody must be caught.
        f.options.launchBinding = {...f.options.launchBinding!};
        (f.launch as {cwd:string}).cwd = '/changed-after-secret';
        return originalGet(name);
      });
      // Use the same mutable binding as the caller until the final assertion.
      f.options.launchBinding = f.launch;
      const spawn = vi.fn(() => new ChildProcess());
      await expect(startPiProvider(f.provider,f.options,{ambient:{},createSecretStore:()=>f.store,spawn})).rejects.toThrow(/launch description drift/);
      expect(f.store.get).toHaveBeenCalledOnce(); expect(spawn).not.toHaveBeenCalled();
      expect(await fs.readdir(f.projection)).toEqual([]);
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  });
});

describe('Windows projection ACL verification', () => {
  const owner = 'S-1-5-21-1000';
  const good = { owner, currentUser:owner, protected:true, reparsePoint:false, rules:[
    {sid:owner,allow:true,fullControl:true,inherits:true},
    {sid:'S-1-5-18',allow:true,fullControl:true,inherits:true},
    {sid:'S-1-5-32-544',allow:true,fullControl:true,inherits:true},
  ]};
  it('uses fixed system PowerShell and transports the literal path on stdin', async () => {
    const run = vi.fn(async () => ({exitCode:0,stdout:JSON.stringify(good),stderr:''}));
    const directory = 'C:\\Task $x; path\\projection';
    await assertWindowsPiProjectionAcl(directory,{systemRoot:'C:\\Windows',run});
    const [command,args,input] = run.mock.calls[0] as unknown as [string,string[],string];
    expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0,3)).toEqual(['-NoProfile','-NonInteractive','-EncodedCommand']);
    expect(args.join(' ')).not.toContain(directory);
    expect(JSON.parse(input)).toEqual({path:directory});
  });
  it.each([
    {...good,owner:'S-1-5-21-2000'}, {...good,protected:false},
    {...good,reparsePoint:true}, {...good,extra:true},
    {...good,rules:[{...good.rules[0],extra:true}]},
    {...good,rules:[...good.rules,{sid:'S-1-1-0',allow:true,fullControl:false,inherits:true}]},
    {...good,rules:[{sid:owner,allow:true,fullControl:false,inherits:true}]},
    {...good,rules:[{sid:owner,allow:true,fullControl:true,inherits:false}]},
  ])('refuses unsafe ACL without repair', async (acl) => {
    const run = vi.fn(async () => ({exitCode:0,stdout:JSON.stringify(acl),stderr:''}));
    await expect(assertWindowsPiProjectionAcl('C:\\projection',{systemRoot:'C:\\Windows',run})).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
  });
});
