import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ChildProcess } from 'node:child_process';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import {
  assertPiPreparedProviderProfile,
  parsePiProviderLauncherOptions,
  assertPiProjectionDirectory,
  assertWindowsPiProjectionAcl,
  startPiProvider,
  type PiProviderLaunchDependencies,
  buildPiProviderChildEnvironment,
  ensurePiSessionDirectory,
  resolvePiProviderSecret,
} from './pi-provider-launcher-core';
import { buildPiProviderProjection } from './pi-provider-projection';
import { InMemoryProviderProfileStore } from './profile-store';
import { parseModelProviderProfile, type ModelProviderProfile } from './provider-profile';

async function profilesWith(provider: ModelProviderProfile): Promise<InMemoryProviderProfileStore> {
  const profiles = new InMemoryProviderProfileStore();
  await profiles.save(provider);
  return profiles;
}

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

function launchFlags(projectionDir = '/projection'): string[] {
  return ['--pi-cwd', '/sealed', '--pi-projection-dir', projectionDir, '--pi-config-digest', 'a'.repeat(64)];
}
afterEach(() => { vi.restoreAllMocks(); });

describe('Pi provider launcher core', () => {
  it('does not forward old SDK extension environment across custody', () => {
    const mcp = path.join(os.tmpdir(), 'task-mcp.json');
    const env = buildPiProviderChildEnvironment({
      ambient: { BYOK_PI_MCP_CONFIG_PATH: mcp, BYOK_PI_PERMISSION_MODE: 'readonly', BYOK_PI_UNTRUSTED: 'discard', ZAI_API_KEY: CANARY },
      projectionDir: '/projection', sessionDir: '/sessions', secret: undefined,
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
    expect(buildPiProviderChildEnvironment({ ambient, projectionDir: '/projection', sessionDir: '/sessions', secret: undefined })).toEqual({PI_CODING_AGENT_DIR:'/projection', PI_CODING_AGENT_SESSION_DIR:'/sessions'});
  });
  it('parses only the closed launcher contract and requires absolute custody paths', () => {
    const profileDbPath = path.join(os.tmpdir(), 'providers.sqlite');
    const sessionDir = path.join(os.tmpdir(), 'pi-sessions');
    const macosKeychainPath = '/private/tmp/byok-login.keychain-db';
    expect(parsePiProviderLauncherOptions([
      '--pi-bin',
      '/opt/pi',
      '--runtime-entry',
      'pi-rpc',
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
      ...launchFlags(),
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
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
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
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'openrouter-primary',
      '--model', 'anthropic/claude-sonnet-4',
      '--profile-revision', '1787702400001',
      '--validate-only', 'true',
    ])).toThrow(/requires revision, hash, and required capabilities together/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', '../escape',
      '--model', 'local-model',
      '--', '--mode', 'rpc',
    ])).toThrow(/not a valid @byok-sdk\/keys identifier/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
      '--profile-db', 'providers.sqlite',
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model',
      '--', '--mode', 'rpc',
    ])).toThrow(/absolute/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model\nforged-log',
      '--', '--mode', 'rpc',
    ])).toThrow(/single-line/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model',
      '--macos-keychain-path', 'login.keychain-db',
      '--', '--mode', 'rpc',
    ])).toThrow(/absolute/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc',
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
      projectionDir: '/private/projection',
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
  const args = ['--pi-bin', process.execPath, '--runtime-entry', 'pi-rpc', '--profile-db', path.join(os.tmpdir(), 'profiles.db'),
    '--session-dir', path.join(os.tmpdir(), 'sessions'), '--provider', 'custom', '--model', 'local-model'];
  it('preserves a spaced script path as one argument and leaves executable mode explicit', () => {
    const piEntry = path.join(os.tmpdir(), 'Pi package with spaces', 'cli.js');
    expect(parsePiProviderLauncherOptions([...args, '--pi-entry', piEntry, ...launchFlags(), '--', '--mode', 'rpc']).piEntry).toBe(piEntry);
    expect(parsePiProviderLauncherOptions([...args, ...launchFlags(), '--', '--mode', 'rpc']).piEntry).toBeUndefined();
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
    const launch = { command: process.execPath, entry: path.join(root, 'entry with spaces.js'), cwd: '/sealed' };
    const options = parsePiProviderLauncherOptions([
      '--pi-bin', launch.command, '--runtime-entry', 'pi-rpc', '--pi-entry', launch.entry, '--profile-db', path.join(root, 'db'),
      '--session-dir', sessions, '--provider', 'custom', '--model', 'local-model',
      '--pi-cwd', launch.cwd, '--pi-projection-dir', projection, '--pi-config-digest', 'a'.repeat(64),
      '--', '--config', path.join(root, 'task config.json'), '--mode', 'rpc', '--no-skills',
    ]);
    const provider = parseModelProviderProfile({ ...profile('bearer'), pi_model: PI_MODEL_FIXTURE });
    const store = new InMemorySecretStore();
    await store.set(modelProviderSecretName('custom'), CANARY);
    const profiles = await profilesWith(provider);
    return { root, projection, sessions, launch, options, provider, store, profiles };
  }

  it('requires one launcher-owned digest and refuses delegated overrides', async () => {
    const f = await fixture();
    try {
      const base = ['--pi-bin',f.launch.command,'--runtime-entry','pi-rpc','--pi-entry',f.launch.entry,'--profile-db',path.join(f.root,'db'),
        '--session-dir',f.sessions,'--provider','custom','--model','local-model',...launchFlags(f.projection)];
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
        {ambient:{},createSecretStore,spawn,profiles:f.profiles})).rejects.toThrow(/argument|config-digest/);
      expect(createSecretStore).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally {await fs.rm(f.root,{recursive:true,force:true});}
  });

  it('requires an explicit cwd and projection directory for actual launch, while validate-only stays credential-blind', () => {
    const base = ['--pi-bin', '/opt/pi', '--runtime-entry', 'pi-rpc', '--profile-db', '/db', '--session-dir', '/sessions', '--provider', 'custom', '--model', 'local-model'];
    expect(() => parsePiProviderLauncherOptions([...base, '--', '--mode', 'rpc'])).toThrow(/pi-cwd/);
    expect(parsePiProviderLauncherOptions([...base, '--validate-only', 'true']).piProjectionDir).toBeUndefined();
    expect(parsePiProviderLauncherOptions([...base, ...launchFlags(), '--', '--mode', 'rpc'])).toMatchObject({ piCwd: '/sealed', piProjectionDir: '/projection' });
    for (const flag of ['--pi-cwd', '--pi-projection-dir']) {
      const bad = launchFlags(); bad[bad.indexOf(flag) + 1] = 'relative';
      expect(() => parsePiProviderLauncherOptions([...base, ...bad, '--', '--mode', 'rpc'])).toThrow(/absolute/);
    }
    expect(() => parsePiProviderLauncherOptions([...base, ...launchFlags(), '--launch-binding', '{}', '--', '--mode', 'rpc'])).toThrow(/unknown launcher argument/);
  });

  it('accepts only the single-file re-entry prefix for the parsed runtime entry in --pi-fixed-args', () => {
    const base = (entry: string) => ['--pi-bin', '/product/agent', '--runtime-entry', entry, '--profile-db', '/db', '--session-dir', '/sessions', '--provider', 'custom', '--model', 'local-model', ...launchFlags()];
    expect(parsePiProviderLauncherOptions([...base('pi-rpc'), '--', '--mode', 'rpc']).piFixedArgs).toEqual([]);
    expect(parsePiProviderLauncherOptions([...base('pi-rpc'), '--pi-fixed-args', '["__byok_sdk_helper","pi-rpc"]', '--', '--mode', 'rpc']).piFixedArgs)
      .toEqual(['__byok_sdk_helper', 'pi-rpc']);
    expect(parsePiProviderLauncherOptions([...base('pi-prepared'), '--pi-fixed-args', '["__byok_sdk_helper","pi-prepared"]', '--', '--config', '/c.json']).piFixedArgs)
      .toEqual(['__byok_sdk_helper', 'pi-prepared']);
    for (const bad of ['', 'not json', '[]', '["__byok_sdk_helper"]', '["__byok_sdk_helper","pi-prepared"]', '["__byok_sdk_helper","pi-rpc","x"]',
      '["other","pi-rpc"]', '[ "__byok_sdk_helper", "pi-rpc" ]']) {
      expect(() => parsePiProviderLauncherOptions([...base('pi-rpc'), '--pi-fixed-args', bad, '--', '--mode', 'rpc']), bad).toThrow(/--pi-fixed-args (must be exactly|requires a value)/);
    }
  });

  it('sets the launch-owned Pi directories, ignores ambient ones and keeps the product Pi asset root', () => {
    const env = buildPiProviderChildEnvironment({ ambient:{PI_PACKAGE_DIR:'/product/pi-assets', PI_CODING_AGENT_DIR:'/ambient', PI_CODING_AGENT_SESSION_DIR:'/ambient'}, projectionDir:'/projection', sessionDir:'/sessions', secret:undefined });
    expect(env.PI_PACKAGE_DIR).toBe('/product/pi-assets');
    expect(env.PI_CODING_AGENT_DIR).toBe('/projection');
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe('/sessions');
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
          f.options.piProjectionDir = path.join(alias, 'projection');
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
        await expect(startPiProvider(f.provider, f.options, {ambient:{}, createSecretStore:openStore, spawn, profiles:f.profiles})).rejects.toThrow();
        expect(openStore).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
        if (kind === 'nonempty') expect(await fs.readFile(path.join(f.projection, 'owned-by-client'), 'utf8')).toBe('preserve');
      } finally { vi.restoreAllMocks(); await fs.rm(f.root, {recursive:true, force:true}); }
    },
  );

  it('rejects a projection path that is not absolute and normalized', async () => {
    for (const candidate of ['projection', '/projection/../projection']) {
      await expect(assertPiProjectionDirectory(candidate)).rejects.toThrow(/absolute normalized/);
    }
  });

  // Production refuses the Windows durable entry before custody; POSIX IPC evidence runs elsewhere.
  it.skipIf(process.platform === 'win32')('durable uses one private IPC receipt and never constructs a credential-bearing child environment', async () => {
    const f = await fixture();
    try {
      const child = new ChildProcess(); const send = vi.fn((_frame: unknown) => true); const kill = vi.spyOn(child,'kill').mockReturnValue(true);
      Object.assign(child, { connected: true, send });
      const spawn = vi.fn((..._args: Parameters<NonNullable<PiProviderLaunchDependencies['spawn']>>) => child);
      const launched = await startPiProvider(f.provider, { ...f.options, runtimeEntry:'pi-durable', piArgs:['--config',path.join(f.root,'config.json')] },
        { ambient:{PI_PROVIDER_API_KEY:'ambient-key',OPENAI_API_KEY:'ambient-key'}, createSecretStore:() => f.store, profiles:f.profiles, spawn });
      const options = spawn.mock.calls[0]![2] as {env:Record<string,string>;stdio:unknown};
      expect(options.env.PI_PROVIDER_API_KEY).toBeUndefined(); expect(JSON.stringify(options.env)).not.toContain(CANARY);
      expect(options.stdio).toEqual(['inherit','inherit','inherit','ipc']); expect(send).not.toHaveBeenCalled();
      child.emit('message', { type:'byok.pi.durable.credential-request', configDigest:'a'.repeat(64) });
      expect(send.mock.calls[0]![0]).toEqual({ type:'byok.pi.durable.credential', configDigest:'a'.repeat(64), secret:CANARY });
      child.emit('message', { type:'byok.pi.durable.credential-request', configDigest:'a'.repeat(64) }); expect(send).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled(); await launched.cleanup();
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  });
  // #385: the rpc host runs Pi's own bash tool, which copies process.env, so
  // its key travels over the same private IPC channel as the durable worker's.
  it('reads exactly one secret after layout checks, keeps it out of the rpc environment, and spawns the requested argv/cwd', async () => {
    const f = await fixture();
    try {
      const order: string[] = [];
      const read = f.store.get.bind(f.store);
      vi.spyOn(f.store, 'get').mockImplementation(async (name) => { order.push('secret'); return read(name); });
      const child = new ChildProcess(); const send = vi.fn((_frame: unknown) => true); const kill = vi.spyOn(child,'kill').mockReturnValue(true);
      Object.assign(child, { connected: true, send });
      const spawn = vi.fn(() => {order.push('spawn'); return child;});
      const launched = await startPiProvider(f.provider, f.options, {ambient:{PATH:'/usr/bin', OPENAI_API_KEY:'ambient-secret', PI_PROVIDER_API_KEY:'ambient-key'}, createSecretStore:() => f.store, spawn, profiles:f.profiles});
      expect(order).toEqual(['secret','spawn']);
      const [command, args, spawnOptions] = spawn.mock.calls[0] as unknown as [string,string[],{cwd:string;env:Record<string,string>;stdio:unknown;serialization:unknown}];
      expect(command).toBe(f.launch.command);
      expect(args.slice(0,2)).toEqual([f.launch.entry,`--config-digest=${'a'.repeat(64)}`]);
      expect(spawnOptions.cwd).toBe(f.launch.cwd);
      expect(spawnOptions.env).toEqual({PATH:'/usr/bin', PI_CODING_AGENT_DIR:f.projection, PI_CODING_AGENT_SESSION_DIR:f.sessions});
      expect(spawnOptions.stdio).toEqual(['inherit','inherit','inherit','ipc']);
      expect(spawnOptions.serialization).toBe('json');
      expect(send).not.toHaveBeenCalled();
      child.emit('message', { type:'byok.pi.rpc.credential-request', configDigest:'a'.repeat(64) });
      expect(send.mock.calls[0]![0]).toEqual({ type:'byok.pi.rpc.credential', configDigest:'a'.repeat(64), secret:CANARY });
      child.emit('message', { type:'byok.pi.rpc.credential-request', configDigest:'a'.repeat(64) }); expect(send).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
      expect(JSON.stringify(args)).not.toContain(CANARY);
      expect(JSON.stringify(f.options)).not.toContain(CANARY);
      expect(await fs.readFile(path.join(f.projection,'models.json'),'utf8')).not.toContain(CANARY);
      await launched.cleanup();
      expect(await fs.readdir(f.projection)).toEqual([]);
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  });

  it.each([
    ['another lane', { type:'byok.pi.durable.credential-request', configDigest:'a'.repeat(64) }],
    ['another digest', { type:'byok.pi.rpc.credential-request', configDigest:'b'.repeat(64) }],
    ['extra fields', { type:'byok.pi.rpc.credential-request', configDigest:'a'.repeat(64), secret:'x' }],
  ])('kills the rpc child instead of answering a credential request for %s', async (_name, request) => {
    const f = await fixture();
    try {
      const child = new ChildProcess(); const send = vi.fn((_frame: unknown) => true); const kill = vi.spyOn(child,'kill').mockReturnValue(true);
      Object.assign(child, { connected: true, send });
      const launched = await startPiProvider(f.provider, f.options, {ambient:{}, createSecretStore:() => f.store, spawn:() => child, profiles:f.profiles});
      child.emit('message', request);
      expect(send).not.toHaveBeenCalled(); expect(kill).toHaveBeenCalledOnce();
      await launched.cleanup();
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  });

  it('spawns a single-file product with its fixed re-entry argv before the config digest', async () => {
    const f = await fixture();
    try {
      const spawn = vi.fn(() => new ChildProcess());
      const launched = await startPiProvider(f.provider, { ...f.options, piFixedArgs: ['__byok_sdk_helper', 'pi-rpc'] },
        {ambient:{PATH:'/usr/bin'}, createSecretStore:() => f.store, spawn, profiles:f.profiles});
      const [command, args] = spawn.mock.calls[0] as unknown as [string,string[]];
      expect(command).toBe(f.launch.command);
      expect(args.slice(0,4)).toEqual([f.launch.entry,'__byok_sdk_helper','pi-rpc',`--config-digest=${'a'.repeat(64)}`]);
      await launched.cleanup();
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  });

  it('refuses to read the key or spawn while a credential change is pending', async () => {
    const f = await fixture();
    try {
      await f.profiles.markPending({ profileRef: 'custom', operation: 'configure', requestId: 'r1', requestDigest: `sha256:${'3'.repeat(64)}`, operationGeneration: 2, since: timestamps.created_at });
      const get = vi.spyOn(f.store, 'get');
      const spawn = vi.fn(() => new ChildProcess());
      await expect(startPiProvider(f.provider, f.options, { ambient: {}, createSecretStore: () => f.store, spawn, profiles: f.profiles }))
        .rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });
      expect(get).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(await fs.readdir(f.projection)).toEqual([]);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});

/**
 * Positions in a PowerShell script where a command could be invoked, so could
 * resolve through PSModulePath. The ACL script is .NET-only, and this guard
 * enforces that structurally, without a denylist that the next alias would
 * slip past:
 * - every statement (split on newline, ';', '{', '}' and '|') starts with a
 *   variable, a type expression, a try/catch/exit keyword or an if/while/foreach
 *   condition; an `exit` takes only a literal, a variable or a parenthesis;
 * - an assignment's right-hand side starts with a variable, type expression,
 *   parenthesis, string, number or '@';
 * - a foreach header's input after 'in' starts with the same value tokens;
 * - after every '(' (so also '$(' and '@('), and after every ',' (call
 *   arguments, outside type brackets), the next token is a variable, type
 *   expression, parenthesis, string, number or '@' (after '(' also ')'), never
 *   a bare word, '&' or '.'.
 * Single-quoted strings are inert, so their contents are blanked first;
 * double-quoted strings stay in view because '$(...)' runs inside them.
 * Rejects Verb-Noun cmdlets in any case and aliases (gi, gci, %, ?, iex,
 * select, where, ...).
 */
function powershellCommandFindings(script: string): string[] {
  const code = script.replaceAll(/'[^']*'/gu, "''");
  const statementStart = /^(?:\$|\[|(?:try|catch)\b|exit\b\s*(?:$|[\d$(]\S*)|(?:if|while|foreach)\s*\()/iu;
  const valueStart = /^(?:\$|\[|\(|'|"|\d|@)/u;
  const findings: string[] = [];
  for (const statement of code.split(/[\n;{}|]/u).map((part) => part.trim()).filter((part) => part !== '')) {
    if (!statementStart.test(statement)) findings.push(statement);
    const rhs = /^\$\w+(?:\['[^']*'\])?\s*=\s*(.*)$/u.exec(statement)?.[1];
    if (rhs !== undefined && !valueStart.test(rhs)) findings.push(statement);
  }
  for (const [, next] of code.matchAll(/\((?=\s*(\S?))/gu)) {
    if (!/^[$[('"@)\d]$/u.test(next ?? '')) findings.push(`( followed by ${JSON.stringify(next)}`);
  }
  for (const [, next] of code.matchAll(/\bforeach\s*\(\s*\$\w+\s+in\b\s*(\S?)/giu)) {
    if (!valueStart.test(next ?? '')) findings.push(`foreach in followed by ${JSON.stringify(next)}`);
  }
  // Generic type arguments ([Dictionary[string, object]]) are not call arguments.
  let untyped = code;
  for (let previous = ''; previous !== untyped;) {
    previous = untyped;
    untyped = untyped.replaceAll(/\[[A-Za-z][^[\]]*\]/gu, '[T]');
  }
  for (const [, next] of untyped.matchAll(/,(?=\s*(\S?))/gu)) {
    if (!/^[$[('"@\d]$/u.test(next ?? '')) findings.push(`, followed by ${JSON.stringify(next)}`);
  }
  if (/\b[a-z]+-[a-z]+\b/iu.test(code.replaceAll(/\s-[a-z]+\b/giu, ' '))) findings.push('Verb-Noun');
  return findings;
}

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
  it('runs a query that invokes no PowerShell command, so no module is ever auto-loaded', async () => {
    const run = vi.fn(async () => ({exitCode:0,stdout:JSON.stringify(good),stderr:''}));
    await assertWindowsPiProjectionAcl('C:\\projection',{systemRoot:'C:\\Windows',run});
    const [,args] = run.mock.calls[0] as unknown as [string,string[]];
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    expect(script).toContain('GetAccessControl');
    // A Verb-Noun command (or an alias for one) resolves through PSModulePath;
    // an inherited PowerShell 7 module path then shadows
    // Microsoft.PowerShell.Security.
    expect(powershellCommandFindings(script)).toEqual([]);
  });
  it('rejects every command form the cmdlet guard exists to keep out', () => {
    for (const script of [
      '$acl = Get-Acl $path', '$acl = get-acl $path', '$acl = GET-ACL $path',
      'gi $path', 'gci $path', '$x | select Name', '$x | where Name', '$x | % { $_ }',
      '$x | ? { $_ }', 'iex $text', '$x | foreach Name', '$acl = gi $path',
      // Commands reached through a parenthesis, subexpression or argument.
      '$acl = (gi $path).GetAccessControl()', '$acl = $(gi $path)', '$acl = @(gci $path)',
      '[void](iex $text)', '$x = (& $cmd)', '$x = (. $script)', 'exit (gi $p)',
      'if ((gi $p)) { exit 0 }', '$x = "$(gi $p)"', '$x.Add((gci $p))',
      'exit gi $p', '$x.Add($a, gi $p)', '$x = ( gi $p)',
      // A foreach input is a pipeline even without a wrapping parenthesis.
      'foreach ($i in gi $p) {', 'foreach ($i in gci $p) { $i }',
      'foreach($i in gi){$i}', 'FOREACH ($i IN gi $p) {',
    ]) expect(powershellCommandFindings(script), script).not.toEqual([]);
  });
  it('accepts foreach headers whose inputs start with value tokens', () => {
    for (const input of ['$items', '[int]1', '($items)', "'literal'", '"literal"', '@($items)', '1']) {
      const script = `foreach ($i in ${input}) { $i }`;
      expect(powershellCommandFindings(script), script).toEqual([]);
    }
  });
  it('loads the serializer assembly in its own try, outside the path_not_found mapping', async () => {
    const run = vi.fn(async () => ({exitCode:0,stdout:JSON.stringify(good),stderr:''}));
    await assertWindowsPiProjectionAcl('C:\\projection',{systemRoot:'C:\\Windows',run});
    const [,args] = run.mock.calls[0] as unknown as [string,string[]];
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    // A missing System.Web.Extensions throws FileNotFoundException; inside the
    // main try it would be mapped to exit 3 (path_not_found).
    expect(script).toMatch(/^try \{ \[void\]\[System\.Reflection\.Assembly\]::Load\('System\.Web\.Extensions,[^']*'\) \} catch \{ exit 5 \}$/mu);
  });
  it.each([
    [2, 'invalid_request'], [3, 'path_not_found'], [4, 'access_denied'],
    [127, 'powershell_unavailable'], [1, 'unexpected'], [5, 'unexpected'], [-196608, 'unexpected'],
  ])('fails closed on query exit %i with the closed cause %s and no host detail', async (exitCode, cause) => {
    const stderr = 'C:\\Users\\someone\\secret-dir: System.UnauthorizedAccessException';
    const run = vi.fn(async () => ({exitCode,stdout:JSON.stringify(good),stderr}));
    const failure = await assertWindowsPiProjectionAcl('C:\\Users\\someone\\projection',{systemRoot:'C:\\Windows',run})
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message)
      .toBe(`pi_projection_acl_query_failed: Pi projection ACL query failed (cause=${cause}, exit=${exitCode})`);
  });
});

describe('the required runtime entry', () => {
  const base = ['--pi-bin', '/opt/pi', '--profile-db', '/db', '--session-dir', '/sessions',
    '--provider', 'custom', '--model', 'local-model', '--validate-only', 'true'];

  it('refuses a client that states no runtime entry', () => {
    expect(() => parsePiProviderLauncherOptions([...base])).toThrow(/--runtime-entry requires a value/);
  });

  it.each(['pi-subagent-runner', 'pi-subagent-print', 'rpc', 'prepared', 'PI-RPC', ''])(
    'refuses the unknown runtime entry %j', (entry) => {
      expect(() => parsePiProviderLauncherOptions([...base, '--runtime-entry', entry])).toThrow();
    },
  );

  it.each(['pi-rpc', 'pi-prepared', 'pi-durable'] as const)('carries the declared entry %s', (entry) => {
    expect(parsePiProviderLauncherOptions([...base, '--runtime-entry', entry]).runtimeEntry).toBe(entry);
  });

  it('refuses a prepared entry for a profile the prepared lane cannot serve', () => {
    expect(() => assertPiPreparedProviderProfile(profile('none')))
      .toThrow(/auth_mode "none"/);
    const anthropic = parseModelProviderProfile({
      ...timestamps, adapter: 'anthropic', auth_mode: 'x_api_key', base_url: 'https://api.anthropic.com',
      capabilities: [], display_name: 'Claude', enabled: true, kind: 'model', model: 'claude-sonnet-5',
      profile_ref: 'anthropic', provider_kind: 'anthropic',
    });
    expect(() => assertPiPreparedProviderProfile(anthropic)).toThrow(/anthropic adapter/);
    expect(assertPiPreparedProviderProfile(profile('bearer'))).toBeUndefined();
  });
});

describe('the prepared runtime entry spawn', () => {
  it('writes the projection, injects exactly one secret and appends nothing to --config', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keys-pi-prepared-')));
    try {
      const projection = path.join(root, 'projection');
      const sessions = path.join(root, 'sessions');
      const configPath = path.join(root, 'prepared launch.json');
      await fs.mkdir(projection, { mode: 0o700 });
      const launch = { command: process.execPath, entry: path.join(root, 'host.js'), cwd: '/sealed' };
      const options = parsePiProviderLauncherOptions([
        '--pi-bin', launch.command, '--runtime-entry', 'pi-prepared', '--pi-entry', launch.entry,
        '--profile-db', path.join(root, 'db'), '--session-dir', sessions,
        '--provider', 'custom', '--model', 'local-model',
        '--pi-cwd', launch.cwd, '--pi-projection-dir', projection, '--pi-config-digest', 'a'.repeat(64),
        '--', '--config', configPath,
      ]);
      const provider = parseModelProviderProfile({ ...profile('bearer'), pi_model: PI_MODEL_FIXTURE });
      const store = new InMemorySecretStore();
      await store.set(modelProviderSecretName('custom'), CANARY);
      const spawn = vi.fn(() => new ChildProcess());
      const launched = await startPiProvider(provider, options, { ambient: { PATH: '/usr/bin' }, createSecretStore: () => store, spawn, profiles: await profilesWith(provider) });
      const [command, args, spawnOptions] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; env: Record<string, string> }];
      expect(command).toBe(launch.command);
      expect(args).toEqual([launch.entry, `--config-digest=${'a'.repeat(64)}`, '--config', configPath]);
      expect(args).not.toContain('--provider');
      expect(args).not.toContain('--thinking');
      expect(JSON.stringify(args)).not.toContain(CANARY);
      expect(spawnOptions.env.PI_PROVIDER_API_KEY).toBe(CANARY);
      const written = JSON.parse(await fs.readFile(path.join(projection, 'models.json'), 'utf8')) as Record<string, unknown>;
      expect(written).toEqual(buildPiProviderProjection(provider, 'pi-prepared'));
      expect(JSON.stringify(written)).not.toContain(CANARY);
      await launched.cleanup();
      expect(await fs.readdir(projection)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('refuses rpc-shaped delegated argv under the prepared entry, before any credential access', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keys-pi-prepared-refusal-')));
    try {
      const projection = path.join(root, 'projection');
      const sessions = path.join(root, 'sessions');
      await fs.mkdir(projection, { mode: 0o700 });
      const launch = { command: process.execPath, entry: path.join(root, 'host.js'), cwd: '/sealed' };
      const options = parsePiProviderLauncherOptions([
        '--pi-bin', launch.command, '--runtime-entry', 'pi-prepared', '--pi-entry', launch.entry,
        '--profile-db', path.join(root, 'db'), '--session-dir', sessions,
        '--provider', 'custom', '--model', 'local-model',
        '--pi-cwd', launch.cwd, '--pi-projection-dir', projection, '--pi-config-digest', 'a'.repeat(64),
        '--', '--config', path.join(root, 'launch.json'), '--mode', 'rpc',
      ]);
      const provider = parseModelProviderProfile({ ...profile('bearer'), pi_model: PI_MODEL_FIXTURE });
      const createSecretStore = vi.fn(() => new InMemorySecretStore());
      const spawn = vi.fn(() => new ChildProcess());
      await expect(startPiProvider(provider, options, { ambient: {}, createSecretStore, spawn, profiles: await profilesWith(provider) }))
        .rejects.toThrow(/exactly --config/);
      expect(createSecretStore).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
