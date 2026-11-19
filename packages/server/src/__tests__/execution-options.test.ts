import type { Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { contentHash } from '@byok-sdk/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stores from '../stores';
import { isSqliteAvailable } from '../sqlite-support';
import {
  INPUT_IMAGES_CAPABILITY,
  INPUT_IMAGE_MAX_BYTES,
  type ExecutionTarget,
  type InputImageBlobRef,
} from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, type ByokServer, type ByokServerStorage, type UploadInputImage } from '../index';
import { claimAndStart, connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer,
  TEST_AGENT_DISPATCH, TEST_CLAIMED_EXECUTOR } from './test-support';

const PRODUCT_ID = 'acme';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFJ0AAAAASUVORK5CYII=', 'base64');
const IMAGE = { bytes: PNG, contentType: 'image/png' } as const;
const RUNTIME: ExecutionTarget = { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } };
const TARGET_OPTIONS = [
  { ...RUNTIME, effort: 'xhigh' },
  { lane: 'harness', harnessId: 'grok', selection: { mode: 'adapter-model', modelId: 'grok-4' } },
] satisfies ExecutionTarget[];
const EGRESS = {
  policyRevision: '1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;

describe('embedded execution options and images (#2383)', () => {
  let byok: ByokServer | undefined;
  let server: HttpServer | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server !== undefined) await stopServer(server);
    server = undefined;
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function start(capabilities: string[], storage?: ByokServerStorage, executionOptions = true) {
    const instance = byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 20, ...(storage === undefined ? {} : { storage }) });
    const http = await startServer(instance);
    server = http.server;
    const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', ...capabilities],
      harnesses: [
        { id: 'pi', capabilities: { selectionModes: ['device-default'], effort: false } },
        { id: 'claude', capabilities: { selectionModes: ['device-default'], effort: executionOptions } },
        { id: 'grok', capabilities: { selectionModes: executionOptions ? ['device-default', 'adapter-model'] : ['device-default'], effort: false } },
      ],
    });
    const input = { ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'inspect this' };
    async function uploadDeviceBlob(finalize: boolean, data = PNG): Promise<InputImageBlobRef> {
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
    return { instance, daemon, input, uploadDeviceBlob, baseUrl: http.baseUrl,
      upload: () => instance.blobs.uploadInputImage(IMAGE) };
  }

  it.each(TARGET_OPTIONS)('offers the exact target $lane when execution options are advertised', async (target) => {
    const { instance, daemon, input } = await start([]);
    const { taskId } = await instance.dispatch({ ...input, target });
    expect(await nextEnvelope(daemon)).toMatchObject({ type: 'task.offer', task_id: taskId, payload: { target } });
  });

  it.each(TARGET_OPTIONS)('refuses the $lane target without execution options even with image support', async (target) => {
    const { instance, daemon, input } = await start([INPUT_IMAGES_CAPABILITY], undefined, false);
    await expect(instance.dispatch({ ...input, taskId: 'unsupported', target }))
      .rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await instance.tasks.attempt('unsupported')).toBeUndefined();
    expect(await daemon.next()).toEqual([]);
  });

  it.each([
    { ...RUNTIME, effort: 'bad effort' },
    { lane: 'harness', harnessId: 'grok', selection: { mode: 'adapter-model', modelId: '' } },
  ] satisfies ExecutionTarget[])('rejects malformed execution options on $lane', async (target) => {
    const { instance, input } = await start([]);
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
    const { instance, daemon, input, upload } = await start([]);
    await expect(instance.dispatch({ ...input, taskId: 'unsupported-image', images: [await upload()] }))
      .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining(INPUT_IMAGES_CAPABILITY) });
    expect(await instance.tasks.attempt('unsupported-image')).toBeUndefined();
    expect(await daemon.next()).toEqual([]);
  });

  it('rejects malformed image lists and images whose blobs are not yet committed', async () => {
    const { instance, daemon, input, uploadDeviceBlob } = await start([INPUT_IMAGES_CAPABILITY]);
    await expect(instance.dispatch({ ...input, taskId: 'empty', images: [] }))
      .rejects.toMatchObject({ name: 'ByokCloudError', code: 'coordination_input_invalid' });
    await expect(instance.dispatch({ ...input, taskId: 'uncommitted', images: [await uploadDeviceBlob(false)] }))
      .rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect((await instance.tasks.list()).tasks).toEqual([]);
    expect(await daemon.next()).toEqual([]);
  });

  it('reuses concurrent uploads and accounts for one object', async () => {
    const compose = stores.composeFacadeStores;
    let composition!: ReturnType<typeof compose>;
    vi.spyOn(stores, 'composeFacadeStores').mockImplementation(options => (composition = compose(options)));
    const instance = byok = createByokServer({ productId: PRODUCT_ID });
    const [first, second] = await Promise.all([instance.blobs.uploadInputImage(IMAGE), instance.blobs.uploadInputImage(IMAGE)]);
    expect(first).toEqual(second);
    expect(await composition.core.quota.readUsage(stores.serverTenantId(PRODUCT_ID)))
      .toMatchObject({ committedObjectBytes: BigInt(PNG.length), objectCount: 1n, reservedBytes: 0n });
  });

  it('retries lazy uploader initialization after a failed module load', async () => {
    const instance = byok = createByokServer({ productId: PRODUCT_ID });
    vi.doMock('../input-image-upload.js', () => { throw new Error('uploader load failed'); });
    try {
      await expect(instance.blobs.uploadInputImage(IMAGE)).rejects.toMatchObject({ code: 'blob_upload_failed' });
    } finally {
      vi.doUnmock('../input-image-upload.js');
    }
    await expect(instance.blobs.uploadInputImage(IMAGE)).resolves.toMatchObject({ mediaType: 'image/png' });
  });

  it('releases the quota hold on a failed write and permits a retry', async () => {
    const compose = stores.composeFacadeStores;
    let composition!: ReturnType<typeof compose>;
    vi.spyOn(stores, 'composeFacadeStores').mockImplementation(options => (composition = compose(options)));
    const instance = byok = createByokServer({ productId: PRODUCT_ID });
    vi.spyOn(composition.embeddedBlobs, 'writeReserved').mockRejectedValueOnce(new Error('write failed'));
    await expect(instance.blobs.uploadInputImage(IMAGE)).rejects.toMatchObject({ code: 'blob_upload_failed' });
    expect(await composition.core.quota.readUsage(stores.serverTenantId(PRODUCT_ID)))
      .toMatchObject({ reservedBytes: 0n, committedObjectBytes: 0n });
    await expect(instance.blobs.uploadInputImage(IMAGE)).resolves.toHaveProperty('blob.blobId');
  });

  it('refuses to reuse an object pending deletion', async () => {
    const compose = stores.composeFacadeStores;
    let composition!: ReturnType<typeof compose>;
    vi.spyOn(stores, 'composeFacadeStores').mockImplementation(options => (composition = compose(options)));
    const instance = byok = createByokServer({ productId: PRODUCT_ID });
    const image = await instance.blobs.uploadInputImage(IMAGE);
    await composition.core.objects.markDeletePending(stores.serverTenantId(PRODUCT_ID), contentHash(image.blob.contentHash));
    await expect(instance.blobs.uploadInputImage(IMAGE)).rejects.toMatchObject({ code: 'object_state_invalid' });
  });

  it('waits for an in-flight upload while refusing new uploads during close', async () => {
    const compose = stores.composeFacadeStores;
    let ready!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    vi.spyOn(stores, 'composeFacadeStores').mockImplementation(options => {
      const composition = compose(options);
      const sha256 = composition.crypto.sha256.bind(composition.crypto);
      vi.spyOn(composition.crypto, 'sha256').mockImplementation(async bytes => {
        ready();
        await blocked;
        return sha256(bytes);
      });
      return composition;
    });
    const instance = byok = createByokServer({ productId: PRODUCT_ID });
    const upload = instance.blobs.uploadInputImage(IMAGE);
    await started;
    const closed = vi.fn();
    const closing = instance.close().then(closed);
    try {
      await expect(instance.blobs.uploadInputImage(IMAGE)).rejects.toMatchObject({ code: 'server_closed' });
      await new Promise(resolve => setImmediate(resolve));
      expect(closed).not.toHaveBeenCalled();
    } finally { unblock(); }
    await expect(upload).resolves.toMatchObject({ mediaType: 'image/png' });
    await closing;
  });

  it.each([
    { bytes: new Uint8Array(), contentType: 'image/png', code: 'coordination_input_invalid' },
    { bytes: PNG, contentType: 'image/svg+xml', code: 'coordination_input_invalid' },
    { bytes: PNG, contentType: 'image/jpeg', code: 'storage_integrity_mismatch' },
    { bytes: new Uint8Array(INPUT_IMAGE_MAX_BYTES + 1), contentType: 'image/png', code: 'storage_object_too_large' },
  ])('rejects invalid uploads ($contentType, $code)', async ({ code, ...image }) => {
    const instance = byok = createByokServer({ productId: PRODUCT_ID });
    await expect(instance.blobs.uploadInputImage(image as UploadInputImage)).rejects.toMatchObject({ code });
  });

  it('accepts the configured byte ceiling and refuses one byte more', async () => {
    const instance = byok = createByokServer({ productId: PRODUCT_ID, maxBlobSizeBytes: PNG.length });
    await expect(instance.blobs.uploadInputImage(IMAGE)).resolves.toMatchObject({ blob: { size: PNG.length } });
    await expect(instance.blobs.uploadInputImage({ ...IMAGE, bytes: Buffer.concat([PNG, Buffer.alloc(1)]) }))
      .rejects.toMatchObject({ code: 'storage_object_too_large' });
  });

  it('admits device artifact bytes by metadata and refuses a tampered image ref', async () => {
    const { instance, input, uploadDeviceBlob } = await start([INPUT_IMAGES_CAPABILITY]);
    const image = await uploadDeviceBlob(true, Buffer.from('a device artifact with image metadata'));
    await expect(instance.dispatch({ ...input, images: [{ ...image, blob: { ...image.blob, size: 1 } }] }))
      .rejects.toMatchObject({ code: 'coordination_input_invalid' });
    await expect(instance.dispatch({ ...input, images: [image] })).resolves.toHaveProperty('taskId');
  });

  it('refuses a different product’s image ref', async () => {
    const { instance, input } = await start([INPUT_IMAGES_CAPABILITY]);
    const foreign = createByokServer({ productId: 'other-product' });
    try {
      const image = await foreign.blobs.uploadInputImage(IMAGE);
      await expect(instance.dispatch({ ...input, images: [image] })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    } finally { await foreign.close(); }
  });

  const sqliteIt = isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1' ? it : it.skip;
  sqliteIt('commits a detached snapshot to SQLite and lets the paired device download it after reopen', async () => {
    directory = mkdtempSync(join(tmpdir(), 'byok-image-upload-'));
    const storage = { kind: 'sqlite', path: join(directory, 'server.sqlite') } as const;
    const instance = byok = createByokServer({ productId: PRODUCT_ID, storage });
    const view = Buffer.concat([Buffer.from('prefix'), PNG]).subarray(6);
    const upload = instance.blobs.uploadInputImage({ ...IMAGE, bytes: view });
    view.fill(0);
    const image = await upload;
    await instance.close();
    const { instance: reopened, daemon, input, baseUrl } = await start([INPUT_IMAGES_CAPABILITY], storage);
    expect(await reopened.blobs.uploadInputImage(IMAGE)).toEqual(image);
    await reopened.dispatch({ ...input, images: [image] });
    expect((await nextEnvelope(daemon)).payload).toHaveProperty('images', [image]);
    const answer = await fetch(new URL(`/byok/blobs/${image.blob.blobId}/url`, baseUrl), {
      headers: { authorization: `Bearer ${daemon.accessToken}` },
    });
    expect(answer.ok).toBe(true);
    const { downloadUrl } = await answer.json() as { downloadUrl: string };
    expect(Buffer.from(await (await fetch(new URL(downloadUrl, baseUrl))).arrayBuffer())).toEqual(PNG);
  });

  it('refreshes orphan grace on reuse and collects an accepted but unpinned image after it expires', async () => {
    const { instance, input } = await start([INPUT_IMAGES_CAPABILITY]);
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = Date.now();
    const hour = 3_600_000;
    const image = await instance.blobs.uploadInputImage(IMAGE);
    vi.setSystemTime(created + 23 * hour);
    expect(await instance.blobs.uploadInputImage(IMAGE)).toEqual(image);
    vi.setSystemTime(created + 25 * hour);
    await instance.maintenance.runNow();
    expect(await instance.blobs.getDownloadUrl(image.blob.blobId)).toBeDefined();
    vi.setSystemTime(created + 46 * hour);
    await instance.dispatch({ ...input, images: [image] });
    vi.setSystemTime(created + 48 * hour);
    await instance.maintenance.runNow();
    expect(await instance.blobs.getDownloadUrl(image.blob.blobId)).toBeUndefined();
  });

  it.each([true, false])('gates steer images on the claiming device advertisement (%s)', async (advertised) => {
    const { instance, daemon, input, upload } = await start(advertised ? [INPUT_IMAGES_CAPABILITY] : []);
    const handle = await instance.dispatch(input);
    expect((await nextEnvelope(daemon)).type).toBe('task.offer');
    await claimAndStart(instance, daemon, handle, TEST_CLAIMED_EXECUTOR, { steer: true, images: true });
    const images = [await upload()];
    if (advertised) {
      await expect(handle.steer('inspect a wrong image ref', {
        images: images.map(image => ({ ...image, blob: { ...image.blob, size: image.blob.size + 1 } })),
      })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
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
