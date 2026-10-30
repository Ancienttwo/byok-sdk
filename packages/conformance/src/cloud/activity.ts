import { describe, expect, it } from 'vitest';
import { createByokCloud, createHmacTokenSigner, capabilityDeclarationForPorts, type ActivityStore, type ActivityAppendInput } from '@byok-sdk/cloud';
import { createEnvelope } from '@byok-sdk/protocol';
import { createHarness, grantAgentHome, offerPayload, TEST_AGENT_REF } from '../../../cloud/src/__tests__/support/harness';
import { TENANT_A, sealedOutputMember } from './fixtures';

export interface ActivityCompositionHandle {
  readonly store: ActivityStore;
  advanceTime(ms: number): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
export interface ActivityCompositionFactory { create(): ActivityCompositionHandle | Promise<ActivityCompositionHandle> }
async function withActivityComposition(factory: ActivityCompositionFactory, body: (handle: ActivityCompositionHandle) => Promise<void>): Promise<void> {
  const handle = await factory.create();
  try { await body(handle); } finally { await handle.dispose?.(); }
}
function batch(id: number, extra: Partial<ActivityAppendInput> = {}): ActivityAppendInput {
  return { taskId: 'task', sourceEnvelopeId: `source-${id}`, batchSeq: id, events: [{ type: 'progress', text: `${id}` }], dropped: 0, ttlMs: 600_000, ...extra } as ActivityAppendInput;
}

export function runActivityConformance(name: string, factory: ActivityCompositionFactory): void {
  describe(`activity log conformance [${name}]`, () => {
    it.each([null, 7, {}])('malformed cursor %j is invalid rather than a history gap', async after => {
      await withActivityComposition(factory, async ({ store }) => {
        await store.append(TENANT_A, batch(1));
        await expect(store.read(TENANT_A, 'task', { after: after as never })).rejects.toMatchObject({ code: 'activity_cursor_invalid' });
      });
    });
    it('an admitted empty progress envelope retains its log row and identity', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        // Exercise the same authenticated HTTP admission with each activity adapter.
        const tokenSigner = createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(32)), { now: () => new Date() });
        const base = createHarness({ tokenSigner });
        const cloud = createByokCloud({
          core: base.core, cloud: { ...base.stores, activity: store }, clock: base.clock,
          crypto: base.crypto, tokenSigner, mailboxWake: base.mailboxWake,
          proofReceiptRetention: base.proofReceiptRetention,
          capabilities: capabilityDeclarationForPorts({ blobContentProxy: base.blobContentProxy }),
          blobContentProxy: base.blobContentProxy,
        });
        const harness = { ...base, cloud, async json(path: string, init: RequestInit) {
          const response = await cloud.fetch(new Request(`http://cloud.test${path}`, init));
          return { status: response.status, body: await response.json() };
        } };
        const device = await harness.pairDevice(TENANT_A);
        await grantAgentHome(harness, TENANT_A, device.deviceId);
        const taskId = 'empty-progress';
        await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { taskId, payload: offerPayload('work') });
        const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId });
        const progress = createEnvelope('task.progress', { seq: 1, events: [] }, { taskId });
        const result = await harness.json('/byok/messages', { method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [claim, progress] }) });
        expect(result).toMatchObject({ status: 200, body: { accepted: 2 } });
        const tail = await harness.cloud.readActivity(TENANT_A, taskId);
        expect(tail).toMatchObject({ entries: [{ sourceEnvelopeId: progress.id, kind: 'progress', events: [] }] });
        await harness.json('/byok/messages', { method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [progress] }) });
        expect(await harness.cloud.readActivity(TENANT_A, taskId)).toEqual(tail);
      });
    });

    it('orders envelopes by revision, preserves batch order metadata and resumes after the cursor', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const first = await store.append(TENANT_A, batch(2));
        const second = await store.append(TENANT_A, batch(1));
        expect(second.entries.map(entry => [entry.revision, entry.sourceEnvelopeId])).toEqual([[1, 'source-2'], [2, 'source-1']]);
        expect(second.cursor).toMatchObject({ version: 1, revision: 2, taskId: 'task', tenantId: TENANT_A });
        expect(second.cursor.generation).toBe(first.cursor.generation);
        expect((await store.read(TENANT_A, 'task', { after: first.cursor }))?.entries).toEqual([second.entries[1]]);
        expect((await store.read(TENANT_A, 'task', { after: second.cursor }))?.entries).toEqual([]);
      });
    });
    it('retains complete batches and keeps producer loss separate from entry eviction', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const first = await store.append(TENANT_A, batch(1, { capacity: 1, dropped: 4, events: [{ type: 'progress', text: 'a' }, { type: 'future_observation', value: 7 }, { type: 'turn_end' }] }));
        expect(first.entries).toHaveLength(1);
        expect(first.entries[0]).toMatchObject({ kind: 'progress', events: [{ type: 'progress', text: 'a' }, { type: 'future_observation', value: 7 }, { type: 'turn_end' }] });
        const second = await store.append(TENANT_A, batch(2, { capacity: 1 }));
        expect(second).toMatchObject({ floor: 1, dropped: 1, sourceDropped: 4 });
        expect(second.entries).toHaveLength(1);
      });
    });
    it('does not lose concurrently admitted batches', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        await Promise.all(Array.from({ length: 100 }, (_, i) => store.append(TENANT_A, batch(i))));
        const tail = (await store.read(TENANT_A, 'task'))!;
        expect(tail.entries.map(entry => entry.revision)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        expect(new Set(tail.entries.map(entry => entry.sourceEnvelopeId)).size).toBe(100);
      });
    });
    it('preserves idempotency and rejects changed content after payload eviction', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const first = batch(1, { capacity: 1 });
        await store.append(TENANT_A, first);
        const tail = await store.append(TENANT_A, batch(2, { capacity: 1 }));
        expect(await store.append(TENANT_A, first)).toEqual(tail);
        await expect(store.append(TENANT_A, batch(1, { capacity: 1, dropped: 1 }))).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        expect(await store.read(TENANT_A, 'task')).toEqual(tail);
      });
    });
    it('accepts a resealed retry after eviction but refuses a changed comparison projection', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const first = { taskId: 'task', sourceEnvelopeId: 'sealed', batchSeq: 1, sealed: sealedOutputMember(1), dropped: 0, capacity: 1, ttlMs: 600_000 };
        const original = await store.append(TENANT_A, first);
        expect(original.entries[0]).toMatchObject({ kind: 'sealed-progress', sealed: first.sealed });
        const tail = await store.append(TENANT_A, batch(2, { capacity: 1 }));
        expect(await store.append(TENANT_A, { ...first, sealed: sealedOutputMember(2) })).toEqual(tail);
        await expect(store.append(TENANT_A, { ...first, sealed: sealedOutputMember(1, 'c') })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        expect(await store.read(TENANT_A, 'task')).toEqual(tail);
      });
    });
    it('never inactivity-expires and freezes the first terminal deadline', async () => {
      await withActivityComposition(factory, async handle => {
        const first = await handle.store.append(TENANT_A, batch(1));
        await handle.advanceTime(700_000);
        expect(await handle.store.read(TENANT_A, 'task')).toEqual(first);
        // Anchor the terminal at receipt time for deterministic clocks in every adapter.
        const terminalAt = new Date(Date.parse(first.entries[0]!.receivedAt) + 700_000).toISOString();
        const terminal = await handle.store.settle(TENANT_A, 'task', terminalAt);
        expect(terminal.expiresAt).toBe(new Date(Date.parse(terminalAt) + 600_000).toISOString());
        expect(await handle.store.settle(TENANT_A, 'task', new Date(Date.parse(terminalAt) + 1).toISOString())).toEqual(terminal);
        expect(await handle.store.append(TENANT_A, batch(1))).toEqual(terminal);
        await expect(handle.store.append(TENANT_A, batch(2))).rejects.toMatchObject({ code: 'activity_task_settled' });
        await handle.advanceTime(600_000);
        expect(await handle.store.read(TENANT_A, 'task')).toBeUndefined();
        await expect(handle.store.read(TENANT_A, 'task', { after: first.cursor })).rejects.toMatchObject({ code: 'activity_history_gap' });
        await expect(handle.store.append(TENANT_A, batch(2))).rejects.toMatchObject({ code: 'activity_task_settled' });
      });
    });
    it('reports an explicit gap below the floor and rejects foreign/legacy cursors', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const first = await store.append(TENANT_A, batch(1, { capacity: 1 }));
        await store.append(TENANT_A, batch(2, { capacity: 1 }));
        await store.append(TENANT_A, batch(3, { capacity: 1 }));
        await expect(store.read(TENANT_A, 'task', { after: first.cursor })).rejects.toMatchObject({ code: 'activity_history_gap' });
        await expect(store.read(TENANT_A, 'foreign', { after: first.cursor })).rejects.toMatchObject({ code: 'activity_cursor_invalid' });
        await expect(store.read(TENANT_A, 'task', { after: { batchSeq: 1, eventIndex: 0 } as never })).rejects.toMatchObject({ code: 'activity_history_gap' });
      });
    });
    it('validates malformed payloads and fixed bounds before changing history', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const first = await store.append(TENANT_A, batch(1));
        await expect(store.append(TENANT_A, batch(2, { events: [{ type: 'progress' } as never] }))).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        await expect(store.append(TENANT_A, batch(2, { sourceEnvelopeId: ' ' }))).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        await expect(store.append(TENANT_A, batch(2, { capacity: 1001 }))).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        expect(await store.read(TENANT_A, 'task')).toEqual(first);
      });
    });
  });
}
