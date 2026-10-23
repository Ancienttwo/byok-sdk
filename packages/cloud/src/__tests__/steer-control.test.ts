/**
 * GAP-2: `steerTask` on the hosted kernel, and the ONE fact it is gated on.
 *
 * Only pi's adapter implements steering; Claude's and Codex's throw on
 * receiving `task.steer`, which stalls that device's redelivery cursor at that
 * seq forever. The refusal therefore has to happen server-side, before an
 * envelope exists, from the capability block the CLAIMING adapter reported for
 * itself on its own `task.claim` — snapshotted at the moment ownership was
 * decided (`stores/ports.ts`, `steer-control.ts`).
 *
 * The structural half of this file is the negative direction: cloud DOES keep a
 * connection-level capability snapshot (`DeviceRecord.capabilities`, written by
 * a bearer-authenticated `conn.hello`), and `conn.hello` carries per-runtime
 * `capabilities.steer` too. This suite drives the connection layer and the claim
 * layer to DISAGREE and asserts the claim wins — the same pin the reference
 * server holds in `steer-runtime-capability-gate.test.ts`. If anyone ever wires
 * the device row (or `conn.hello.runtimes`) into the gate, as a source OR as a
 * fallback for an absent snapshot, these go red at the behavior that matters.
 *
 * Every refusal is also asserted to be a NON-EVENT: a rejected steer allocates
 * no mailbox row, so a mistargeted operator click cannot leave a `task.steer`
 * behind for a runtime that would choke on it later.
 */
import { readFileSync } from 'node:fs';

import type { TenantId } from '@byok-sdk/core';
import {
  PROTOCOL_VERSION,
  createEnvelope,
  type RuntimeCapabilities,
  type RuntimeId,
  type TaskSteerSealedPayload,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { isCloudError } from '../errors';
import { handleInboundEnvelope } from '../inbound';
import { SteerRejectedError } from '../steer-control';
import { tenantStoresFor } from '../tenant-stores';
import {
  PRODUCT_ID,
  TENANT_A,
  createHarness,
  decodeEventsPage,
  offerPayload,
  type CloudHarness,
  type DecodedEventsPage,
  type PairedDevice,
} from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: PRODUCT_ID, deviceId } as const;
}

function deviceStores(harness: CloudHarness, device: PairedDevice) {
  return tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
    core: harness.core,
    cloud: harness.stores,
    mailboxWake: harness.mailboxWake,
  });
}

async function poll(harness: CloudHarness, device: PairedDevice, cursor: number): Promise<DecodedEventsPage> {
  const response = await harness.request(`/byok/events?cursor=${cursor}`, {
    headers: device.authorization,
  });
  expect(response.status).toBe(200);
  return decodeEventsPage(await response.json());
}

interface OfferedTask {
  readonly taskId: string;
  /** The delivery seq of the offer — the cursor everything after it is polled from. */
  readonly seq: number;
}

/** An offer this device has actually been handed, so `seq` is a usable cursor. */
async function offered(harness: CloudHarness, device: PairedDevice): Promise<OfferedTask> {
  const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
    payload: offerPayload('steer me'),
  });
  expect((await poll(harness, device, 0)).events.map((event) => event.type)).toEqual(['task.offer']);
  return { taskId: offer.taskId, seq: offer.seq };
}

interface ClaimReport {
  readonly runtime?: RuntimeId;
  readonly capabilities?: RuntimeCapabilities;
}

async function claim(
  harness: CloudHarness,
  device: PairedDevice,
  taskId: string,
  report: ClaimReport,
): Promise<void> {
  expect(
    await handleInboundEnvelope(
      deviceStores(harness, device),
      device.deviceId,
      createEnvelope(
        'task.claim',
        {
          deviceId: device.deviceId,
          ...(report.runtime === undefined ? {} : { runtime: report.runtime }),
          ...(report.capabilities === undefined ? {} : { capabilities: report.capabilities }),
        },
        { taskId },
      ),
    ).then((result) => result.outcome),
  ).toBe('accepted');
}

async function started(harness: CloudHarness, device: PairedDevice, taskId: string): Promise<void> {
  expect(
    await handleInboundEnvelope(
      deviceStores(harness, device),
      device.deviceId,
      createEnvelope('task.started', {}, { taskId }),
    ).then((result) => result.outcome),
  ).toBe('accepted');
}

/** Offer -> claim -> started: a task with a live turn to steer. */
async function running(
  harness: CloudHarness,
  device: PairedDevice,
  report: ClaimReport,
): Promise<OfferedTask> {
  const task = await offered(harness, device);
  await claim(harness, device, task.taskId, report);
  await started(harness, device, task.taskId);
  return task;
}

/**
 * The connection-level declaration cloud actually persists: a bearer-
 * authenticated `conn.hello` whose per-runtime block says `steer: true`. It is
 * the value the gate must NOT be able to fall back to.
 */
async function helloAdvertisingSteer(harness: CloudHarness, device: PairedDevice): Promise<void> {
  expect(
    await handleInboundEnvelope(
      deviceStores(harness, device),
      device.deviceId,
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: ['steer'],
        deviceId: device.deviceId,
        productId: PRODUCT_ID,
        runtimes: [{ id: 'pi', capabilities: { steer: true } }],
      }),
    ).then((result) => result.outcome),
  ).toBe('accepted');
}

async function steerRejection(promise: Promise<unknown>): Promise<SteerRejectedError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(SteerRejectedError);
  return caught as SteerRejectedError;
}

describe('steerTask (GAP-2)', () => {
  it('enqueues exactly one task.steer to the claiming device when the claim reports steer support', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await running(harness, device, { runtime: 'pi', capabilities: { steer: true } });

    const enqueued = await harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' });

    expect(enqueued.envelope.type).toBe('task.steer');
    expect(enqueued.seq).toBeGreaterThan(task.seq);
    const page = await poll(harness, device, task.seq);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      type: 'task.steer',
      task_id: task.taskId,
      payload: { text: 'go left' },
    });
  });

  it('steerSealedTask delivers task.steer_sealed only to a device that advertised sealed-payload-v1, and steerTask refuses sealed fields (#654)', async () => {
    const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8');
    const sealedSteer = corpus.trimEnd().split('\n').map((raw) => JSON.parse(raw) as { type: string; payload: TaskSteerSealedPayload })
      .find((line) => line.type === 'task.steer_sealed')!.payload;
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await running(harness, device, { runtime: 'pi', capabilities: { steer: true } });

    await expect(harness.cloud.steerSealedTask(TENANT_A, task.taskId, sealedSteer)).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining('sealed-payload-v1'),
    });
    expect((await poll(harness, device, task.seq)).events).toEqual([]);

    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: ['sealed-payload-v1'] });
    // The plaintext lane never strips a sealed member or a steer id.
    for (const payload of [{ ...sealedSteer, text: 'plaintext' }, { text: 'plaintext', steerId: sealedSteer.steerId }]) {
      await expect(harness.cloud.steerTask(TENANT_A, task.taskId, payload as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    }
    await expect(harness.cloud.steerSealedTask(TENANT_A, task.taskId, { ...sealedSteer, text: 'plaintext' } as never), 'no plaintext next to the sealed member').rejects.toThrow();
    expect((await poll(harness, device, task.seq)).events).toEqual([]);
    await harness.cloud.steerSealedTask(TENANT_A, task.taskId, sealedSteer);
    const page = await poll(harness, device, task.seq);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ type: 'task.steer_sealed', task_id: task.taskId, payload: sealedSteer });
  });

  it('steerSealedTask refuses a sealed steer by ciphertextRef until the Host retains the blob, and writes no mailbox row (#654)', async () => {
    const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8');
    const byReference = corpus.trimEnd().split('\n').map((raw) => JSON.parse(raw) as { type: string; payload: TaskSteerSealedPayload })
      .find((line) => line.type === 'task.steer_sealed' && 'ciphertextRef' in line.payload.sealed)!.payload;
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await running(harness, device, { runtime: 'pi', capabilities: { steer: true } });
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: ['sealed-payload-v1'] });

    await expect(harness.cloud.steerSealedTask(TENANT_A, task.taskId, byReference)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('refuses a claim that reported steer: false, and allocates no mailbox row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await running(harness, device, {
      runtime: 'claude',
      capabilities: { steer: false },
    });

    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('steer_unsupported_runtime');
    expect(error.runtime).toBe('claude');
    expect(error.status).toBe('running');

    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('refuses a claim that carried no capability block at all: unknown is not supported', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await running(harness, device, { runtime: 'pi' });

    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('steer_unsupported_runtime');
    expect(error.runtime).toBe('pi');

    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('conn.hello advertising steer does not flip a claim that reported steer: false', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await helloAdvertisingSteer(harness, device);
    const task = await running(harness, device, {
      runtime: 'codex',
      capabilities: { steer: false },
    });

    // The connection layer really is offering a `true` to fall back to...
    expect((await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities).toEqual(['steer']);
    // ...and the claim still decides.
    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('steer_unsupported_runtime');
    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('conn.hello advertising steer does not open the gate for a claim that carried nothing', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await helloAdvertisingSteer(harness, device);
    const task = await running(harness, device, { runtime: 'pi' });

    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('steer_unsupported_runtime');
    // Nothing was harvested from the connection into the attempt, either.
    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, task.taskId);
    expect(attempt?.claimedRuntimeCapabilities).toBeUndefined();
    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('refuses an unclaimed offer as task_not_running before the capability gate is reached', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await offered(harness, device);

    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('task_not_running');
    expect(error.status).toBe('offered');
    expect(error.runtime).toBeUndefined();

    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('refuses a claimed-but-not-started task as task_not_running even when the claim reported steer support', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await offered(harness, device);
    await claim(harness, device, task.taskId, { runtime: 'pi', capabilities: { steer: true } });

    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('task_not_running');
    expect(error.status).toBe('claimed');

    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('reports a terminal task as task_terminal, ahead of the running and capability gates', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await running(harness, device, { runtime: 'pi', capabilities: { steer: true } });
    expect(
      await handleInboundEnvelope(
        deviceStores(harness, device),
        device.deviceId,
        createEnvelope(
          'task.complete',
          { summary: 'done', sessionRef: 'session-1' },
          { taskId: task.taskId },
        ),
      ).then((result) => result.outcome),
    ).toBe('accepted');

    const error = await steerRejection(harness.cloud.steerTask(TENANT_A, task.taskId, { text: 'go left' }));
    expect(error.code).toBe('task_terminal');
    expect(error.status).toBe('complete');

    expect((await poll(harness, device, task.seq)).events).toEqual([]);
  });

  it('reports an unknown task as a task_not_found ByokCloudError, not a steer rejection', async () => {
    const harness = createHarness();
    await harness.pairDevice(TENANT_A);

    const caught = await harness.cloud.steerTask(TENANT_A, 'task-nope', { text: 'go left' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isCloudError(caught, 'task_not_found')).toBe(true);
  });
});
