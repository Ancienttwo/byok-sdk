import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHomeManager, AgentHomeResolutionError, ensureDirectoryNoSymlink } from '../agent-home';
import { builtAgentMemoryFilesystemHelperBin } from './fixtures/agent-memory-helper-build';
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';

const helperBin = builtAgentMemoryFilesystemHelperBin();
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('host storage root native barrier', () => {
  async function hostRoot() {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-created-root-')));
    roots.push(parent);
    return path.join(parent, 'host');
  }

  it.skipIf(helperBin === undefined)('initializes a newly created root through the actual release helper', async () => {
    const host = await hostRoot();
    const binding = await new AgentHomeManager({ hostStorageRoot: host }).prepare({ agentId: 'one', profileRevision: 'p1' });
    try {
      const filesystem = await openAgentMemoryFilesystemHelper({ helperBin: helperBin!,
        canonicalHome: binding.resolution.canonicalHome, ancestorRoot: binding.resolution.hostStorageRoot,
        homeIdentity: binding.lease.homeIdentity });
      try {
        expect(await filesystem.read('MEMORY.md', 8192)).toMatchObject({ exists: true, content: '' });
      } finally {
        await filesystem.close();
      }
    } finally {
      await binding.lease.release();
    }
  });
});

describe.skipIf(process.platform !== 'linux')('Linux new Agent home directory barriers', () => {
  async function setup() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-home-barrier-')));
    roots.push(root);
    const host = path.join(root, 'new', 'host');
    return { root, host, home: path.join(host, 'agents', 'one') };
  }

  it('syncs every new parent before publishing a usable home and internal directory', async () => {
    const { root, host, home } = await setup();
    const events: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync();
        events.push(String(args[0]));
      });
      return handle;
    });
    const binding = await new AgentHomeManager({ hostStorageRoot: host }).prepare({ agentId: 'one', profileRevision: 'p1' });
    try {
      // The mkdir chain is durable before prepare returns. `.byok` is made
      // during lease acquisition, before any intent ledger can be written.
      const required = [root, path.join(root, 'new'), host, path.join(host, 'agents'), home];
      for (const parent of required) expect(events).toContain(parent);
      expect(events.indexOf(host)).toBeLessThan(events.indexOf(path.join(host, 'agents')));
      expect(events.indexOf(path.join(host, 'agents'))).toBeLessThan(events.indexOf(home));
      expect((await fs.stat(path.join(home, '.byok'))).isDirectory()).toBe(true);
    } finally {
      await binding.lease.release();
    }
  });

  it.each([false, true])('retries the ancestor barrier after a failed branded-root creation (new manager: %s)', async restart => {
    const { root, host } = await setup();
    const realOpen = fs.open.bind(fs);
    const realMkdir = fs.mkdir.bind(fs);
    let failed = false;
    let retried = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === root && args[1] === 'r') {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (!failed) { failed = true; throw Object.assign(new Error('root ancestor barrier failed'), { code: 'EIO' }); }
          await sync();
          retried = true;
        });
      }
      return handle;
    });
    vi.spyOn(fs, 'mkdir').mockImplementation((...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]) === host) expect(retried).toBe(true);
      return realMkdir(...args);
    });
    const manager = new AgentHomeManager({ hostStorageRoot: host });
    await expect(manager.prepare({ agentId: 'one', profileRevision: 'p1' })).rejects.toThrow('root ancestor barrier failed');
    expect((await fs.stat(path.join(root, 'new'))).isDirectory()).toBe(true);
    await expect(fs.stat(host)).rejects.toMatchObject({ code: 'ENOENT' });
    const binding = await (restart ? new AgentHomeManager({ hostStorageRoot: host }) : manager).prepare({ agentId: 'one', profileRevision: 'p1' });
    await binding.lease.release();
    expect(retried).toBe(true);
  });

  it('does not expose an internal ledger directory until its parent barrier succeeds', async () => {
    const { host, home } = await setup();
    const realOpen = fs.open.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === home && args[1] === 'r') {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          attempts++;
          if (attempts === 1) throw Object.assign(new Error('internal directory barrier failed'), { code: 'EIO' });
          await sync();
        });
      }
      return handle;
    });
    const manager = new AgentHomeManager({ hostStorageRoot: host });
    await expect(manager.prepare({ agentId: 'one', profileRevision: 'p1' })).rejects.toMatchObject({ name: 'AgentHomeError', message: 'could not acquire Agent home lease: internal directory barrier failed' });
    expect((await fs.stat(path.join(home, '.byok'))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(home, '.byok', 'agent-home.lease'))).rejects.toMatchObject({ code: 'ENOENT' });
    const binding = await manager.prepare({ agentId: 'one', profileRevision: 'p1' });
    await binding.lease.release();
    expect(attempts).toBeGreaterThan(1);
  });

  it.each(['EINVAL', 'EPERM', 'EIO'])('fails closed on %s and repeats the barrier for crash residue', async code => {
    const { host, home } = await setup();
    const realOpen = fs.open.bind(fs);
    let failed = false;
    let retried = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path.dirname(home) && args[1] === 'r') {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          if (!failed) {
            failed = true;
            throw Object.assign(new Error('parent barrier failed'), { code });
          }
          retried = true;
          await sync();
        });
      }
      return handle;
    });
    const manager = new AgentHomeManager({ hostStorageRoot: host });
    await expect(manager.prepare({ agentId: 'one', profileRevision: 'p1' })).rejects.toMatchObject({ code });
    expect((await fs.stat(home)).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(home, '.byok'))).rejects.toMatchObject({ code: 'ENOENT' });
    const binding = await manager.prepare({ agentId: 'one', profileRevision: 'p1' });
    await binding.lease.release();
    expect(retried).toBe(true);
  });
});

describe('ensureDirectoryNoSymlink under concurrent creation', () => {
  async function store() {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-home-race-')));
    roots.push(home);
    return { home, target: path.join(home, '.byok', 'codex', 'sessions') };
  }

  it('lets concurrent first calls on an absent path all succeed', async () => {
    const { home, target } = await store();
    await expect(Promise.all(Array.from({ length: 5 }, () => ensureDirectoryNoSymlink(home, target)))).resolves.toEqual(Array(5).fill(target));
  });

  it('accepts a host storage root component that a concurrent creator made between lstat and mkdir', async () => {
    const { home } = await store();
    const host = path.join(home, 'new', 'host');
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === path.join(home, 'new')) await realMkdir(...args);
      return realMkdir(...args);
    });
    await expect(new AgentHomeManager({ hostStorageRoot: host }).prepare({ agentId: 'one', profileRevision: 'p1' })).resolves.toBeDefined();
  });

  it('refuses a symlink created between its lstat and its mkdir', async () => {
    const { home, target } = await store();
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-home-elsewhere-'));
    roots.push(elsewhere);
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === path.join(home, '.byok')) await fs.symlink(elsewhere, args[0] as string, 'dir');
      return realMkdir(...args);
    });
    await expect(ensureDirectoryNoSymlink(home, target)).rejects.toBeInstanceOf(AgentHomeResolutionError);
  });
});
