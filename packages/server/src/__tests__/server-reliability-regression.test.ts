import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHmacTokenSigner,
  createInMemoryCloudStores,
  createByokCloud,
  createWebCrypto,
  fullCapabilityDeclaration,
  type ByokCloud,
} from '@byok-sdk/cloud';
import { createInMemoryCoreStores, tenantId, type Clock, type MailboxStore } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { DeviceConnections } from '../connections';
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
} from './test-support';

const PRODUCT_ID = 'server-reliability';
const TENANT = tenantId('server-reliability');

function fixedClock(): Clock {
  return { now: () => new Date('2026-09-05T00:00:00.000Z') };
}

function cloudWithFirstMailboxAppendFailure() {
  const clock = fixedClock();
  const crypto = createWebCrypto();
  const base = createInMemoryCoreStores({ clock }).stores;
  const composition = createInMemoryCloudStores(clock, crypto, base.objects, base.mailbox);
  let fail = true;
  const mailbox: MailboxStore = {
    append: async (tenant, input) => {
      if (fail) {
        fail = false;
        throw new Error('injected mailbox append failure');
      }
      return base.mailbox.append(tenant, input);
    },
    readAfter: (tenant, input) => base.mailbox.readAfter(tenant, input),
    recordDelivery: (tenant, input) => base.mailbox.recordDelivery(tenant, input),
    advanceCursor: (tenant, input) => base.mailbox.advanceCursor(tenant, input),
    readCursor: (tenant, deviceId) => base.mailbox.readCursor(tenant, deviceId),
    collectRetired: (tenant, input) => base.mailbox.collectRetired(tenant, input),
  };
  return {
    cloud: createByokCloud({
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
    byok?.stop();
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

  it('#141 reserves a legacy attempt before mailbox visibility and retries one stable offer only', async () => {
    const { cloud, base } = cloudWithFirstMailboxAppendFailure();
    const taskId = 'task-legacy-retry';
    const input = { taskId, payload: { instruction: 'first body', policy: { mode: 'auto' as const } } };

    await expect(cloud.enqueueOffer(TENANT, 'device-a', input)).rejects.toThrow('injected mailbox append failure');
    expect(await cloud.readTaskAttempt(TENANT, taskId)).toMatchObject({ taskId, deviceId: 'device-a' });

    await expect(
      cloud.enqueueOffer(TENANT, 'device-a', {
        taskId,
        payload: { instruction: 'changed before retry', policy: { mode: 'auto' } },
      }),
    ).rejects.toMatchObject({ code: 'coordination_input_invalid' });

    await cloud.enqueueOffer(TENANT, 'device-a', input);
    await expect(
      cloud.enqueueOffer(TENANT, 'device-a', {
        taskId,
        payload: { instruction: 'changed body', policy: { mode: 'auto' } },
      }),
    ).rejects.toMatchObject({ code: 'coordination_input_invalid' });

    expect((await base.mailbox.readAfter(TENANT, { deviceId: 'device-a', afterSeq: 0 })).messages).toHaveLength(1);
  });

  it('#142 result() returns an already-durable terminal without waiting for a relay notification', async () => {
    const relay = new TaskEventRelay({ connections: new DeviceConnections() });
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
    const relay = new TaskEventRelay({ connections: new DeviceConnections() });
    const taskId = 'task-provisional-terminal';
    relay.provision(taskId);
    relay.onInboundCommitted({
      tenantId: TENANT,
      deviceId: 'device-a',
      envelope: createEnvelope(
        'task.complete',
        { summary: 'completed before enqueue returned', sessionRef: 'session-provisional' },
        { taskId },
      ),
      outcome: 'accepted',
    });
    relay.noteDispatched(taskId, '2026-09-05T00:00:00.000Z');

    const events: unknown[] = [];
    for await (const event of relay.events(taskId)) events.push(event);
    expect(events).toMatchObject([
      { kind: 'state', state: 'Offered' },
      { kind: 'state', state: 'Complete' },
    ]);
    relay.stop();
  });

  it('#143 retries the same host approval outcome and does not enqueue another executable control', async () => {
    const { byok: instance, daemon } = await start();
    const handle = await instance.dispatch({ instruction: 'approval retry' });
    await claimAndStart(instance, daemon, handle);
    await moveToAwaitApproval(instance, daemon, handle, { approvalId: 'approval-retry' });

    await handle.approve({ approvalId: 'approval-retry' });
    await expect(handle.approve({ approvalId: 'approval-retry' })).resolves.toBeUndefined();
    await expect(handle.reject('conflicting decision', { approvalId: 'approval-retry' })).rejects.toMatchObject({
      code: 'coordination_input_invalid',
    });

    const controls = (await daemon.next()).filter((envelope) => envelope.type === 'task.approve' || envelope.type === 'task.reject');
    expect(controls).toHaveLength(1);
    expect(controls[0]?.type).toBe('task.approve');
  });

  it('#144 resolves an id-less pending approval only after a later committed activity', async () => {
    const { byok: instance, daemon } = await start();
    const handle: TaskHandle = await instance.dispatch({ instruction: 'id-less approval' });
    await claimAndStart(instance, daemon, handle);
    await moveToAwaitApproval(instance, daemon, handle);

    await daemon.send(
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'continued after local approval' }] },
        { taskId: handle.taskId },
      ),
    );

    await waitFor(async () => (await instance.tasks.get(handle.taskId))?.state === 'Running', 1_000);
    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Running');
    expect(snapshot?.pendingApprovalId).toBeUndefined();
  });
});
