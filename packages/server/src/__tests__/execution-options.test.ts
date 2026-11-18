import type { Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  INPUT_IMAGES_CAPABILITY,
  TASK_EXECUTION_OPTIONS_CAPABILITY,
  type ExecutionTarget,
  type InputImageBlobRef,
} from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { claimAndStart, connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer,
  TEST_AGENT_DISPATCH, TEST_CLAIMED_EXECUTOR } from './test-support';

const PRODUCT_ID = 'acme';
const RUNTIME: ExecutionTarget = { lane: 'runtime', runtimeId: 'pi' };
const TARGET_OPTIONS = [
  { ...RUNTIME, effort: 'xhigh' },
  { lane: 'harness', harnessId: 'grok', modelId: 'grok-4' },
] satisfies ExecutionTarget[];
const EGRESS = {
  policyRevision: '1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;

describe('embedded execution options and images (#2383)', () => {
  let byok: ByokServer | undefined;
  let server: HttpServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server !== undefined) await stopServer(server);
    server = undefined;
  });

  async function start(capabilities: string[]) {
    const instance = byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 20 });
    const http = await startServer(instance);
    server = http.server;
    const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', ...capabilities],
      harnesses: [{ id: 'grok', capabilities: {} }],
    });
    const input = { ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'inspect this' };
    async function upload(finalize = true): Promise<InputImageBlobRef> {
      const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFJ0AAAAASUVORK5CYII=', 'base64');
      const contentType = 'image/png';
      const declaration = { size: data.length, contentType, contentHash: `sha256:${createHash('sha256').update(data).digest('hex')}` };
      const headers = { authorization: `Bearer ${daemon.accessToken}`, 'idempotency-key': 'input-image' };
      const created = await fetch(`${http.baseUrl}/byok/blobs`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(declaration),
      });
      expect(created.status).toBe(200);
      const { blobId, uploadUrl } = await created.json() as { blobId: string; uploadUrl: string };
      expect((await fetch(new URL(uploadUrl, http.baseUrl), { method: 'PUT', body: data })).status).toBe(204);
      if (finalize) {
        expect((await fetch(`${http.baseUrl}/byok/blobs/${blobId}/finalize`, { method: 'POST', headers })).status).toBe(204);
      }
      return { blob: { ...declaration, blobId }, mediaType: contentType };
    }
    return { instance, daemon, input, upload };
  }

  it.each(TARGET_OPTIONS)('offers the exact target $lane when execution options are advertised', async (target) => {
    const { instance, daemon, input } = await start([TASK_EXECUTION_OPTIONS_CAPABILITY]);
    const { taskId } = await instance.dispatch({ ...input, target });
    expect(await nextEnvelope(daemon)).toMatchObject({ type: 'task.offer', task_id: taskId, payload: { target } });
  });

  it.each(TARGET_OPTIONS)('refuses the $lane target without execution options even with image support', async (target) => {
    const { instance, daemon, input } = await start([INPUT_IMAGES_CAPABILITY]);
    await expect(instance.dispatch({ ...input, taskId: 'unsupported', target }))
      .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining(TASK_EXECUTION_OPTIONS_CAPABILITY) });
    expect(await instance.tasks.attempt('unsupported')).toBeUndefined();
    expect(await daemon.next()).toEqual([]);
  });

  it.each([
    { ...RUNTIME, effort: 'bad effort' },
    { lane: 'harness', harnessId: 'grok', modelId: '' },
  ] satisfies ExecutionTarget[])('rejects malformed execution options on $lane', async (target) => {
    const { instance, input } = await start([TASK_EXECUTION_OPTIONS_CAPABILITY]);
    await expect(instance.dispatch({ ...input, taskId: 'invalid', target })).rejects.toMatchObject({ name: 'ZodError' });
    expect(await instance.tasks.attempt('invalid')).toBeUndefined();
  });

  it.each(['resume', 'egress resume', 'fresh'] as const)('offers committed image refs on %s and excludes them from the task snapshot', async (lane) => {
    const { instance, daemon, input, upload } = await start([
      INPUT_IMAGES_CAPABILITY, 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session',
    ]);
    const images = [await upload()];
    const taskId = 'with-image';
    if (lane === 'fresh') {
      await instance.executions.submit({ taskId, deviceId: input.deviceId, payload: {
        target: input.target, instruction: input.instruction, agentRef: input.agentRef, session: { mode: 'fresh' },
        terminalProjection: { mode: 'none' }, egressPolicy: EGRESS, images,
      } });
    } else {
      await instance.dispatch({ ...input, taskId, images, ...(lane === 'egress resume' ? { egressPolicy: EGRESS } : {}) });
    }
    const offer = await nextEnvelope(daemon);
    expect(offer).toMatchObject({ type: 'task.offer', task_id: taskId });
    expect(offer.payload).toHaveProperty('images', images);
    const snapshot = await instance.tasks.get(taskId);
    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain(images[0]!.blob.blobId);
  });

  it('refuses task images before creating a task if the device lacks the image flag', async () => {
    const { instance, daemon, input, upload } = await start([TASK_EXECUTION_OPTIONS_CAPABILITY]);
    await expect(instance.dispatch({ ...input, taskId: 'unsupported-image', images: [await upload()] }))
      .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining(INPUT_IMAGES_CAPABILITY) });
    expect(await instance.tasks.attempt('unsupported-image')).toBeUndefined();
    expect(await daemon.next()).toEqual([]);
  });

  it('rejects malformed image lists and images whose blobs are not yet committed', async () => {
    const { instance, daemon, input, upload } = await start([INPUT_IMAGES_CAPABILITY]);
    await expect(instance.dispatch({ ...input, taskId: 'empty', images: [] }))
      .rejects.toMatchObject({ name: 'ByokCloudError', code: 'coordination_input_invalid' });
    await expect(instance.dispatch({ ...input, taskId: 'uncommitted', images: [await upload(false)] }))
      .rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect((await instance.tasks.list()).tasks).toEqual([]);
    expect(await daemon.next()).toEqual([]);
  });

  it.each([true, false])('gates steer images on the claiming device advertisement (%s)', async (advertised) => {
    const { instance, daemon, input, upload } = await start(advertised ? [INPUT_IMAGES_CAPABILITY] : []);
    const handle = await instance.dispatch(input);
    expect((await nextEnvelope(daemon)).type).toBe('task.offer');
    await claimAndStart(instance, daemon, handle, TEST_CLAIMED_EXECUTOR, { steer: true, images: true });
    const images = [await upload()];
    if (advertised) {
      const { messageId } = await handle.steer('inspect another image', { images });
      expect(await nextEnvelope(daemon)).toMatchObject({ id: messageId, type: 'task.steer', task_id: handle.taskId,
        payload: { text: 'inspect another image', images } });
    } else {
      await expect(handle.steer('inspect another image', { images }))
        .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining(INPUT_IMAGES_CAPABILITY) });
      const { messageId } = await handle.steer('text still works');
      const [steer] = await daemon.next();
      expect(steer).toMatchObject({ id: messageId, type: 'task.steer' });
      expect(steer?.payload).toEqual({ text: 'text still works' });
    }
  });
});
