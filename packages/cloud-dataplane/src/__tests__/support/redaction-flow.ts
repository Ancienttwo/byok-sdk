/**
 * The hosted task flow that the redaction tests (#654 E5a) run before they
 * redact: pairing, an Agent execution with progress, an Agent message, an
 * artifact blob and the terminal. Every text a task carries holds that task's
 * own canary, so a scan can tell the tasks apart. The device name holds no
 * canary: it belongs to the device, not to a task.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ByokPool } from '../../pool';
import { expect } from 'vitest';
import { createMutableClock, type CoreStores, type TenantId } from '@byok-sdk/core';
import {
  CLOUD_CAPABILITIES,
  createByokCloud,
  createHmacTokenSigner,
  createInProcessMailboxWake,
  createWebCrypto,
  fullCapabilityDeclaration,
  type ByokCloud,
  type TaskRedactionStore,
} from '@byok-sdk/cloud';
import {
  BYOK_BLOBS_PATH,
  BYOK_EVENTS_PATH,
  BYOK_MESSAGES_PATH,
  EventsPollResponseSchema,
  PROTOCOL_VERSION,
  byokBlobFinalizePath,
  createEnvelope,
  type AgentEgressPolicy,
  type AgentRef,
  type Envelope,
} from '@byok-sdk/protocol';
import { createDeviceSimulator } from '../../../../testkit/src/index';
import { createPostgresCloudStores, createPostgresTaskRedactionStore } from '../../stores';
import { createPostgresCoreStores } from '../../stores/core';
import type { ObjectStorageScope } from './dataplane';
import { canaryNeedles, type Needle } from './plaintext-scan';

const PRODUCT_ID = 'task-redaction';
const ORIGIN = 'https://host.invalid';
const MESSAGE_CONTRACT = 'task-redaction.turn.v1';
const SESSION_REF = 'session-task-redaction';
export const AGENT_REF: AgentRef = { agentId: 'redaction-agent', profileRevision: '1' };
const DEVICE_CAPABILITIES = [
  'agent-home-contract',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  'agent-message-egress',
  'terminal-projection-selection',
];
const EGRESS_POLICY: AgentEgressPolicy = {
  policyRevision: 'redaction-policy-1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262_144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4_096, maxPendingBytesPerTenant: 8_192 },
  transfers: {
    workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled',
    artifact: 'disabled',
  },
};

export interface Canary {
  /** Needs no JSON escaping, so it survives every JSON layer. */
  readonly core: string;
  /** The text the flow carries; its JSON-escaped form differs from its UTF-8 form. */
  readonly text: string;
  readonly needles: readonly Needle[];
}

export function createCanary(label: string): Canary {
  const core = `byok654${label}${randomUUID().replaceAll('-', '')}`;
  const text = `${core} "quoted" back\\slash ✓`;
  return { core, text, needles: canaryNeedles(core, text) };
}

export interface RedactionHost {
  readonly cloud: ByokCloud;
  readonly core: CoreStores;
  /** Each body the product consumer received. */
  readonly consumed: string[];
}

/** A Host over the dataplane stores, with the redaction store configured. */
/** `wrapStore` lets a test put a fault in front of the real redaction store. */
export async function composeRedactionHost(
  pool: ByokPool,
  objectStorage: ObjectStorageScope,
  wrapStore: (store: TaskRedactionStore) => TaskRedactionStore = (store) => store,
): Promise<RedactionHost> {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const core = createPostgresCoreStores({ pool, clock, objectStorage: objectStorage.config });
  const stores = await createPostgresCloudStores({ pool, clock, crypto, objectStorage: objectStorage.config });
  const consumed: string[] = [];
  const full = fullCapabilityDeclaration();
  const cloud = createByokCloud({
    mailboxWake: createInProcessMailboxWake(),
    core,
    cloud: stores,
    crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(9), clock),
    clock,
    // An empty poll returns at once, so the device can ack without a hold.
    longPollHoldMs: 0,
    capabilities: {
      ...full,
      capabilities: full.capabilities.filter((capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy),
    },
    agentMessage: {
      consume: async (input) => {
        consumed.push(input.payload.body);
        return { outcome: 'accepted' };
      },
    },
    taskRedactionStore: wrapStore(createPostgresTaskRedactionStore({ pool, clock, objectStorage: objectStorage.config })),
  });
  return { cloud, core, consumed };
}

export interface Device {
  readonly tenant: TenantId;
  readonly deviceId: string;
  send(...messages: Envelope[]): Promise<{ readonly status: number; readonly body: unknown }>;
  /** Reads the next page. The cursor it sends acks every row the device saw before. */
  poll(): Promise<readonly Envelope[]>;
  deviceFetch(path: string, init: RequestInit): Promise<Response>;
}

export async function pairDevice(host: RedactionHost, tenant: TenantId, extraCapabilities: readonly string[] = []): Promise<Device> {
  if ((await host.core.quota.readEntitlement(tenant)) === undefined) {
    await host.core.quota.writeEntitlement(tenant, {
      version: 1n,
      hardLimitBytes: 1_000_000_000n,
      maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n,
      mailboxLimitBytes: 100_000_000n,
      retentionPolicyId: 'test',
    });
  }
  const sim = await createDeviceSimulator({
    baseUrl: ORIGIN,
    fetch: async (input, init) => host.cloud.fetch(new Request(input, init)),
    deviceName: 'redaction device',
  });
  const { code } = await host.cloud.createPairingCode(tenant, { productId: PRODUCT_ID });
  const { deviceId, accessToken } = await sim.pair(code);
  let cursor = 0;
  const device: Device = {
    tenant,
    deviceId,
    async send(...messages) {
      const response = await sim.request({ method: 'POST', path: BYOK_MESSAGES_PATH, body: { messages } });
      return { status: response.status, body: response.body };
    },
    async poll() {
      const response = await sim.request({ method: 'GET', path: `${BYOK_EVENTS_PATH}?cursor=${cursor}` });
      expect(response.status, response.text).toBe(200);
      const page = EventsPollResponseSchema.parse(response.body);
      if (page.events.length > 0) cursor = page.cursor;
      return page.events as Envelope[];
    },
    async deviceFetch(path, init) {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${accessToken}`);
      return host.cloud.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
    },
  };
  const hello = await device.send(createEnvelope('conn.hello', {
    protocolVersions: [PROTOCOL_VERSION],
    capabilities: [...DEVICE_CAPABILITIES, ...extraCapabilities],
    deviceId,
    productId: PRODUCT_ID,
  }));
  expect(hello.status).toBe(200);
  return device;
}

export function executionInput(taskId: string, deviceId: string, instruction: string) {
  return {
    taskId,
    deviceId,
    payload: {
      instruction,
      runtime: 'codex',
      agentRef: AGENT_REF,
      session: { mode: 'fresh' },
      egressPolicy: EGRESS_POLICY,
      terminalProjection: { mode: 'none' },
      messageEgress: { mode: 'required', contract: MESSAGE_CONTRACT, contentType: 'text/markdown', maxBytes: 4_096 },
    },
    agentMessageContext: { destinationBinding: 'conversation/redaction', freshnessCursor: 'turn-1' },
  } as const;
}

export function progressEnvelope(taskId: string, seq: number, text: string): Envelope {
  return createEnvelope('task.progress', {
    seq,
    events: [
      { type: 'progress', text: `progress ${text}` },
      { type: 'tool_result', tool: 'read_file', output: `tool output ${text}` },
    ],
  }, { taskId });
}

export async function publishEnvelope(taskId: string, text: string, messageId: string): Promise<Envelope> {
  const body = `message ${text}`;
  const bytes = Buffer.from(body, 'utf8');
  return createEnvelope('agent.message.publish', {
    agentRef: AGENT_REF,
    sessionRef: SESSION_REF,
    contract: MESSAGE_CONTRACT,
    messageId,
    cursor: 1,
    contentType: 'text/markdown',
    body,
    contentHash: await createWebCrypto().sha256(bytes),
    byteCount: bytes.byteLength,
  }, { taskId });
}

export function completeEnvelope(taskId: string, text: string, artifactRefs: readonly unknown[] = []): Envelope {
  return createEnvelope('task.complete', {
    agentRef: AGENT_REF,
    sessionRef: SESSION_REF,
    summary: `summary ${text}`,
    finalMessage: `final ${text}`,
    document: { note: `document ${text}` },
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
  } as never, { taskId });
}

export interface TaskRun {
  readonly taskId: string;
  readonly messageId: string;
  /** The first artifact's content hash as lowercase hex. */
  readonly artifactHex: string;
  readonly artifacts?: readonly UploadedArtifact[];
}

export interface UploadedArtifact {
  readonly blobId: string;
  readonly ref: unknown;
  readonly hex: string;
}

/** Offer, claim, start, progress and one Agent message. The task is still running. */
export async function startTask(host: RedactionHost, device: Device, taskId: string, canary: Canary): Promise<TaskRun> {
  await host.cloud.submitAgentExecution(device.tenant, executionInput(taskId, device.deviceId, `instruction ${canary.text}`));
  expect((await device.poll()).map((event) => [event.type, event.task_id])).toContainEqual([
    'task.offer',
    taskId,
  ]);
  await expectAccepted(device.send(createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF, runtime: 'codex' }, { taskId })));
  await expectAccepted(device.send(createEnvelope('task.started', {}, { taskId })));
  await expectAccepted(device.send(progressEnvelope(taskId, 1, canary.text)));
  const messageId = randomUUID();
  await expectAccepted(device.send(await publishEnvelope(taskId, canary.text, messageId)));
  expect((await device.poll()).map((event) => event.type)).toEqual(['agent.message.disposition']);
  return { taskId, messageId, artifactHex: '' };
}

function uploadArtifact(device: Device, text: string): Promise<UploadedArtifact> {
  return uploadObject(device, Buffer.from(text, 'utf8'), 'text/plain');
}

/** Uploads and finalizes one blob through the device blob routes. */
export async function uploadObject(device: Device, artifact: Uint8Array, contentType: string): Promise<UploadedArtifact> {
  const artifactHash = await createWebCrypto().sha256(artifact);
  const reservation = randomUUID();
  const created = await device.deviceFetch(BYOK_BLOBS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': reservation },
    body: JSON.stringify({ size: artifact.byteLength, contentType, contentHash: artifactHash }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const { blobId, uploadUrl } = (await created.json()) as { blobId: string; uploadUrl: string };
  const uploaded = await globalThis.fetch(uploadUrl, { method: 'PUT', body: artifact, headers: { 'content-type': contentType } });
  expect(uploaded.ok, await uploaded.text()).toBe(true);
  const finalized = await device.deviceFetch(byokBlobFinalizePath(blobId), {
    method: 'POST',
    headers: { 'idempotency-key': reservation },
  });
  expect(finalized.status, await finalized.text()).toBe(204);
  return {
    blobId,
    ref: { blobId, contentHash: artifactHash, size: artifact.byteLength, contentType },
    hex: artifactHash.slice('sha256:'.length),
  };
}

/**
 * Send the terminal that names the artifacts. A text is uploaded first; an
 * uploaded artifact is named again as it is. The disposition row stays unacked.
 */
export async function completeTask(
  host: RedactionHost,
  device: Device,
  run: TaskRun,
  canary: Canary,
  artifactInputs: readonly (string | UploadedArtifact)[] = [`artifact ${canary.text}\n`],
): Promise<TaskRun> {
  const artifacts: UploadedArtifact[] = [];
  for (const input of artifactInputs) artifacts.push(typeof input === 'string' ? await uploadArtifact(device, input) : input);
  await expectAccepted(device.send(completeEnvelope(run.taskId, canary.text, artifacts.map((artifact) => artifact.ref))));
  await expect(host.cloud.readTaskAttempt(device.tenant, run.taskId)).resolves.toMatchObject({ status: 'complete' });
  return { ...run, artifactHex: artifacts[0]!.hex, artifacts };
}

export async function runTask(
  host: RedactionHost,
  device: Device,
  taskId: string,
  canary: Canary,
  artifactInputs?: readonly (string | UploadedArtifact)[],
): Promise<TaskRun> {
  const run = await completeTask(host, device, await startTask(host, device, taskId, canary), canary, artifactInputs);
  await device.poll();
  return run;
}

async function expectAccepted(sent: Promise<{ readonly status: number; readonly body: unknown }>): Promise<void> {
  const response = await sent;
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body, JSON.stringify(response.body)).toMatchObject({ accepted: 1 });
}
