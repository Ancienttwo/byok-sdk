import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentHomeBusyError,
  AgentHomeManager,
  LocalStateRelocationBusyError,
  LocalStateRelocationIntegrityError,
  localStateRelocation,
} from '../index';
import { acquireDaemonOwner } from '../daemon/daemon-owner';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-local-state-relocation-'));
  const root = await fs.realpath(created);
  roots.push(root);
  return root;
}

function relocationInput(root: string) {
  return {
    productId: 'salesko-personal-agent',
    sourceStoreDir: path.join(root, 'legacy-store'),
    sourceHostStorageRoot: path.join(root, 'legacy-home'),
    destinationStoreDir: path.join(root, 'salesko-home', 'computer'),
    destinationHostStorageRoot: path.join(root, 'salesko-home'),
  } as const;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('localStateRelocation', () => {
  it('refuses an active Agent writer with no destination effect, then excludes new writers until exact idempotent release', async () => {
    const root = await makeRoot();
    const input = relocationInput(root);
    const manager = new AgentHomeManager({ hostStorageRoot: input.sourceHostStorageRoot });
    const active = await manager.acquire({ agentId: 'one', profileRevision: '1' });
    try {
      await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationBusyError);
      await expect(fs.lstat(input.destinationStoreDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(input.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await active.lease.release();
    }

    const relocation = await localStateRelocation.acquire(input);
    expect(relocation).toMatchObject(input);
    await expect(manager.acquire({ agentId: 'two', profileRevision: '1' }))
      .rejects.toBeInstanceOf(AgentHomeBusyError);
    await expect(acquireDaemonOwner(input.destinationStoreDir, 'daemon'))
      .rejects.toThrow();
    await expect(fs.lstat(input.destinationStoreDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(input.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await Promise.all([relocation.release(), relocation.release()]);

    const after = await manager.acquire({ agentId: 'two', profileRevision: '1' });
    await after.lease.release();
  });

  it('refuses active and corrupt daemon ownership without reclaiming either state', async () => {
    const root = await makeRoot();
    const input = relocationInput(root);
    const owner = await acquireDaemonOwner(input.sourceStoreDir, 'daemon');
    try {
      await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationBusyError);
      await expect(fs.lstat(input.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await owner.release();
    }

    const destinationOwner = await acquireDaemonOwner(input.destinationStoreDir, 'doctor');
    try {
      await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationBusyError);
    } finally {
      await destinationOwner.release();
    }

    const ownerPath = path.join(input.sourceStoreDir, 'daemon-owner.json');
    await fs.writeFile(ownerPath, '{broken', { mode: 0o600 });
    await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationIntegrityError);
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toBe('{broken');

    await fs.rm(ownerPath);
    const reclaimPath = `${ownerPath}.reclaim`;
    await fs.writeFile(reclaimPath, '{unknown', { mode: 0o600 });
    await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationIntegrityError);
    await expect(fs.readFile(reclaimPath, 'utf8')).resolves.toBe('{unknown');
  });

  it('refuses an unknown Agent-home lease marker and leaves it untouched', async () => {
    const root = await makeRoot();
    const input = relocationInput(root);
    const manager = new AgentHomeManager({ hostStorageRoot: input.sourceHostStorageRoot });
    const binding = await manager.acquire({ agentId: 'one', profileRevision: '1' });
    const marker = path.join(binding.resolution.canonicalHome, '.byok', 'agent-home.lease');
    await binding.lease.release();
    await fs.writeFile(marker, '{broken', { mode: 0o600 });

    await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationBusyError);
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('{broken');
  });

  it('serializes reverse-order requests without deadlock', async () => {
    const root = await makeRoot();
    const leftStore = path.join(root, 'left-store');
    const rightStore = path.join(root, 'right-store');
    const leftHome = path.join(root, 'left-home');
    const rightHome = path.join(root, 'right-home');
    await fs.mkdir(leftStore);
    await fs.mkdir(rightStore);
    await fs.mkdir(leftHome);
    await fs.mkdir(rightHome);
    const first = localStateRelocation.acquire({
      productId: 'product',
      sourceStoreDir: leftStore,
      sourceHostStorageRoot: leftHome,
      destinationStoreDir: rightStore,
      destinationHostStorageRoot: rightHome,
    });
    const second = localStateRelocation.acquire({
      productId: 'product',
      sourceStoreDir: rightStore,
      sourceHostStorageRoot: rightHome,
      destinationStoreDir: leftStore,
      destinationHostStorageRoot: leftHome,
    });
    const settled = await Promise.allSettled([first, second]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof localStateRelocation.acquire>>> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(LocalStateRelocationBusyError);
    await fulfilled[0]!.value.release();
  });

  it('refuses a symlink alias in every requested root before destination effects', async () => {
    const pathFields = [
      'sourceStoreDir',
      'sourceHostStorageRoot',
      'destinationStoreDir',
      'destinationHostStorageRoot',
    ] as const;

    for (const pathField of pathFields) {
      const root = await makeRoot();
      const input = relocationInput(root);
      const realTarget = path.join(root, `${pathField}-real`);
      const alias = path.join(root, `${pathField}-alias`);
      await fs.mkdir(realTarget);
      await fs.symlink(realTarget, alias, 'dir');

      await expect(localStateRelocation.acquire({ ...input, [pathField]: alias }))
        .rejects.toBeInstanceOf(LocalStateRelocationIntegrityError);
      if (pathField !== 'destinationStoreDir') {
        await expect(fs.lstat(input.destinationStoreDir)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      if (pathField !== 'destinationHostStorageRoot') {
        await expect(fs.lstat(input.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
  });
});
