import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { createModels } from '@earendil-works/pi-ai/models';
import { openDurableEngine } from '../adapters/pi-durable/engine';
import { acquireReplicaLock, admitReplica } from '../adapters/pi-durable/replica';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('injects native Storage only after acquiring the existing lock and resetting the admitted replica', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-storage-seam-')); roots.push(root);
  const canonicalHome = path.join(root, 'home'); await mkdir(canonicalHome);
  const binding = { agentRef: { tenantId: 'tenant', agentId: 'agent', profileRevision: 'rev' }, taskId: 'task', leaseId: 'lease', canonicalHome };
  const replicaRoot = path.join(root, 'store');
  const file = await admitReplica(replicaRoot, binding);
  expect(path.basename(file)).toBe('durable-task.sqlite');
  await writeFile(file, 'stale replica');
  let opened = 0;
  const engine = await openDurableEngine({
    file, replicaRoot, binding, models: createModels(), model: { provider: 'test', modelId: 'test' }, instruction: '', resume: false, ambient: {},
    beforeTool: async () => {}, events: async () => {}, result: async () => {},
    storageFactory: async location => {
      opened++; expect(location).toBe(file);
      await expect(readFile(file)).rejects.toThrow('ENOENT');
      await expect(acquireReplicaLock(file, 'other')).rejects.toThrow('locked or invalid');
      return new MemoryStorage();
    },
  });
  await engine.close();
  expect(opened).toBe(1);
  const lock = await acquireReplicaLock(file, 'after-close'); lock.release();
});
