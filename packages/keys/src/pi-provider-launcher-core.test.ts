import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
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
  it.skipIf(process.platform === 'win32').each([undefined, 'opencode-go'] as const)('durable binds %s with one private IPC receipt and no credential-bearing child environment', async (providerId) => {
    const f = await fixture();
    const profile = parseModelProviderProfile({ ...f.provider, pi_model: { ...f.provider.pi_model!,
      ...(providerId === undefined ? {} : { api: 'openai-completions', providerId }) } });
    await f.profiles.save(profile);
    try {
      const child = new ChildProcess(); const send = vi.fn((_frame: unknown) => true); const kill = vi.spyOn(child,'kill').mockReturnValue(true);
      Object.assign(child, { connected: true, send });
      const spawn = vi.fn((..._args: Parameters<NonNullable<PiProviderLaunchDependencies['spawn']>>) => child);
      const launched = await startPiProvider(profile, { ...f.options, runtimeEntry:'pi-durable', piArgs:['--config',path.join(f.root,'config.json')] },
        { ambient:{PI_PROVIDER_API_KEY:'ambient-key',OPENAI_API_KEY:'ambient-key'}, createSecretStore:() => f.store, profiles:f.profiles, spawn });
      const options = spawn.mock.calls[0]![2] as {env:Record<string,string>;stdio:unknown};
      expect(options.env.PI_PROVIDER_API_KEY).toBeUndefined(); expect(JSON.stringify(options.env)).not.toContain(CANARY);
      expect(options.stdio).toEqual(['inherit','inherit','inherit','ipc']); expect(send).not.toHaveBeenCalled();
      child.emit('message', { type:'byok.pi.durable.credential-request', configDigest:'a'.repeat(64) });
      expect(send.mock.calls[0]![0]).toEqual({ type:'byok.pi.durable.credential', configDigest:'a'.repeat(64), secret:CANARY, profileRef:f.provider.profile_ref, providerId:providerId ?? `byok-sdk-${f.provider.profile_ref}` });
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

describe('Windows projection ACL verification', () => {
  const user = 'S-1-5-21-1000';
  const good = `D:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;RC;;;OW)`;
  const queryFailure = (cause: string, step: string, exit?: number) =>
    `pi_projection_acl_query_failed: Pi projection ACL query failed (cause=${cause}, step=${step}${exit === undefined ? '' : `, exit=${exit}`})`;
  // icacls /save writes UTF-16LE: the leaf name, then its SDDL (#1381 E1).
  // The reference file renders the current user as `userRendering` (the built-in Administrator renders as LA).
  function fakeTools(sddl: string, over: { icacls?: number; whoami?: number; whoamiOut?: string; saved?: (leaf: string) => string; userRendering?: string } = {}) {
    const saves: string[] = [];
    const run = vi.fn(async (executable: string, args: string[]) => {
      if (executable.endsWith('whoami.exe')) {
        return { exitCode: over.whoami ?? 0, stdout: over.whoamiOut ?? `"host\\user","${user}"\r\n`, stderr: 'C:\\Users\\someone' };
      }
      saves.push(args[0]!);
      if (over.icacls !== undefined) return { exitCode: over.icacls, stdout: '', stderr: 'C:\\Users\\someone\\secret: Access is denied.' };
      if (args[1] !== '/save') return { exitCode: 0, stdout: 'Successfully processed 1 files', stderr: '' };
      const leaf = path.basename(args[0]!);
      const record = leaf === 'user' ? `user\r\nD:PAI(A;;FA;;;${over.userRendering ?? user})\r\n` : over.saved?.(leaf) ?? `${leaf}\r\n${sddl}\r\n`;
      await fs.writeFile(args[2]!, Buffer.from(record, 'utf16le'));
      return { exitCode: 0, stdout: 'Successfully processed 1 files', stderr: '' };
    });
    return { run, saves };
  }
  async function withDirectory(check: (directory: string) => Promise<void>): Promise<void> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-unit-')));
    try {
      await fs.mkdir(path.join(root, 'projection'));
      await check(path.join(root, 'projection'));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  const assertAcl = (directory: string, run: ReturnType<typeof fakeTools>['run']) =>
    assertWindowsPiProjectionAcl(directory, { systemRoot: 'C:\\Windows', run });

  it('runs the fixed system whoami and icacls, saving into a private file it removes', async () => withDirectory(async directory => {
    const { run, saves } = fakeTools(good);
    await assertAcl(directory, run);
    const reference = saves[0]!;
    expect(run.mock.calls.map(([executable, args]) => [executable, args.slice(0, 2)])).toEqual([
      ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo']],
      ['C:\\Windows\\System32\\icacls.exe', [reference, '/inheritance:r']],
      ['C:\\Windows\\System32\\icacls.exe', [reference, '/save']],
      ['C:\\Windows\\System32\\icacls.exe', [directory, '/save']],
    ]);
    expect(run.mock.calls[1]![1]).toEqual([reference, '/inheritance:r', '/grant:r', `*${user}:(F)`]);
    await expect(fs.access(path.dirname(reference))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('accepts OWNER RIGHTS with READ_CONTROL plus SYNCHRONIZE and well-known SIDs in literal form', async () => withDirectory(async directory => {
    await assertAcl(directory, fakeTools(`D:PAI(A;OICI;FA;;;${user})(A;OICI;0x1f01ff;;;S-1-5-18)(A;;0x120000;;;S-1-3-4)`).run);
  }));
  it.each([
    ['an unprotected DACL', `D:AI(A;OICI;FA;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_unprotected'],
    ['a deny ACE', `D:P(D;;DC;;;${user})(A;OICI;FA;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_unauthorized_ace'],
    ['no OWNER RIGHTS ACE', `D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)`, 'pi_projection_acl_owner_rights_missing'],
    ['two OWNER RIGHTS ACEs', `D:P(A;OICI;FA;;;${user})(A;;RC;;;OW)(A;;RC;;;S-1-3-4)`, 'pi_projection_acl_owner_rights_missing'],
    ['OWNER RIGHTS with WRITE_DAC', `D:P(A;OICI;FA;;;${user})(A;;RCWD;;;OW)`, 'pi_projection_acl_owner_rights_missing'],
    ['an inheritable OWNER RIGHTS ACE', `D:P(A;OICI;FA;;;${user})(A;OICI;RC;;;OW)`, 'pi_projection_acl_owner_rights_missing'],
    ['another SID', `D:P(A;OICI;FA;;;${user})(A;;RC;;;OW)(A;;FR;;;S-1-1-0)`, 'pi_projection_acl_unauthorized_ace'],
    ['the user without full control', `D:P(A;OICI;0x1301bf;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_owner_access_missing'],
    ['the user full control that is inherit-only', `D:P(A;OICIIO;FA;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_owner_access_missing'],
    ['an unknown ACE type', `D:P(XA;;FA;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_invalid_ace'],
    ['an object ACE', `D:P(A;;FA;bf967a86-0de6-11d0-a285-00aa003049e2;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_invalid_ace'],
    ['an unknown ACE flag', `D:P(A;OICISA;FA;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_invalid_ace'],
    ['an unknown right', `D:P(A;OICI;ZZ;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_invalid_ace'],
    ['an unknown SID alias', `D:P(A;OICI;FA;;;${user})(A;;RC;;;OW)(A;;FR;;;AU)`, 'pi_projection_acl_invalid_ace'],
    ['a seventh ACE field', `D:P(A;OICI;FA;;;${user};x)(A;;RC;;;OW)`, 'pi_projection_acl_invalid_ace'],
    ['a conditional ACE', `D:P(XA;OICI;FA;;;${user};(x))(A;;RC;;;OW)`, 'pi_projection_acl_invalid_sddl'],
    ['an owner component', `O:BAD:P(A;OICI;FA;;;${user})(A;;RC;;;OW)`, 'pi_projection_acl_invalid_sddl'],
  ])('refuses %s without repair', async (_label, sddl, code) => withDirectory(async directory => {
    await expect(assertAcl(directory, fakeTools(sddl).run)).rejects.toThrow(code);
  }));
  // #1373: the built-in local Administrator (RID 500) is rendered as LA; only the user's own rendering matches.
  it('matches the current user by the form icacls renders it in', async () => withDirectory(async directory => {
    const asAlias = good.replace(`;;;${user})`, ';;;LA)');
    await assertAcl(directory, fakeTools(asAlias, { userRendering: 'LA' }).run);
    await expect(assertAcl(directory, fakeTools(asAlias).run)).rejects.toThrow('pi_projection_acl_invalid_ace');
  }));
  it.each([
    ['another leaf name', { saved: () => `other\r\n${good}\r\n` }],
    ['a reference rendering of another SID', { userRendering: 'S-1-5-21-2000' }],
    ['a reference rendering with two ACEs', { userRendering: `${user})(A;;FA;;;SY` }],
    ['a second record', { saved: (leaf: string) => `${leaf}\r\n${good}\r\n${leaf}\r\n${good}\r\n` }],
    ['a whoami line without a SID', { whoamiOut: '"host\\user","user"\r\n' }],
  ])('refuses %s', async (_label, over) => withDirectory(async directory => {
    await expect(assertAcl(directory, fakeTools(good, over).run)).rejects.toThrow('pi_projection_acl_invalid_output');
  }));
  it.each([
    ['icacls', 2, 'path_not_found'], ['icacls', 3, 'path_not_found'], ['icacls', 5, 'access_denied'],
    ['icacls', 127, 'icacls_unavailable'], ['icacls', 1, 'unexpected'], ['whoami', 127, 'whoami_unavailable'], ['whoami', 1, 'unexpected'],
  ] as const)('fails closed on %s exit %i with the closed cause %s and no host detail', async (step, exit, cause) => withDirectory(async directory => {
    const { run, saves } = fakeTools(good, step === 'icacls' ? { icacls: exit } : { whoami: exit });
    await expect(assertAcl(directory, run)).rejects.toThrow(new Error(queryFailure(cause, step, exit)));
    for (const file of saves) await expect(fs.access(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('classifies a missing leaf and a missing parent from the parent listing, before any tool runs', async () => withDirectory(async directory => {
    const { run } = fakeTools(good);
    await expect(assertAcl(path.join(directory, 'absent'), run)).rejects.toThrow(new Error(queryFailure('path_not_found', 'readdir')));
    await expect(assertAcl(path.join(directory, 'nope', 'absent'), run)).rejects.toThrow(new Error(queryFailure('path_not_found', 'readdir')));
    expect(run).not.toHaveBeenCalled();
  }));
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('classifies an unlistable parent as access_denied', async () => withDirectory(async directory => {
    await fs.chmod(path.dirname(directory), 0o000);
    try {
      await expect(assertAcl(directory, fakeTools(good).run)).rejects.toThrow(new Error(queryFailure('access_denied', 'readdir')));
    } finally { await fs.chmod(path.dirname(directory), 0o700); }
  }));
  it('refuses a link or a non-directory entry before any tool runs', async () => withDirectory(async directory => {
    const { run } = fakeTools(good);
    const link = path.join(path.dirname(directory), 'link');
    const file = path.join(path.dirname(directory), 'file');
    await fs.symlink(directory, link, 'junction');
    await fs.writeFile(file, '');
    await expect(assertAcl(link, run)).rejects.toThrow('pi_projection_reparse_point');
    await expect(assertAcl(file, run)).rejects.toThrow('pi_projection_not_directory_or_symlink');
    expect(run).not.toHaveBeenCalled();
  }));
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

  it.each([
    ['openai-responses', { api: 'openai-responses', compat: {} }, /api openai-responses/],
    ['inputLimits', { inputLimits: { maxRequestBytes: 1_048_576 } }, /declares Pi inputLimits; the prepared model wire/],
    ['supportsLongCacheRetention', { compat: { ...PI_MODEL_FIXTURE.compat, supportsLongCacheRetention: false } }, /declares Pi compat\.supportsLongCacheRetention; the prepared model wire/],
  ])('refuses a prepared entry for a pi_model that declares %s', (_, declared, message) => {
    const prepared = parseModelProviderProfile({ ...profile('bearer'), pi_model: { ...PI_MODEL_FIXTURE, ...declared } });
    expect(() => assertPiPreparedProviderProfile(prepared)).toThrow(message);
    expect(assertPiPreparedProviderProfile({ ...prepared, pi_model: PI_MODEL_FIXTURE })).toBeUndefined();
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
      // Same slots and messages as the client spawn helper's case. LC_* and XDG_* ambient names pass through.
      const secret = 'fake-key\0tail';
      vi.spyOn(store, 'get').mockResolvedValueOnce(secret); // a custom SecretStore; the built-in ones refuse NUL
      const carriesSecret = (value: unknown, depth = 0): boolean => typeof value === 'string' ? value.includes('fake-key')
        : depth < 5 && typeof value === 'object' && value !== null && Object.getOwnPropertyNames(value).some(key => carriesSecret((value as Record<string, unknown>)[key], depth + 1));
      for (const [input, ambient, message] of [[{}, {}, 'spawn env variable PI_PROVIDER_API_KEY contains a NUL byte'],
        [{ piBin: `/bin/${secret}` }, {}, 'spawn command contains a NUL byte'], [{ piFixedArgs: [secret] }, {}, 'spawn argument 1 contains a NUL byte'],
        [{}, { [`LC_${secret}`]: 'x' }, 'spawn env variable name contains a NUL byte']] as Array<[{ piBin?: string; piFixedArgs?: string[] }, Record<string, string>, string]>) {
        const spawnChild = vi.fn(nodeSpawn);
        const error = await startPiProvider(provider, { ...options, ...input }, { ambient, createSecretStore: () => store, spawn: spawnChild, profiles: await profilesWith(provider) })
          .then(() => undefined, (caught: Error) => caught);
        expect.soft(error?.message).toBe(message);
        expect.soft(carriesSecret(error)).toBe(false);
        expect.soft(spawnChild).not.toHaveBeenCalled();
      }
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
