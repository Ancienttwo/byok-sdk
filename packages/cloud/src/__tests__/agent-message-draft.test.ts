import { createMutableClock } from '@byok-sdk/core';
import { createEnvelope, AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, TENANT_A, TENANT_B } from './support/harness';

const taskId = 'draft-readback';
const agentRef = { agentId: 'draft-readback-agent', profileRevision: '1' };
async function setup() {
  const clock = createMutableClock();
  const h = createHarness({ clock, agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const device = await h.pairDevice(TENANT_A);
  await h.stores.tasks.reserveAgentOffer(TENANT_A, { taskId, deviceId: device.deviceId, agentRef });
  await h.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: ['agent-message-egress'] });
  await h.stores.receipts.record(TENANT_A, { key: `agent-message-offer:${device.deviceId}:${taskId}`,
    body: JSON.stringify({ agentRef, requirement: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: 16 },
      context: { destinationBinding: 'chat' } }) });
  const bound = tenantStoresFor({ kind: 'control-plane', tenantId: TENANT_A, operatorId: 'test' },
    { core: h.core, cloud: h.stores, mailboxWake: h.mailboxWake });
  const frame = (text: string, offset = 0, revision = 1) => createEnvelope('agent.message.draft', { agentRef, revision, offset, text }, { taskId });
  const send = (message: Parameters<typeof handleInboundEnvelope>[2]) => handleInboundEnvelope(bound, device.deviceId, message, undefined,
    { consume: async () => ({ outcome: 'accepted' }) }, undefined, clock.now().toISOString());
  const read = (cursor?: { revision: number; offset: number }) => h.cloud.readTaskAgentMessageDraft(TENANT_A, device.deviceId, taskId, agentRef, cursor);
  return { h, clock, device, frame, send, read, bound };
}

describe('cloud Agent message draft readback', () => {
  it('returns open with no row, exact byte suffixes and full revision replacements', async () => {
    const { h, device, frame, send, read } = await setup();
    expect(await read({ revision: 0, offset: 9 })).toEqual({ revision: 0, offset: 0, text: '', byteCount: 0, state: 'open' });
    await send(frame('你好!'));
    expect(await read({ revision: 1, offset: 6 })).toEqual({ revision: 1, offset: 6, text: '!', byteCount: 7, state: 'open' });
    expect(await read({ revision: 0, offset: 6 })).toEqual({ revision: 1, offset: 0, text: '你好!', byteCount: 7, state: 'open' });
    await expect(read({ revision: 1, offset: 1 })).rejects.toThrow();
    expect(await h.cloud.readTaskAgentMessageDraft(TENANT_B, device.deviceId, taskId, agentRef)).toBeUndefined();
    expect(await h.cloud.readTaskAgentMessageDraft(TENANT_A, 'wrong', taskId, agentRef)).toBeUndefined();
    expect(await h.cloud.readTaskAgentMessageDraft(TENANT_A, device.deviceId, taskId, { ...agentRef, profileRevision: '2' })).toBeUndefined();
  });
  it('preserves a leading UTF-8 BOM in a suffix at byte zero', async () => {
    const { frame, send, read } = await setup();
    await send(frame('\uFEFFok'));
    expect(await read({ revision: 1, offset: 0 })).toMatchObject({ text: '\uFEFFok', byteCount: 5 });
  });
  it('refuses absent message requirements and over-cap frames at the direct inbound boundary', async () => {
    const { h, device, frame, send } = await setup();
    const valid = frame('valid');
    expect(await send({ ...valid, payload: { ...valid.payload, text: 'x'.repeat(AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES + 1) } }))
      .toEqual({ outcome: 'rejected', reason: 'agent_message_draft_invalid' });
    const otherTask = 'no-message-requirement';
    await h.stores.tasks.reserveAgentOffer(TENANT_A, { taskId: otherTask, deviceId: device.deviceId, agentRef });
    expect(await send({ ...valid, task_id: otherTask })).toEqual({ outcome: 'rejected', reason: 'agent_message_draft_invalid' });
    expect(await h.stores.agentMessageDraft.read(TENANT_A, taskId)).toBeUndefined();
  });
  it('uses the frozen total limit and accepts gap/stale/overflow observations', async () => {
    const { frame, send, read } = await setup();
    expect(await send(frame('1234567890123456'))).toEqual({ outcome: 'accepted' });
    expect(await send(frame('retry'))).toEqual({ outcome: 'accepted' });
    expect(await send(frame('x', 16))).toEqual({ outcome: 'accepted' });
    expect(await read()).toMatchObject({ text: '1234567890123456', byteCount: 16, state: 'overflow' });
    expect(await send(frame('new', 0, 2))).toEqual({ outcome: 'accepted' });
    expect(await send(frame('gap', 4, 2))).toEqual({ outcome: 'accepted' });
    expect(await read()).toMatchObject({ revision: 2, text: 'new', byteCount: 3, state: 'gap' });
  });
  it('keeps published state above a later device terminal after row deletion', async () => {
    const { frame, send, read, h } = await setup();
    await send(frame('hello'));
    const published = createEnvelope('agent.message.publish', { agentRef, sessionRef: 'session', contract: 'draft.v1',
      messageId: '10000000-0000-4000-8000-000000000510', cursor: 1, contentType: 'text/plain', body: 'hello', byteCount: 5,
      contentHash: `sha256:${'a'.repeat(64)}` }, { taskId });
    expect(await send(published)).toEqual({ outcome: 'accepted' });
    expect(await read()).toMatchObject({ state: 'ended', text: 'hello' });
    expect(await send(createEnvelope('task.complete', { agentRef, summary: 'done', sessionRef: 'session' }, { taskId }))).toEqual({ outcome: 'accepted' });
    expect(await h.stores.agentMessageDraft.read(TENANT_A, taskId)).toBeUndefined();
    expect(await read()).toEqual({ revision: 0, offset: 0, text: '', byteCount: 0, state: 'ended' });
  });
  it('removes an apply that races a device terminal', async () => {
    const { frame, send, read, h } = await setup();
    const store = h.stores.agentMessageDraft;
    const original = store.apply.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.spyOn(store, 'apply').mockImplementation(async (...args) => { entered(); await resume; return original(...args); });
    try {
      const late = send(frame('late'));
      await blocked;
      await send(createEnvelope('task.cancelled', { agentRef }, { taskId }));
      release();
      expect(await late).toEqual({ outcome: 'accepted' });
      expect(await store.read(TENANT_A, taskId)).toBeUndefined();
      expect(await read()).toMatchObject({ state: 'discarded', text: '' });
    } finally { release(); apply.mockRestore(); }
  });
});
