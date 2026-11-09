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
import { waitForTaskCleanup } from '../../basic/goal-btw.test-support';
import type { ObjectStorageScope } from '../../../packages/cloud-dataplane/src/__tests__/support/dataplane';
import { canaryNeedles, objectLocation, readObjects, record, scanPostgres, type Hits, type Needle } from '../../../packages/cloud-dataplane/src/__tests__/support/plaintext-scan';
import type { SealedMember } from '../../hosted-bot-collaboration/src/e2ee-member.test-support';
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

export async function compareCiphertextInventory(actual: string[]) {
  const doc = await readFile(new URL('../../../docs/security.md', import.meta.url), 'utf8');
  const start = doc.indexOf('<!-- hosted-sealed-inventory:start -->');
  const end = doc.indexOf('<!-- hosted-sealed-inventory:end -->', start);
  assert.ok(start >= 0 && end > start, 'hosted sealed inventory markers missing');
  const expected = doc.slice(start, end).split('\n').filter(line => line.startsWith('| `')).map(line => line.split('`')[1]!);
  assert.ok(expected.length > 0, 'hosted sealed inventory empty');
  const diff = { missing: expected.filter(location => !actual.includes(location)).sort(),
    unexpected: actual.filter(location => !expected.includes(location)).sort() };
  assert.deepEqual(diff, { missing: [], unexpected: [] }, 'hosted sealed ciphertext inventory differs');
  return diff;
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
  async function ciphertextOf(sealed: unknown): Promise<SealedMember & { needle: Needle }> {
    const { ciphertext, ciphertextRef, ...header } = sealed as { ciphertext?: string; ciphertextRef?: { contentHash: string } } & Record<string, unknown>;
    if (ciphertext !== undefined) {
      const text = ciphertext.slice(8, 72);
      return { header, ciphertext: Buffer.from(ciphertext, 'base64url'), needle: { form: 'ciphertext', text, bytes: Buffer.from(text) } };
    }
    assert.ok(ciphertextRef, 'ciphertext reference missing');
    const hash = ciphertextRef.contentHash.slice('sha256:'.length);
    const response = await storage.client.fetch(`${objectStorage.endpoint}/${objectStorage.bucket}/tenants/${tenant}/objects/sha256/${hash}`);
    assert.ok(response.ok, 'ciphertext object unavailable');
    const bytes = Buffer.from(await response.arrayBuffer()), slice = bytes.subarray(16, 64);
    return { header, ciphertext: bytes, needle: { form: 'ciphertext', text: slice.toString('base64url'), bytes: slice } };
  }
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
      session.emit({ type: 'progress', text: `Progress ${text}` });
      await until(async () => (await cloud.readTaskAttempt(tenant, taskId))?.status === 'running' ? true : undefined);
      const steer = `Steer ${text}`;
      if (sealed) {
        const steerId = randomUUID();
        await cloud.steerSealedTask(tenant, taskId, { steerId,
          sealed: await member!.seal('task.steer', { taskId, steerId }, deviceId, payload.agentRef, { text: steer }) });
      } else await cloud.steerTask(tenant, taskId, { text: steer });
      await until(async () => session.steers.includes(steer) ? true : undefined);
      void session.start.approvalChannel!.request(`Approve ${text}`);
      const approvalId = await until(async () => {
        const entry = (await cloud.readApprovalTimeline(tenant, taskId))?.entries.find(entry => entry.event.type === 'approval_requested');
        return (entry?.event as { approvalId: string } | undefined)?.approvalId;
      });
      await cloud.approveTask(tenant, taskId, { approvalId });
      await writeFile(path.join(session.workspaceDir, 'notes.txt'), `${text}${'.'.repeat(70_000)}`);
      session.emit({ type: 'artifact', name: 'notes.txt', contentType: 'text/plain' });
      // Two bounded events make the sealed terminal spill to an object without exceeding the per-event limit.
      session.emit({ type: 'progress', text: `${text}${'.'.repeat(sealed ? 140_000 : 60_000)}` });
      session.emit({ type: 'progress', text: `${text}${'.'.repeat(sealed ? 140_000 : 60_000)}` });
      await session.finish({ text });
      const terminal = await until(async () => (await cloud.readDeviceTerminal(tenant, taskId))?.envelope);
      assert.ok(terminal.type === 'task.complete', 'task did not complete');
      await waitForTaskCleanup(device!.daemon, session);
      return { taskId, agentRef: payload.agentRef, terminal };
    }
    const sealedRun = await run(true, sealedText), plainRun = await run(false, plainText);
    const wire = sealedRun.terminal.payload as { sealed?: Record<string, unknown> };
    assert.ok(wire.sealed, 'sealed terminal missing');
    const terminalMember = await ciphertextOf(wire.sealed);
    assert.ok(JSON.stringify(await member!.open('task.complete', { taskId: sealedRun.taskId }, deviceId, sealedRun.agentRef,
      terminalMember)).includes(sealedText), 'member did not open terminal');
    const offer = await cloud.readTaskOffer(tenant, sealedRun.taskId);
    const steer = await pool.query<{ body: string }>(`SELECT body::text AS body FROM outbox
      WHERE body::text LIKE '%"task.steer"%' AND body::text LIKE $1`, [`%${sealedRun.taskId}%`]);
    assert.ok(steer.rows.length === 1, 'sealed steer missing');
    const activity = (await cloud.readActivity(tenant, sealedRun.taskId))?.entries.filter(entry => 'sealed' in entry) ?? [];
    const approval = (await cloud.readApprovalTimeline(tenant, sealedRun.taskId))?.entries.map(entry => entry.event)
      .filter(event => event.type === 'approval_requested' && 'sealed' in event) ?? [];
    assert.ok(activity.length > 0 && approval.length === 1, 'sealed progress or approval missing');
    // SAFETY: this task was submitted sealed above; the task-offer read union does not retain that narrowing.
    const offerPayload = offer as unknown as { payload: { sealed: unknown } };
    const ciphertextNeedles = (await Promise.all([
      ciphertextOf(offerPayload.payload.sealed),
      ciphertextOf((JSON.parse(steer.rows[0]!.body) as { payload: { sealed: unknown } }).payload.sealed),
      Promise.resolve(terminalMember),
      ...activity.map(entry => ciphertextOf((entry as { sealed: unknown }).sealed)),
      ...approval.map(event => ciphertextOf((event as { sealed: unknown }).sealed)),
    ])).map(member => member.needle);
    await device.close(); device = undefined;
    // Tail must contain both terminal observations before its scan can count as evidence.
    const logs = await until(async () => {
      const text = await config.logs();
      // Tail JSON escapes the observer's compact JSON message. The ids and field names have no escape characters.
      const messages = text.replaceAll('\\"', '"');
      return [sealedRun.taskId, plainRun.taskId].every(id => messages.includes(`"type":"task.complete","taskId":"${id}"`)) ? text : undefined;
    });
    const sealedHits: Hits = new Map(), plainHits: Hits = new Map(), ciphertextHits: Hits = new Map();
    const sealedNeedles = canaryNeedles(sealedText, sealedText), plainNeedles = canaryNeedles(plainText, plainText);
    const tables = await scanPostgres(pool, sealedNeedles, sealedHits);
    await scanPostgres(pool, plainNeedles, plainHits);
    await scanPostgres(pool, ciphertextNeedles, ciphertextHits);
    assert.ok(tables > 20, 'tenant schema scan incomplete');
    const objects = await readObjects(storage);
    for (const [key, value] of objects) {
      const location = objectLocation(key, tenant);
      record(sealedHits, location, value, sealedNeedles);
      record(plainHits, location, value, plainNeedles);
      record(ciphertextHits, location, value, ciphertextNeedles);
    }
    record(sealedHits, 'worker logs', logs, sealedNeedles);
    record(sealedHits, 'node console', nodeLogs(), sealedNeedles);
    assert.ok(sealedHits.size === 0, 'sealed plaintext found');
    assert.ok(plainHits.has('outbox.body') && [...plainHits.keys()].some(location => location.startsWith('r2:')), 'plaintext positive controls missing');
    assert.deepEqual([...ciphertextHits.keys()].filter(location => !plainHits.has(location)), [], 'ciphertext location lacks plaintext positive control');
    const inventoryDiff = await compareCiphertextInventory([...ciphertextHits.keys()]);
    return { tables, objects: objects.size, sealedHits: sealedHits.size, plainLocations: plainHits.size, inventoryDiff,
      memberSha256: createHash('sha256').update(sealedText).digest('hex') };
  } finally {
    try { await device?.close(); } finally { await pool.end(); }
  }
}
