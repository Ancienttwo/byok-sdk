import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
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
