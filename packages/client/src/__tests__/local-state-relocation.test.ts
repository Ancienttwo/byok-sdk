import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentHomeBusyError,
  AgentHomeManager,
  LocalStateRelocationBusyError,
  LocalStateRelocationIntegrityError,
  localStateRelocation,
} from '../index';
import { acquireDaemonOwner, DaemonOwnerActiveError } from '../util/daemon-owner';
import { claimServiceLifecycleOwner, releaseServiceLifecycleOwner, ServiceUnitError } from '../lifecycle/service-unit';
import * as mutationGate from '../util/path-mutation-gate';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

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

useInProcessServiceLifecycleGate();

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

  it('takes service-lifecycle once and before any store gate, and holds it until release (#1097)', async () => {
    const root = await makeRoot();
    const input = relocationInput(root);
    const storeGates = vi.spyOn(mutationGate, 'acquirePathMutationGates');
    const ownerBusy = async () => {
      const claimed = await claimServiceLifecycleOwner({ storeDir: input.sourceStoreDir, owner: 'cli', service: 'acme' })
        .then(() => 'claimed', (error: unknown) => (error instanceof ServiceUnitError ? error.code : String(error)));
      if (claimed === 'claimed') await releaseServiceLifecycleOwner({ storeDir: input.sourceStoreDir, owner: 'cli' });
      return claimed;
    };

    // A lifecycle operation in progress: relocation is busy before any store gate.
    const lifecycle = await mutationGate.acquirePathMutationGate({ scope: 'service-lifecycle' });
    await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationBusyError);
    expect(storeGates).not.toHaveBeenCalled();
    await lifecycle.release();

    // A held store gate: relocation is busy and has given service-lifecycle back.
    const store = await mutationGate.acquirePathMutationGate({ scope: 'store', targetPath: input.sourceStoreDir });
    await expect(localStateRelocation.acquire(input)).rejects.toBeInstanceOf(LocalStateRelocationBusyError);
    expect(storeGates).toHaveBeenCalledTimes(1);
    await store.release();
    expect(await ownerBusy()).toBe('claimed');

    const relocation = await localStateRelocation.acquire(input);
    expect(await ownerBusy()).toBe('lifecycle_owner_busy');
    await relocation.release();
    expect(await ownerBusy()).toBe('claimed');
  });

  it('a refusal whose gate release fails is an integrity error carrying the refusal and the release failure (#2002)', async () => {
    const input = relocationInput(await makeRoot());
    const fault = new Error('injected release failure');
    const store = await mutationGate.acquirePathMutationGate({ scope: 'store', targetPath: input.sourceStoreDir });
    vi.mocked(mutationGate.acquirePathMutationGate).mockImplementationOnce(async () => ({
      scope: 'service-lifecycle', targetPath: '*', identity: 'service-lifecycle', release: async () => { throw fault; },
    }));
    try {
      const refused = await localStateRelocation.acquire(input).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LocalStateRelocationIntegrityError);
      const [busy, release] = ((refused as Error).cause as AggregateError).errors;
      expect(busy).toBeInstanceOf(mutationGate.PathMutationGateBusyError);
      expect(release).toBe(fault);
    } finally {
      await store.release();
    }
  });

  it('a refusal after every gate is taken keeps the refusal and every release failure, including one that cannot become a string (#2002)', async () => {
    const input = relocationInput(await makeRoot());
    const owner = await acquireDaemonOwner(input.sourceStoreDir, 'daemon');
    const unprintable: unknown = Object.create(null);
    const realGates = mutationGate.acquirePathMutationGates;
    vi.mocked(mutationGate.acquirePathMutationGate).mockImplementationOnce(async () => ({
      scope: 'service-lifecycle', targetPath: '*', identity: 'service-lifecycle', release: async () => { throw unprintable; },
    }));
    const gates = vi.spyOn(mutationGate, 'acquirePathMutationGates').mockImplementationOnce(async (inputs, options) => (await realGates(inputs, options))
      .map((gate, index) => ({ ...gate, release: async () => { await gate.release(); throw new Error(`release ${index} failed`); } })));
    try {
      const refused = await localStateRelocation.acquire(input).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LocalStateRelocationIntegrityError);
      const [refusal, ...failures] = ((refused as Error).cause as AggregateError).errors;
      expect(refusal).toBeInstanceOf(DaemonOwnerActiveError);
      expect(failures).toEqual([new Error('release 3 failed'), new Error('release 2 failed'), new Error('release 1 failed'), new Error('release 0 failed'), unprintable]);
    } finally {
      gates.mockRestore();
      await owner.release();
    }
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

  it.skipIf(process.platform === 'win32')('folds trusted aliases in all four roots into physical lease fields', async () => {
    const root = await makeRoot();
    await fs.chmod(root, 0o700);
    const physical = relocationInput(root);
    const alias = path.join(root, 'alias');
    await fs.symlink(root, alias, 'dir');
    const lease = await localStateRelocation.acquire(relocationInput(alias));
    try {
      expect(lease).toMatchObject(physical);
      await expect(fs.lstat(physical.destinationStoreDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(physical.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await lease.release();
    }
  });

  it('refuses untrusted aliases in every requested root before destination effects', async () => {
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
      await fs.chmod(root, 0o777);

      await expect(localStateRelocation.acquire({ ...input, [pathField]: alias }))
        .rejects.toBeInstanceOf(LocalStateRelocationIntegrityError);
      await expect(localStateRelocation.acquire({ ...input, [pathField]: alias }))
        .rejects.toThrow(process.platform === 'win32' ? `${pathField}: configured path ${alias} passes through` : `${pathField}: configured path`);
      expect(await fs.readdir(realTarget)).toEqual([]);
      if (pathField !== 'destinationStoreDir') {
        await expect(fs.lstat(input.destinationStoreDir)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      if (pathField !== 'destinationHostStorageRoot') {
        await expect(fs.lstat(input.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
  });

  it('refuses lexical dot and traversal segments in every requested root before destination effects', async () => {
    const pathFields = [
      'sourceStoreDir',
      'sourceHostStorageRoot',
      'destinationStoreDir',
      'destinationHostStorageRoot',
    ] as const;

    for (const pathField of pathFields) {
      for (const lexicalSegment of ['.', '..']) {
        const root = await makeRoot();
        const input = relocationInput(root);
        const requested = input[pathField];
        const lexicalPath = [path.dirname(requested), 'intermediate', lexicalSegment, path.basename(requested)]
          .join(path.sep);

        await expect(localStateRelocation.acquire({ ...input, [pathField]: lexicalPath }))
          .rejects.toBeInstanceOf(LocalStateRelocationIntegrityError);
        await expect(fs.lstat(input.destinationStoreDir)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.lstat(input.destinationHostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
  });
});
