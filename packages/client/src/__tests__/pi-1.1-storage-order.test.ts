import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { createExpectAssertions, createStorageConformance, type StorageConformanceProvider } from '@earendil-works/pi-durable/testing';
import { openLocalDurableStorage } from '../adapters/pi-durable/storage';

// Exercise the breaking 1.1 scan contract on the actual backends BYOK uses.
// Other upstream cases are deliberately outside this bounded regression suite.
const backends: Record<string, StorageConformanceProvider> = {
  memory: async use => {
    const storage = new MemoryStorage();
    try { await use(storage); } finally { await storage.close(BACKGROUND_CONTEXT); }
  },
  'node sqlite': async use => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'byok-pi-order-'));
    const storage = await openLocalDurableStorage(path.join(root, 'replica.sqlite'));
    try { await use(storage); } finally { await storage.close(BACKGROUND_CONTEXT); await rm(root, { recursive: true, force: true }); }
  },
};
for (const [name, withStorage] of Object.entries(backends)) describe(`Pi 1.1 ${name} scans`, () => {
  const cases = createStorageConformance({ assertions: createExpectAssertions(expect), withStorage })
    .filter(test => /cursor|order|both directions/.test(test.name));
  it('includes the ordered-scan regressions', () => { expect(cases.length).toBeGreaterThanOrEqual(3); });
  for (const test of cases) it(test.name, () => test.run());
});

it('reads context with a historical cutoff and preserves read-only state across reopen', async () => {
  const { Harness, createRegistry } = await import('@earendil-works/pi-durable');
  const { createModels } = await import('@earendil-works/pi-ai/models');
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'byok-pi-context-'));
  const file = path.join(rootDir, 'replica.sqlite');
  const options = { models: createModels(), registry: createRegistry() };
  let harness = await Harness.open(await openLocalDurableStorage(file), options, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const first = await root.commit(tx => tx.appendEntry(root.id, {
      kind: 'test.input', model: [{ role: 'user', content: 'first', timestamp: 1 }],
    }), BACKGROUND_CONTEXT);
    await root.commit(tx => tx.appendEntry(root.id, {
      kind: 'test.input', model: [{ role: 'user', content: 'second', timestamp: 2 }],
    }), BACKGROUND_CONTEXT);
    const before = await harness.inspect(BACKGROUND_CONTEXT);
    const historical = await root.context(BACKGROUND_CONTEXT, { at: first.id });
    const current = await root.context(BACKGROUND_CONTEXT);
    expect(historical.messages.map(message => message.content)).toEqual(['first']);
    expect(current.messages.map(message => message.content)).toEqual(['first', 'second']);
    expect(await harness.inspect(BACKGROUND_CONTEXT)).toEqual(before);
    expect(before.tasks).toEqual([]);
    await harness.close(BACKGROUND_CONTEXT);
    harness = await Harness.open(await openLocalDurableStorage(file), options, BACKGROUND_CONTEXT);
    const reopened = await harness.root(BACKGROUND_CONTEXT);
    expect((await reopened.context(BACKGROUND_CONTEXT, { at: first.id })).messages).toEqual(historical.messages);
    expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
  } finally { await harness.close(BACKGROUND_CONTEXT); await rm(rootDir, { recursive: true, force: true }); }
});
