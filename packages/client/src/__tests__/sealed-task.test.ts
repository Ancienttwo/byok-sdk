/**
 * #654 E3c: every outbound of a task that seals its output goes through one
 * per-task queue, so a plaintext type sent after a sealed one cannot pass it
 * while the sealed one is still being sealed.
 */
import { generateScopeKey } from '@byok-sdk/core/sealed-payload';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { SealedTasks, type SealedScopeKeyring } from '../daemon/sealed-task';

/** A keyring whose sealing key waits for `gate`, so a test can hold a seal open. */
class GatedKeyring implements SealedScopeKeyring {
  readonly scopeKey = generateScopeKey();
  gate: Promise<void> = Promise.resolve();
  async openingKey() { return this.scopeKey; }
  async sealingKey() {
    await this.gate;
    return { scopeKey: this.scopeKey, epoch: 1, sender: 'm'.repeat(43), chainHead: { seq: 1, hash: `sha256:${'0'.repeat(64)}` } };
  }
}

describe('SealedTasks send order (#654 E3c)', () => {
  it('keeps a plaintext outbound behind an earlier sealed outbound of the same task', async () => {
    const keyring = new GatedKeyring();
    const tasks = new SealedTasks({
      keyring, tenantId: 'tenant-test', deviceId: 'dev_1',
      blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
    });
    const opened = await tasks.openOffer(createEnvelope('task.offer_sealed', {
      instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId: 'ordered', seq: 1 }));
    expect(opened.ok).toBe(true);

    let release!: () => void;
    keyring.gate = new Promise<void>((resolve) => { release = resolve; });
    const awaitApproval = createEnvelope('task.await_approval', { summary: 'secret', approvalId: 'a1' }, { taskId: 'ordered' });
    const resolved = createEnvelope('task.approval_resolved', { approvalId: 'a1', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() } as never, { taskId: 'ordered' });
    expect(tasks.sealsOutbound(awaitApproval)).toBe(true);
    expect(tasks.sealsOutbound(resolved)).toBe(true);

    const order: string[] = [];
    const sent = (envelope: Envelope | undefined) => { order.push(envelope!.type); };
    const first = tasks.sealOutbound(awaitApproval).then(sent);
    const second = tasks.sealOutbound(resolved).then(sent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['task.await_approval_sealed', 'task.approval_resolved']);
  });
});
