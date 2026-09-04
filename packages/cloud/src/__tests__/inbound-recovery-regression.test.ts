/**
 * Fault-injected recovery guards for inbound lifecycle envelopes.
 *
 * The transport marker is deliberately made fallible AFTER each authoritative
 * write. A retry of the same envelope must finish the remaining work and only
 * then become a duplicate; it must never be stranded behind an early dedup
 * marker.
 */
import type { TenantId } from '@byok-sdk/core';
import { createEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope, terminalReceiptKey } from '../inbound';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import { TENANT_A, createHarness, offerPayload } from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

function storesFor(harness: ReturnType<typeof createHarness>, deviceId: string): TenantStores {
  return tenantStoresFor(devicePrincipal(TENANT_A, deviceId), {
    core: harness.core,
    cloud: harness.stores,
  });
}

function claim(taskId: string, deviceId: string): Envelope {
  return createEnvelope('task.claim', { deviceId }, { taskId });
}

function complete(taskId: string): Envelope {
  return createEnvelope('task.complete', { summary: 'completed', sessionRef: 'session-recovery' }, { taskId });
}

async function offeredTask() {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  const stores = storesFor(harness, device.deviceId);
  const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
  return { harness, device, stores, taskId: offer.taskId };
}

describe('inbound lifecycle recovery', () => {
  it('completes a claim after its authoritative write succeeds but the delivery faults, then observes only the completed commit', async () => {
    const { harness, device, stores, taskId } = await offeredTask();
    const envelope = claim(taskId, device.deviceId);
    let fault = true;
    const recoveryStores: TenantStores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        claim: async (input) => {
          const claimed = await stores.tasks.claim(input);
          if (fault) {
            fault = false;
            throw new Error('fault after claim');
          }
          return claimed;
        },
      },
    };
    const observed: string[] = [];
    const observer = { onInboundCommitted: ({ envelope: committed }: { readonly envelope: Envelope }) => observed.push(committed.id) };

    await expect(
      handleInboundEnvelope(recoveryStores, device.deviceId, envelope, undefined, undefined, observer),
    ).rejects.toThrow('fault after claim');
    expect(observed).toEqual([]);

    await expect(
      handleInboundEnvelope(recoveryStores, device.deviceId, envelope, undefined, undefined, observer),
    ).resolves.toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('claimed');
    expect(observed).toEqual([envelope.id]);
    await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).resolves.toBe('duplicate');
  });

  it('replays a status write, activity batch, and approval observation after their post-write faults', async () => {
    const { harness, device, stores, taskId } = await offeredTask();
    await handleInboundEnvelope(stores, device.deviceId, claim(taskId, device.deviceId));
    const started = createEnvelope('task.started', {}, { taskId });
    const progress = createEnvelope(
      'task.progress',
      { seq: 1, events: [{ type: 'progress', text: 'recover me' }] },
      { taskId },
    );
    const approval = createEnvelope(
      'task.await_approval',
      { approvalId: 'approval-recovery', summary: 'continue?' },
      { taskId },
    );
    const faults = { status: true, activity: true, approval: true };
    const recoveryStores: TenantStores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        recordStatus: async (input) => {
          const recorded = await stores.tasks.recordStatus(input);
          if (input.status === 'running' && faults.status) {
            faults.status = false;
            throw new Error('fault after status');
          }
          return recorded;
        },
      },
      activity: {
        ...stores.activity,
        append: async (input) => {
          const tail = await stores.activity.append(input);
          if (faults.activity) {
            faults.activity = false;
            throw new Error('fault after activity');
          }
          return tail;
        },
      },
      approvals: {
        ...stores.approvals,
        append: async (input) => {
          const tail = await stores.approvals.append(input);
          if (faults.approval) {
            faults.approval = false;
            throw new Error('fault after approval');
          }
          return tail;
        },
      },
    };

    for (const [envelope, fault] of [
      [started, 'fault after status'],
      [progress, 'fault after activity'],
      [approval, 'fault after approval'],
    ] as const) {
      await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).rejects.toThrow(fault);
      await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).resolves.toBe('accepted');
      await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).resolves.toBe('duplicate');
    }
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('running');
    expect((await harness.cloud.readActivity(TENANT_A, taskId))?.entries).toHaveLength(1);
    expect((await harness.cloud.readApprovalTimeline(TENANT_A, taskId))?.entries).toHaveLength(1);
  });

  it('replays an already-terminalized agent message without invoking its consumer again', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const agentRef = { agentId: 'recovery-agent', profileRevision: 'recovery-profile' } as const;
    await stores.devices.recordCapabilities({
      capabilities: [
        'agent-home-contract',
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        'agent-message-egress',
        'terminal-projection-selection',
      ],
    });
    const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'task-agent-message-recovery',
      payload: {
        instruction: 'send one message',
        policy: { mode: 'auto' },
        agentRef,
        sessionRef: 'recovery-session',
        egressPolicy: {
          policyRevision: 'recovery-policy',
          activity: { mode: 'metadata-status', delivery: 'latest-value' },
          reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
          transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
        },
        messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100 },
        terminalProjection: { mode: 'none' },
      },
      agentMessageContext: { destinationBinding: 'recovery/conversation' },
    });
    const envelope = createEnvelope('agent.message.publish', {
      agentRef,
      sessionRef: 'recovery-session',
      contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000001138',
      cursor: 1,
      contentType: 'text/markdown',
      body: 'recover',
      contentHash: 'sha256:ec3915f542e0f8cb6c1832fbb0389a011fe48b6a82e37f7940e274bf23020776',
      byteCount: 7,
    }, { taskId: offered.taskId });
    let fault = true;
    let consumed = 0;
    const recoveryStores: TenantStores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        finalizeAgentMessage: async (input) => {
          const admission = await stores.tasks.finalizeAgentMessage(input);
          if (fault) {
            fault = false;
            throw new Error('fault after agent message terminal');
          }
          return admission;
        },
      },
    };
    const consume = async () => {
      consumed += 1;
      return { outcome: 'accepted' as const };
    };

    await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope, undefined, consume)).rejects.toThrow(
      'fault after agent message terminal',
    );
    await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope, undefined, consume)).resolves.toBe('accepted');
    expect(consumed).toBe(1);
    await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope, undefined, consume)).resolves.toBe('duplicate');
  });

  it.each(['receipt', 'status', 'board'] as const)(
    'resumes the winning terminal receipt through the %s projection fault',
    async (faultPoint) => {
      const { harness, device, stores, taskId } = await offeredTask();
      await harness.cloud.createBoardItem(TENANT_A, {
        itemId: taskId,
        channel: 'recovery',
        title: 'Terminal recovery',
        status: 'in_progress',
      });
      await handleInboundEnvelope(stores, device.deviceId, claim(taskId, device.deviceId));
      let fault = true;
      const recoveryStores: TenantStores = {
        ...stores,
        receipts: {
          ...stores.receipts,
          record: async (input) => {
            const receipt = await stores.receipts.record(input);
            if (faultPoint === 'receipt' && fault && input.key === terminalReceiptKey(taskId)) {
              fault = false;
              throw new Error('fault after terminal receipt');
            }
            return receipt;
          },
        },
        tasks: {
          ...stores.tasks,
          recordStatus: async (input) => {
            const attempt = await stores.tasks.recordStatus(input);
            if (faultPoint === 'status' && fault && input.status === 'complete') {
              fault = false;
              throw new Error('fault after terminal status');
            }
            return attempt;
          },
        },
        board: {
          ...stores.board,
          updateStatus: async (input) => {
            const item = await stores.board.updateStatus(input);
            if (faultPoint === 'board' && fault) {
              fault = false;
              throw new Error('fault after terminal board');
            }
            return item;
          },
        },
      };
      const envelope = complete(taskId);

      await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).rejects.toThrow(`fault after terminal ${faultPoint}`);
      await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).resolves.toBe('accepted');
      expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('complete');
      await expect(harness.cloud.listBoardItems(TENANT_A, {})).resolves.toMatchObject({
        items: [{ itemId: taskId, status: 'in_review' }],
      });
      await expect(handleInboundEnvelope(recoveryStores, device.deviceId, envelope)).resolves.toBe('duplicate');
    },
  );

  it('projects the exact first terminal binding and rejects unknown terminals before receipts or dedup', async () => {
    const { harness, device, stores, taskId } = await offeredTask();
    await handleInboundEnvelope(stores, device.deviceId, claim(taskId, device.deviceId));
    const winning = complete(taskId);
    await stores.receipts.record({ key: terminalReceiptKey(taskId), body: encodeEnvelope(winning) });
    const losing = createEnvelope('task.fail', { reason: 'must not win' }, { taskId });

    await expect(handleInboundEnvelope(stores, device.deviceId, losing)).resolves.toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('complete');
    expect((await harness.cloud.readTaskResult(TENANT_A, taskId))?.state).toBe('complete');

    let dedupCalls = 0;
    let receiptCalls = 0;
    const guardedStores: TenantStores = {
      ...stores,
      dedup: {
        ...stores.dedup,
        checkAndRecord: async (...input) => {
          dedupCalls += 1;
          return stores.dedup.checkAndRecord(...input);
        },
      },
      receipts: {
        ...stores.receipts,
        record: async (input) => {
          receiptCalls += 1;
          return stores.receipts.record(input);
        },
      },
    };
    const unknownTerminals = [
      createEnvelope('task.complete', { summary: 'unknown', sessionRef: 'unknown-session' }, { taskId: 'task-unknown-complete' }),
      createEnvelope('task.fail', { reason: 'unknown' }, { taskId: 'task-unknown-fail' }),
      createEnvelope('task.cancelled', {}, { taskId: 'task-unknown-cancelled' }),
      createEnvelope('task.decline', { reason: 'unknown' }, { taskId: 'task-unknown-decline' }),
    ];
    for (const terminal of unknownTerminals) {
      await expect(handleInboundEnvelope(guardedStores, device.deviceId, terminal)).resolves.toBe('rejected');
    }
    expect(dedupCalls).toBe(0);
    expect(receiptCalls).toBe(0);
  });
});
