/** Operator-run C1/C3 probe. Uses an existing schema and bucket; never provisions Cloudflare resources. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { tenantId } from '@byok-sdk/cloud';
import { createByokPool, createPostgresCoreStores } from '@byok-sdk/cloud-dataplane';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { ObjectStorageScope } from '../../../packages/cloud-dataplane/src/__tests__/support/dataplane';
import { canaryNeedles, readObjects, record, scanPostgres, type Hits } from '../../../packages/cloud-dataplane/src/__tests__/support/plaintext-scan';
import { CANARY_METHODS, decodeCanaryRpc, encodeCanaryRpc, type CanaryCloud } from '../../hosted-bot-collaboration/src/canary-cloud.test-support';
import { openHostedDevice } from '../../hosted-bot-collaboration/src/hosted-device.test-support';
import { ZeroHitAdapter } from '../../hosted-bot-collaboration/src/zero-hit-runtime.test-support';

export interface CanaryConfig {
  base: string;
  postgresUrl: string;
  adminToken: string;
  storage: Omit<ObjectStorageScope['config'], 'signingClock'>;
  logs(): Promise<string>;
}

/** No base URL means no remote run. All other settings are required once the operator opts in. */
export function remoteCanaryConfig(): CanaryConfig | undefined {
  if (!process.env.BYOK_CANARY_BASE_URL) return undefined;
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the deployed canary`);
    return value;
  };
  try {
    const url = new URL(required('BYOK_CANARY_BASE_URL'));
    assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
    const postgresUrl = required('BYOK_CANARY_POSTGRES_URL');
    assert.ok(['postgres:', 'postgresql:'].includes(new URL(postgresUrl).protocol));
    const storage = JSON.parse(required('BYOK_CANARY_STORAGE')) as CanaryConfig['storage'];
    assert.ok(new URL(storage.endpoint).protocol === 'https:');
    for (const key of ['bucket', 'accessKeyId', 'secretAccessKey', 'region'] as const) assert.ok(typeof storage[key] === 'string' && storage[key].length > 0);
    const tailFile = required('BYOK_CANARY_TAIL_FILE');
    return { base: url.origin, postgresUrl, storage, adminToken: required('HOST_ADMIN_TOKEN'), logs: () => readFile(tailFile, 'utf8') };
  } catch {
    throw new Error('Invalid deployed canary configuration; check the required operator environment variables');
  }
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('canary timed out');
}

export async function runDeployedCanary(config: CanaryConfig, nodeLogs: () => string = () => '') {
  const pool = createByokPool({ connectionString: config.postgresUrl, max: 4 });
  const tenant = tenantId(`canary-${randomUUID()}`), clock = { now: () => new Date() };
  const objectStorage = { ...config.storage, signingClock: clock };
  // Reuse the installed dataplane signer without adding an example dependency.
  const require = createRequire(import.meta.resolve('@byok-sdk/cloud-dataplane'));
  const { AwsClient } = require('aws4fetch') as { AwsClient: new (options: Record<string, unknown>) => ObjectStorageScope['client'] };
  const storage: ObjectStorageScope = { bucket: objectStorage.bucket, config: objectStorage,
    client: new AwsClient({ ...objectStorage, service: 's3', retries: 0 }) };
  const cloud = Object.fromEntries(CANARY_METHODS.map(method => [method, async (...args: unknown[]) => {
    const response = await fetch(`${config.base}/probe/call`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${config.adminToken}` }, body: encodeCanaryRpc({ method, args }) });
    if (!response.ok) throw new Error(`canary RPC: HTTP ${response.status}`);
    return (decodeCanaryRpc(await response.text()) as { value: unknown }).value;
  }])) as CanaryCloud;
  let device: Awaited<ReturnType<typeof openHostedDevice>> | undefined;
  const sealedText = `byok654sealed${randomUUID().replaceAll('-', '')}`, plainText = `byok654plain${randomUUID().replaceAll('-', '')}`;
  try {
    const core = createPostgresCoreStores({ pool, clock, objectStorage });
    await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
    const adapter = new ZeroHitAdapter();
    device = await openHostedDevice(cloud, tenant, config.base, { adapter, objectStorage,
      e2ee: { scopeId: 'scope-zero-hit', categories: ['task-input', 'task-output'] } });
    const { deviceId, member } = device;
    await until(async () => (await cloud.listDevices(tenant)).find(d => d.deviceId === deviceId)?.capabilities?.includes('sealed-payload-v1') ? true : undefined);
    async function run(sealed: boolean, text: string) {
      const taskId = `task-${randomUUID()}`;
      const { payload: { instruction: _instruction, ...payload } } = template(deviceId, `agent-${randomUUID()}`);
      const input = { taskId, deviceId, payload: { ...payload, instruction: text } };
      if (sealed) await cloud.submitSealedAgentExecution(tenant, { ...input, payload: { ...payload,
        terminalProjection: payload.terminalProjection!, sealing: member!.sealing,
        sealed: await member!.seal('task.offer', { taskId }, deviceId, payload.agentRef, { instruction: text }) } });
      else await cloud.submitAgentExecution(tenant, input);
      const session = await until(async () => adapter.sessions.get(taskId));
      assert.ok(session.instruction.includes(text), 'device did not open instruction');
      // Two bounded events make the sealed terminal spill to an object without exceeding the per-event limit.
      session.emit({ type: 'progress', text: `${text}${'.'.repeat(sealed ? 140_000 : 60_000)}` });
      session.emit({ type: 'progress', text: `${text}${'.'.repeat(sealed ? 140_000 : 60_000)}` });
      await writeFile(path.join(session.workspaceDir, 'notes.txt'), `${text}${'.'.repeat(70_000)}`);
      session.emit({ type: 'artifact', name: 'notes.txt', contentType: 'text/plain' });
      await session.finish({ text });
      const terminal = await until(async () => (await cloud.readDeviceTerminal(tenant, taskId))?.envelope);
      assert.ok(terminal.type === 'task.complete', 'task did not complete');
      return { taskId, agentRef: payload.agentRef, terminal };
    }
    const sealedRun = await run(true, sealedText), plainRun = await run(false, plainText);
    const wire = sealedRun.terminal.payload as { sealed?: Record<string, unknown> };
    assert.ok(wire.sealed, 'sealed terminal missing');
    const { ciphertext, ciphertextRef, ...header } = wire.sealed;
    let bytes: Uint8Array;
    if (typeof ciphertext === 'string') bytes = Buffer.from(ciphertext, 'base64url');
    else {
      const hash = (ciphertextRef as { contentHash: string }).contentHash.slice('sha256:'.length);
      const response = await storage.client.fetch(`${objectStorage.endpoint}/${objectStorage.bucket}/tenants/${tenant}/objects/sha256/${hash}`);
      assert.ok(response.ok, 'ciphertext object unavailable');
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    assert.ok(JSON.stringify(await member!.open('task.complete', { taskId: sealedRun.taskId }, deviceId, sealedRun.agentRef,
      { header, ciphertext: bytes })).includes(sealedText), 'member did not open terminal');
    await device.close(); device = undefined;
    // Tail must contain both terminal observations before its scan can count as evidence.
    const logs = await until(async () => {
      const text = await config.logs();
      // Tail JSON escapes the observer's compact JSON message. The ids and field names have no escape characters.
      const messages = text.replaceAll('\\"', '"');
      return [sealedRun.taskId, plainRun.taskId].every(id => messages.includes(`"type":"task.complete","taskId":"${id}"`)) ? text : undefined;
    });
    const sealedHits: Hits = new Map(), plainHits: Hits = new Map();
    const sealedNeedles = canaryNeedles(sealedText, sealedText), plainNeedles = canaryNeedles(plainText, plainText);
    const tables = await scanPostgres(pool, sealedNeedles, sealedHits);
    await scanPostgres(pool, plainNeedles, plainHits);
    assert.ok(tables > 20, 'tenant schema scan incomplete');
    const objects = await readObjects(storage);
    for (const [key, value] of objects) {
      record(sealedHits, `object:${createHash('sha256').update(key).digest('hex')}`, value, sealedNeedles);
      record(plainHits, 'object', value, plainNeedles);
    }
    record(sealedHits, 'worker logs', logs, sealedNeedles);
    record(sealedHits, 'node console', nodeLogs(), sealedNeedles);
    assert.ok(sealedHits.size === 0, 'sealed plaintext found');
    assert.ok(plainHits.has('outbox.body') && plainHits.has('object'), 'plaintext positive controls missing');
    return { tables, objects: objects.size, sealedHits: sealedHits.size, plainLocations: plainHits.size,
      memberSha256: createHash('sha256').update(sealedText).digest('hex') };
  } finally {
    try { await device?.close(); } finally { await pool.end(); }
  }
}
