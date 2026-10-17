import { describe, expect, it } from 'vitest';
import { tenantId, type Clock } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { createInMemoryByokCloud, handleInboundEnvelope, tenantStoresFor, DEFAULT_ACTIVITY_TTL_MS,
  type AgentMessageDraftStore, type AgentMessageDraftApplyInput } from '@byok-sdk/cloud';

export interface AgentMessageDraftCompositionHandle {
  readonly store: AgentMessageDraftStore;
  readonly clock: Clock;
  advanceTime(ms: number): void;
  dispose?(): void | Promise<void>;
}
export interface AgentMessageDraftCompositionFactory {
  create(): AgentMessageDraftCompositionHandle | Promise<AgentMessageDraftCompositionHandle>;
}
const tenant = tenantId('draft-tenant');
const other = tenantId('draft-other');
const agentRef = { agentId: 'draft-agent', profileRevision: '1' };
const taskId = 'draft-task';
const deviceId = 'draft-device';
const input = (h: AgentMessageDraftCompositionHandle, changes: Partial<AgentMessageDraftApplyInput> = {}): AgentMessageDraftApplyInput => ({
  taskId, deviceId, agentRef, revision: 1, offset: 0, text: '你好', maxBytes: 16, now: h.clock.now().toISOString(), ...changes,
});

export function runAgentMessageDraftConformance(name: string, factory: AgentMessageDraftCompositionFactory): void {
  const check = (title: string, body: (h: AgentMessageDraftCompositionHandle) => Promise<void>) => it(title, async () => {
    const h = await factory.create();
    try { await body(h); } finally { await h.dispose?.(); }
  });
  describe(`Agent message draft conformance [${name}]`, () => {
    check('appends bytes in order, retries stay stale, and tenants stay isolated', async h => {
      expect(await h.store.apply(tenant, input(h))).toBe('applied');
      const first = await h.store.read(tenant, taskId);
      expect(first).toEqual({ taskId, deviceId, agentRef, revision: 1, text: '你好', byteCount: 6, state: 'open',
        updatedAt: h.clock.now().toISOString(), expiresAt: new Date(h.clock.now().getTime() + DEFAULT_ACTIVITY_TTL_MS).toISOString() });
      h.advanceTime(50);
      expect(await h.store.apply(tenant, input(h))).toBe('stale');
      expect(await h.store.read(tenant, taskId)).toEqual(first);
      expect(await h.store.apply(tenant, input(h, { offset: 6, text: '!' }))).toBe('applied');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ text: '你好!', byteCount: 7, updatedAt: h.clock.now().toISOString() });
      expect(await h.store.read(other, taskId)).toBeUndefined();
      await h.store.delete(other, taskId);
      expect(await h.store.read(tenant, taskId)).toBeDefined();
    });
    check('marks a gap, blocks the same revision, and resets only from offset zero', async h => {
      expect(await h.store.apply(tenant, input(h, { offset: 2 }))).toBe('gap');
      expect(await h.store.read(tenant, taskId)).toBeUndefined();
      await h.store.apply(tenant, input(h));
      expect(await h.store.apply(tenant, input(h, { offset: 7 }))).toBe('gap');
      expect(await h.store.apply(tenant, input(h, { offset: 6 }))).toBe('gap');
      expect(await h.store.apply(tenant, input(h, { offset: 0 }))).toBe('stale');
      expect(await h.store.apply(tenant, input(h, { revision: 2, offset: 1 }))).toBe('gap');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ revision: 1, text: '你好', state: 'gap' });
      expect(await h.store.apply(tenant, input(h, { revision: 2, text: 'new' }))).toBe('applied');
      expect(await h.store.apply(tenant, input(h, { revision: 1, offset: 100 }))).toBe('stale');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ revision: 2, text: 'new', byteCount: 3, state: 'open' });
    });
    check('bounds initial and appended text and honors the overflow marker once', async h => {
      expect(await h.store.apply(tenant, input(h, { maxBytes: 5 }))).toBe('overflow');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ text: '', byteCount: 0, state: 'overflow' });
      expect(await h.store.apply(tenant, input(h, { text: 'x' }))).toBe('overflow');
      expect(await h.store.apply(tenant, input(h, { revision: 2, maxBytes: 6 }))).toBe('applied');
      expect(await h.store.apply(tenant, input(h, { revision: 2, offset: 6, text: 'x', maxBytes: 6 }))).toBe('overflow');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ text: '你好', byteCount: 6, state: 'overflow' });
      expect(await h.store.apply(tenant, input(h, { revision: 3, overflow: true }))).toBe('applied');
      expect(await h.store.apply(tenant, input(h, { revision: 3, offset: 6, text: '' }))).toBe('overflow');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ revision: 3, text: '你好', state: 'overflow' });
    });
    check('refreshes TTL only on apply and sweeps at the expiry boundary', async h => {
      await h.store.apply(tenant, input(h));
      h.advanceTime(DEFAULT_ACTIVITY_TTL_MS - 1);
      await h.store.apply(tenant, input(h, { offset: 6, text: 'x' }));
      const row = await h.store.read(tenant, taskId);
      h.advanceTime(1);
      await h.store.sweepExpired(h.clock.now().toISOString());
      expect(await h.store.read(tenant, taskId)).toEqual(row);
      h.advanceTime(DEFAULT_ACTIVITY_TTL_MS - 1);
      await h.store.sweepExpired(h.clock.now().toISOString());
      expect(await h.store.read(tenant, taskId)).toBeUndefined();
      // Move the read clock back to prove physical deletion, not just read filtering.
      h.advanceTime(-DEFAULT_ACTIVITY_TTL_MS);
      expect(await h.store.read(tenant, taskId)).toBeUndefined();
    });
    check('preserves NUL and escaped text without changing byte offsets', async h => {
      expect(await h.store.apply(tenant, input(h, { text: 'a\0b' }))).toBe('applied');
      expect(await h.store.apply(tenant, input(h, { offset: 3, text: '\\\n"é' }))).toBe('applied');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ text: 'a\0b\\\n"é', byteCount: 8 });
    });
    check('preserves protocol safe integer revisions and treats large offsets as gaps', async h => {
      expect(await h.store.apply(tenant, input(h, { revision: 2 ** 31, offset: Number.MAX_SAFE_INTEGER }))).toBe('gap');
      expect(await h.store.apply(tenant, input(h, { revision: 2 ** 31 }))).toBe('applied');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ revision: 2 ** 31, text: '你好' });
      expect(await h.store.apply(tenant, input(h, { revision: 2 ** 31, offset: Number.MAX_SAFE_INTEGER }))).toBe('gap');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ state: 'gap' });
      expect(await h.store.apply(tenant, input(h, { revision: Number.MAX_SAFE_INTEGER }))).toBe('applied');
      expect(await h.store.read(tenant, taskId)).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, text: '你好', state: 'open' });
    });
    check('serializes concurrent retries without duplicate bytes', async h => {
      const results = await Promise.all(Array.from({ length: 8 }, () => h.store.apply(tenant, input(h))));
      expect(results.filter(result => result === 'applied')).toHaveLength(1);
      expect(results.filter(result => result === 'stale')).toHaveLength(7);
      expect(await h.store.read(tenant, taskId)).toMatchObject({ text: '你好', byteCount: 6 });
      await h.store.delete(tenant, taskId);
      await h.store.delete(tenant, taskId);
      expect(await h.store.read(tenant, taskId)).toBeUndefined();
    });
    for (const type of ['task.complete', 'task.fail', 'task.cancelled', 'task.decline'] as const) {
      check(`deletes on inbound ${type} and rejects a wrong identity`, async h => {
        const base = createInMemoryByokCloud({ clock: h.clock });
        const stores = { ...base.stores, agentMessageDraft: h.store };
        const bound = tenantStoresFor({ kind: 'control-plane', tenantId: tenant, operatorId: 'draft-test' }, { core: base.core, cloud: stores, mailboxWake: base.mailboxWake });
        await stores.tasks.reserveAgentOffer(tenant, { taskId, deviceId, agentRef });
        await stores.receipts.record(tenant, { key: `agent-message-offer:${deviceId}:${taskId}`, body: JSON.stringify({ agentRef,
          requirement: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: 16 }, context: { destinationBinding: 'chat' } }) });
        const frame = createEnvelope('agent.message.draft', { agentRef, revision: 1, offset: 0, text: '你好' }, { taskId });
        expect(await handleInboundEnvelope(bound, 'wrong-device', frame)).toMatchObject({ outcome: 'rejected', reason: 'agent_message_draft_invalid' });
        expect(await h.store.read(tenant, taskId)).toBeUndefined();
        expect(await handleInboundEnvelope(bound, deviceId, frame, undefined, undefined, undefined, h.clock.now().toISOString())).toEqual({ outcome: 'accepted' });
        expect(await h.store.read(tenant, taskId)).toMatchObject({ text: '你好' });
        const terminal = type === 'task.complete' ? createEnvelope(type, { agentRef, summary: 'done', sessionRef: 'session' }, { taskId })
          : type === 'task.cancelled' ? createEnvelope(type, { agentRef }, { taskId })
          : createEnvelope(type, { agentRef, reason: 'stop' }, { taskId });
        expect(await handleInboundEnvelope(bound, deviceId, terminal)).toEqual({ outcome: 'accepted' });
        expect(await h.store.read(tenant, taskId)).toBeUndefined();
        expect(await handleInboundEnvelope(bound, deviceId, frame)).toMatchObject({ outcome: 'rejected', reason: 'agent_message_draft_invalid' });
      });
    }
  });
}
