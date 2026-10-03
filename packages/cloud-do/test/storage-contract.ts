import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { ConversationId, EntryId, Storage } from '@earendil-works/pi-durable';
import { createStorageConformance, type StorageConformanceAssertions, type StorageConformanceCase } from '@earendil-works/pi-durable/testing';

export type StorageFixture = (use: (storage: Storage, reopen: () => Promise<Storage>) => Promise<void>) => Promise<void>;

/** Both backends execute these exact cases, including the complete native pi conformance suite. */
export function createByokStorageContract(withStorage: StorageFixture, assertions: StorageConformanceAssertions): readonly StorageConformanceCase[] {
  return [
    ...createStorageConformance({ withStorage: use => withStorage(storage => use(storage)), assertions }),
    {
      name: 'BYOK sibling execution conversations cannot read each other, including after reopen',
      run: () => withStorage(async (storage, reopen) => {
        const a = await storage.mintId<ConversationId>(), b = await storage.mintId<ConversationId>();
        const entry = await storage.mintId<EntryId>();
        await storage.commit([
          { type: 'conversation', value: { id: a } },
          { type: 'conversation', value: { id: b } },
          { type: 'entry', value: { id: entry, conversationId: a, kind: 'byok.execution', data: { text: 'a only' } } },
        ], ctx);
        assertions.deepEqual((await storage.entry(a, entry, ctx))?.entry.data, { text: 'a only' });
        assertions.strictEqual(await storage.entry(b, entry, ctx), undefined);
        assertions.deepEqual((await storage.scanEntries({ conversationId: b }, 100, undefined, ctx)).items, []);
        const reopened = await reopen();
        assertions.deepEqual((await reopened.entry(a, entry, ctx))?.entry.data, { text: 'a only' });
        assertions.strictEqual(await reopened.entry(b, entry, ctx), undefined);
        assertions.greaterThan(await reopened.mintId(), entry);
        await assertions.rejects(storage.mintId(), 'closed');
      }),
    },
    {
      name: 'BYOK legal 1 MiB pi row and multi-write commit round-trip after reopen',
      run: () => withStorage(async (storage, reopen) => {
        const conversationId = await storage.mintId<ConversationId>();
        const id = await storage.mintId<EntryId>();
        const text = 'x'.repeat(1024 * 1024);
        await storage.commit([
          { type: 'conversation', value: { id: conversationId } },
          { type: 'entry', value: { id, conversationId, kind: 'byok.execution', data: { text } } },
          ...await Promise.all(Array.from({ length: 64 }, async (_, i) => ({
            type: 'entry' as const,
            value: { id: await storage.mintId<EntryId>(), conversationId, kind: 'byok.execution', data: { text: `entry ${i}` } },
          }))),
        ], ctx);
        assertions.deepEqual((await storage.entry(id, ctx))?.entry.data, { text });
        const reopened = await reopen();
        assertions.deepEqual((await reopened.entry(id, ctx))?.entry.data, { text });
        assertions.strictEqual((await reopened.scanEntries({ conversationId }, 100, undefined, ctx)).items.length, 65);
      }),
    },
  ];
}
