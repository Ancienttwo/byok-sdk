import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { piLaunchCommand, resolvePiRuntimeLaunch } from '../adapters/pi/runtime-launch';

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
      keysSessionDir:path.join(root,'native-sessions'),
      resolveInvocation: vi.fn(() => ({ command:process.execPath, entry:path.join(root,'sdk entry.js') })),
      env:{PATH:process.env.PATH!, HOME:sessionCwd, PI_PACKAGE_DIR:'/ambient-assets', BYOK_PI_PERMISSION_MODE:'invalid', OPENAI_API_KEY:'ambient-secret'},
    },
  };
}

describe('client runtime launch resources', () => {
  it.each(['instruction','prepared'] as const)('adapter %s admission resolves the Pi executable only at launch resolution', async (kind) => {
    const f = await fixture();
    const resolveBin = vi.fn(() => ({ command: process.execPath, source: 'env' as const }));
    const adapter = new PiAdapter({resolveBin});
    const prepared = await adapter.prepare({offer:{instruction:'Never sent'},descriptor:adapter.descriptor,requiredToolsetIds:[]});
    expect(prepared.kind).toBe('prepared');
    expect(resolveBin).not.toHaveBeenCalled();
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const resources = await prepared.operation.resolveRuntimeLaunch!({kind,cwd:f.options.sessionCwd,env:{},projectionRoot:f.options.projectionRoot});
    try {
      expect(resolveBin).toHaveBeenCalledOnce();
      expect(resources.kind).toBe(kind === 'prepared' ? 'pi-prepared' : 'pi-rpc');
    } finally { await resources.release(); }
  });

  it('launches in the session cwd with a private client-owned projection', async () => {
    const f = await fixture();
    const resources = await resolvePiRuntimeLaunch(f.options);
    try {
      expect(f.options.resolveInvocation).toHaveBeenCalledOnce();
      // The Pi process starts in the session cwd, as in OAR, as a real path.
      expect(resources.cwd).toBe(await fs.realpath(f.options.sessionCwd));
      expect(resources.sessionCwd).toBe(f.options.sessionCwd);
      expect(resources.command).toBe(process.execPath);
      expect(resources.entry).toBe(path.join(f.root,'sdk entry.js'));
      expect(resources.credentialSource).toBe('keys-profile');
      const projection = resources.projectionDir!;
      const stat = await fs.lstat(projection);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(await fs.realpath(projection)).toBe(projection);
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o700);
        expect(stat.uid).toBe(process.getuid!());
      }
      expect(await fs.readdir(projection)).toEqual([]);
      expect(path.dirname(projection)).toBe(f.options.projectionRoot);
      // The keys launcher sets the Pi directories of its own child.
      expect(resources.env.PI_CODING_AGENT_DIR).toBeUndefined();
      await resources.release(); await resources.release();
      await expect(fs.lstat(projection)).rejects.toMatchObject({code:'ENOENT'});
      expect(await fs.readdir(f.options.projectionRoot)).toEqual([]);
    } finally {await resources.release();}
  });

  it('creates no projection directory on the Pi auth store', async () => {
    const f = await fixture();
    const { keysSessionDir: _unused, ...options } = f.options;
    const resources = await resolvePiRuntimeLaunch(options);
    try {
      expect(resources.credentialSource).toBe('pi-auth-store');
      expect(resources.projectionDir).toBeUndefined();
      expect(resources.env).toEqual(f.options.env);
    } finally { await resources.release(); }
  });

  it('releases the projection when the invocation cannot be resolved', async () => {
    const f = await fixture();
    f.options.resolveInvocation.mockImplementation(() => { throw new Error('no Pi'); });
    await expect(resolvePiRuntimeLaunch(f.options)).rejects.toThrow('no Pi');
    expect(await fs.readdir(f.options.projectionRoot)).toEqual([]);
  });

  it('rejects projection roots inside the session, including a symlinked ancestor', async () => {
    const f = await fixture();
    await expect(resolvePiRuntimeLaunch({...f.options,projectionRoot:path.join(f.options.sessionCwd,'projection')})).rejects.toThrow(/inside session cwd/);
    const alias = path.join(f.root,'alias'); await fs.symlink(f.options.sessionCwd,alias);
    await expect(resolvePiRuntimeLaunch({...f.options,projectionRoot:path.join(alias,'projection')})).rejects.toThrow(/resolves inside session cwd/);
  });

  it('builds the direct and the keys launcher spawn commands', async () => {
    const f = await fixture();
    const resources = await resolvePiRuntimeLaunch(f.options);
    try {
      const digest = 'a'.repeat(64);
      expect(piLaunchCommand(resources, 'pi-rpc', digest, ['--config', '/c.json'], undefined)).toEqual({
        command: process.execPath, args: [path.join(f.root,'sdk entry.js'), `--config-digest=${digest}`, '--config', '/c.json'],
      });
      expect(piLaunchCommand(resources, 'pi-prepared', digest, ['--config', '/c.json'], {command:'/launcher', args:['--x'], profileArgs:['--provider','p']})).toEqual({
        command: '/launcher',
        args: ['--x', '--pi-bin', process.execPath, '--provider', 'p', '--runtime-entry', 'pi-prepared',
          '--pi-entry', path.join(f.root,'sdk entry.js'), '--pi-cwd', resources.cwd, '--pi-projection-dir', resources.projectionDir,
          '--pi-config-digest', digest, '--', '--config', '/c.json'],
      });
    } finally { await resources.release(); }
    const { keysSessionDir: _unused, ...direct } = f.options;
    const auth = await resolvePiRuntimeLaunch(direct);
    try {
      expect(() => piLaunchCommand(auth, 'pi-rpc', 'a'.repeat(64), [], {command:'/launcher', args:[], profileArgs:[]}))
        .toThrow(/projection directory/);
    } finally { await auth.release(); }
  });
});

describe('single-file re-entry (sdkHelperHost)', () => {
  it.each([['instruction', 'pi-rpc'], ['prepared', 'pi-prepared']] as const)('adapter %s launch re-enters the product executable as %s', async (kind, entry) => {
    const f = await fixture();
    const resolveBin = vi.fn(() => ({ command: process.execPath, source: 'env' as const }));
    const adapter = new PiAdapter({ resolveBin, sdkHelperHost: { mode: 'self-executable' } });
    const prepared = await adapter.prepare({offer:{instruction:'Never sent'},descriptor:adapter.descriptor,requiredToolsetIds:[]});
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const assets = fileURLToPath(new URL('../../dist/assets/', import.meta.url));
    const resources = await prepared.operation.resolveRuntimeLaunch!({kind,cwd:f.options.sessionCwd,env:{PI_PACKAGE_DIR:assets},projectionRoot:f.options.projectionRoot});
    try {
      expect(resolveBin).not.toHaveBeenCalled();
      expect(resources).toMatchObject({ kind: entry, command: process.execPath, fixedArgs: ['__byok_sdk_helper', entry] });
      expect(resources.entry).toBeUndefined();
      const digest = 'a'.repeat(64);
      expect(piLaunchCommand(resources, entry, digest, ['--config', '/c.json'], undefined)).toEqual({
        command: process.execPath, args: ['__byok_sdk_helper', entry, `--config-digest=${digest}`, '--config', '/c.json'],
      });
    } finally { await resources.release(); }
  });

  it('passes the re-entry argv to the keys launcher as --pi-fixed-args after the entry', async () => {
    const f = await fixture();
    const resources = await resolvePiRuntimeLaunch({ ...f.options, kind: 'pi-durable',
      resolveInvocation: () => ({ command: '/runtime/bun', entry: '/release/sdk.js', fixedArgs: ['__byok_sdk_helper', 'pi-durable'] }) });
    try {
      const digest = 'b'.repeat(64);
      expect(piLaunchCommand(resources, 'pi-durable', digest, ['--config', '/c.json'], {command:'/launcher', args:[], profileArgs:[]}).args).toEqual([
        '--pi-bin', '/runtime/bun', '--runtime-entry', 'pi-durable', '--pi-entry', '/release/sdk.js',
        '--pi-fixed-args', '["__byok_sdk_helper","pi-durable"]', '--pi-cwd', resources.cwd,
        '--pi-projection-dir', resources.projectionDir, '--pi-config-digest', digest, '--', '--config', '/c.json',
      ]);
    } finally { await resources.release(); }
  });
});

it('prepared launch retains only explicitly allowed env, excluding all six OpenAI constructor inputs', async () => {
  const f = await fixture();
  const forbidden = ['OPENAI_ADMIN_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
    'OPENAI_WEBHOOK_SECRET', 'OPENAI_LOG', 'OPENAI_CUSTOM_HEADERS', 'OPENAI_UNDECLARED'];
  const env = { ...f.options.env, ...Object.fromEntries(forbidden.map(key => [key, 'synthetic-canary'])) };
  const resources = await resolvePiRuntimeLaunch({ ...f.options, kind: 'pi-prepared', env });
  try {
    for (const name of forbidden) expect(resources.env).not.toHaveProperty(name);
    expect(resources.env.PATH).toBe(env.PATH);
  } finally { await resources.release(); }
});
