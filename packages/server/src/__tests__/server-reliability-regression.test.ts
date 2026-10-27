import { createInProcessMailboxWake } from '@byok-sdk/cloud';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHmacTokenSigner,
  createInMemoryCloudStores, createInMemoryBlobBytes,
  createByokCloud,
  createWebCrypto,
  fullCapabilityDeclaration,
  type ByokCloud,
} from '@byok-sdk/cloud';
import { createInMemoryCoreStores, tenantId, type Clock, type MailboxStore } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type TaskHandle } from '../index';
import { TaskEventRelay } from '../relay';
import { createTaskHandle } from '../task-handle';
import {
  claimAndStart,
  connectFakeDaemonLongPoll,
  moveToAwaitApproval,
  startServer,
  stopServer,
  waitFor,
  type FakeLongPollDaemon,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
} from './test-support';

const PRODUCT_ID = 'server-reliability';
const TENANT = tenantId('server-reliability');

function fixedClock(): Clock {
  return { now: () => new Date('2026-09-05T00:00:00.000Z') };
}

async function cloudWithFirstMailboxAppendFailure() {
  const clock = fixedClock();
  const crypto = createWebCrypto();
  const objectBytes = createInMemoryBlobBytes(clock, crypto);
  const base = createInMemoryCoreStores({ clock, objectBytes }).stores;
  // A limited append is admitted against the tenant entitlement (#411).
  void base.quota.writeEntitlement(TENANT, {
    version: 1n,
    hardLimitBytes: 1_000_000_000n,
    maxObjectBytes: 100_000_000n,
    maxInlineBytes: 1_000_000n,
    mailboxLimitBytes: 100_000_000n,
    retentionPolicyId: 'test',
  });
  const composition = createInMemoryCloudStores(clock, crypto, base.objects, base.mailbox, objectBytes);
  await composition.stores.devices.register(TENANT, {
    productId: PRODUCT_ID, deviceId: 'device-a', deviceName: 'mailbox-retry-fixture',
    devicePublicKey: 'fixture-key', proofKeyId: 'fixture-proof', proofKeyEpoch: 1,
  });
  await composition.stores.devices.recordCapabilities(TENANT, { deviceId: 'device-a', capabilities: ['agent-home-contract'] });
  let fail = true;
  const mailbox: MailboxStore = {
    append: async (tenant, input) => {
      if (fail) {
        fail = false;
        throw new Error('injected mailbox append failure');
      }
      return base.mailbox.append(tenant, input);
    },
    readUsage: (tenant) => base.mailbox.readUsage(tenant),
    readAfter: (tenant, input) => base.mailbox.readAfter(tenant, input),
    recordDelivery: (tenant, input) => base.mailbox.recordDelivery(tenant, input),
    advanceCursor: (tenant, input) => base.mailbox.advanceCursor(tenant, input),
    readCursor: (tenant, deviceId) => base.mailbox.readCursor(tenant, deviceId),
    collectExpired: (tenant, input) => base.mailbox.collectExpired(tenant, input),
  };
  return {
    cloud: createByokCloud({
        mailboxWake: createInProcessMailboxWake(),
      core: { ...base, mailbox },
      cloud: composition.stores,
      blobContentProxy: composition.blobContentProxy,
      crypto,
      clock,
      tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock),
      capabilities: fullCapabilityDeclaration(),
    }),
    base,
  };
}

describe('issues #141-#144 server reliability regressions', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server !== undefined) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 30 });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    return { byok: instance, daemon };
  }

  it('#141 reserves an Agent attempt before mailbox visibility and retries one stable offer only', async () => {
    const { cloud, base } = await cloudWithFirstMailboxAppendFailure();
    const taskId = 'task-legacy-retry';
    const input = { taskId, payload: { ...TEST_AGENT_DISPATCH, instruction: 'first body' } };

    await expect(cloud.enqueueAgentOffer(TENANT, 'device-a', input)).rejects.toMatchObject({
      code: 'task_offer_append_refused',
      taskId,
      cause: new Error('injected mailbox append failure'),
    });
    expect(await cloud.readTaskAttempt(TENANT, taskId)).toMatchObject({ taskId, deviceId: 'device-a' });

    await expect(
      cloud.enqueueAgentOffer(TENANT, 'device-a', {
        taskId,
        payload: { ...input.payload, instruction: 'changed before retry' },
      }),
    ).rejects.toMatchObject({ code: 'coordination_input_invalid' });

    await cloud.enqueueAgentOffer(TENANT, 'device-a', input);
    await expect(
      cloud.enqueueAgentOffer(TENANT, 'device-a', {
        taskId,
        payload: { ...input.payload, instruction: 'changed body' },
      }),
    ).rejects.toMatchObject({ code: 'agent_task_already_exists' });

    expect((await base.mailbox.readAfter(TENANT, { deviceId: 'device-a', afterSeq: 0 })).messages).toHaveLength(1);
  });

  it('#142 result() returns an already-durable terminal without waiting for a relay notification', async () => {
    const relay = new TaskEventRelay({});
    const handle = createTaskHandle('task-terminal-before-handle', {
      tenant: TENANT,
      cloud: {} as ByokCloud,
      relay,
      readState: async () => 'Complete',
      readResult: async () => ({ state: 'Complete', summary: 'durably complete' }),
    });

    await expect(
      Promise.race([
        handle.result(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('relay liveness wait')), 30)),
      ]),
    ).resolves.toEqual({ state: 'Complete', summary: 'durably complete' });
    relay.stop();
  });

  it('#142 buffers a terminal committed during provisional enqueue and replays it after offer activation', async () => {
    const relay = new TaskEventRelay({});
    const taskId = 'task-provisional-terminal';
    relay.provision(taskId);
    relay.onInboundCommitted({
      tenantId: TENANT,
      deviceId: 'device-a',
      envelope: createEnvelope(
        'task.complete',
        { agentRef: TEST_AGENT_REF, summary: 'completed before enqueue returned', sessionRef: 'session-provisional' },
        { taskId },
      ),
      outcome: 'accepted',
    });
    relay.noteDispatched(taskId, '2026-09-05T00:00:00.000Z');

    const events: unknown[] = [];
    for await (const entry of relay.entries(taskId, relay.feed(taskId)!)) events.push(entry.value);
    expect(events).toMatchObject([
      { kind: 'state', state: 'Offered' },
      { kind: 'state', state: 'Complete' },
    ]);
    relay.stop();
  });

  it('#143 retries the same host rejection payload and does not enqueue another executable control', async () => {
    const { byok: instance, daemon } = await start();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'approval retry' });
    await claimAndStart(instance, daemon, handle);
    await moveToAwaitApproval(instance, daemon, handle, { approvalId: 'approval-retry' });

    await handle.reject('first reason', { approvalId: 'approval-retry' });
    await expect(handle.reject('first reason', { approvalId: 'approval-retry' })).resolves.toBeUndefined();
    await expect(handle.reject('second reason', { approvalId: 'approval-retry' })).rejects.toMatchObject({
      code: 'coordination_input_invalid',
    });

    const controls = (await daemon.next()).filter((envelope) => envelope.type === 'task.approve' || envelope.type === 'task.reject');
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ type: 'task.reject', payload: { approvalId: 'approval-retry', reason: 'first reason' } });
  });
});
