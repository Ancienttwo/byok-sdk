import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const agentRef = { agentId: 'agent-one', profileRevision: '7' } as const;
const requirement = { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 100_000 } as const;

async function open() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-message-outbox-'));
  roots.push(root);
  return { root, outbox: await AgentMessageOutbox.open(root) };
}

describe('AgentMessageOutbox', () => {
  test('stages before session, activates exactly, and only accepted retires', async () => {
    const { root, outbox } = await open();
    const record = await outbox.appendDraft({ taskId: 'task-1', tenantId: 'tenant-one', agentRef, requirement, contentType: 'text/markdown', body: '**hello**', maxPendingEvents: 4, maxPendingBytes: 200_000 });
    expect(record.sessionRef).toBeUndefined();
    const restarted = await AgentMessageOutbox.open(root);
    const active = await restarted.activate('task-1', 'session-1');
    expect(active?.messageId).toBe(record.messageId);
    const payload = restarted.publishPayload(active!);
    const disposition = { ...payload, body: undefined, contentType: undefined, byteCount: undefined, outcome: 'held', receiptId: '11111111-1111-4111-8111-111111111111' };
    const clean = Object.fromEntries(Object.entries(disposition).filter(([, value]) => value !== undefined));
    expect(await restarted.applyDisposition('task-1', clean)).toBe('held');
    expect(restarted.get('task-1')).toBeDefined();
    expect(restarted.retryableRecords()).toHaveLength(0);
    const heldRestart = await AgentMessageOutbox.open(root);
    expect(heldRestart.get('task-1')).toBeDefined();
    expect(heldRestart.retryableRecords()).toHaveLength(0);
    expect(await heldRestart.applyDisposition('task-1', { ...clean, outcome: 'accepted' })).toBe('accepted');
    expect(heldRestart.get('task-1')).toBeUndefined();
  });

  test('same task/body is idempotent while conflicts and wrong session fail closed', async () => {
    const { outbox } = await open();
    const input = { taskId: 'task-1', tenantId: 'tenant-one', agentRef, requirement, contentType: 'text/markdown' as const, body: 'hello', maxPendingEvents: 4, maxPendingBytes: 200_000 };
    const first = await outbox.appendDraft(input);
    expect((await outbox.appendDraft(input)).messageId).toBe(first.messageId);
    await expect(outbox.appendDraft({ ...input, body: 'changed' })).rejects.toThrow(/different immutable draft/);
    await outbox.activate('task-1', 'session-1');
    await expect(outbox.activate('task-1', 'session-2')).rejects.toThrow(/different session/);
  });

  test('restart recovery reopens exact-tenant activated drafts and rejects cross-tenant replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'byok-message-recover-'));
    roots.push(root);
    const agentsRoot = path.join(root, 'agents');
    const home = path.join(agentsRoot, agentRef.agentId);
    await mkdir(home, { recursive: true });
    const outbox = await AgentMessageOutbox.open(home);
    await outbox.appendDraft({ taskId: 'task-recover', tenantId: 'tenant-one', agentRef, requirement, contentType: 'text/markdown', body: 'recover me', maxPendingEvents: 4, maxPendingBytes: 200_000 });
    await outbox.activate('task-recover', 'session-recover');
    const recovered = await AgentMessageOutbox.recover(agentsRoot, 'tenant-one');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.get('task-recover')?.sessionRef).toBe('session-recover');
    await expect(AgentMessageOutbox.recover(agentsRoot, 'tenant-two')).rejects.toThrow(/different authenticated tenant/);
  });
});
