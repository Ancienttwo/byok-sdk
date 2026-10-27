/**
 * Topology H on a real workerd: one hosted Host, two paired devices.
 *
 * `wrangler dev` (local workerd) serves the `fixtures/h-worker/` Worker, which
 * builds `createByokCloud` per invocation over the
 * `@byok-sdk/cloud-dataplane/runtime` stores, a Hyperdrive binding to this
 * run's own schema in the substrate Postgres, and the per-invocation
 * in-process mailbox wake the README prescribes for Workers. This process
 * plays the devices over real HTTP and the Host's own trigger through the
 * fixture's probe routes.
 *
 * The cases, in order, on shared state:
 *
 * - a. Two devices pair and send `conn.hello`. The Host submits one fresh
 *   Agent execution per device, and each device's long poll returns only its
 *   own offer. A claim on the other device's task is refused.
 * - b. Device A publishes an Agent message; the product consumer gets it once.
 * - c. Device B's consumer commits, then throws. The admission stays pending,
 *   the redelivery calls the consumer again, and the product effect happens
 *   once.
 * - d. Both terminals read back through `readTaskResult` and
 *   `readDeviceTerminal` from fresh invocations.
 * - e. B's observer call fails. The SDK swallows it, so a Durable Object alarm
 *   reads again and settles B's intent.
 *
 * A last case measures the cross-invocation wake latency, the cost of one
 * idle hold at the default `longPollHoldMs`, and the hourly request budget of
 * one idle device. It prints the numbers as one `[topology-h]` log line.
 *
 * Gating is worker-e2e's env pair: `BYOK_TEST_WORKER_DATAPLANE=1` opts in,
 * and `BYOK_REQUIRE_WORKER_DATAPLANE=1` turns an unmet gate into a hard
 * failure at import time, so CI's `dataplane` job can never pass by skipping.
 * This suite needs Postgres only: no H probe touches object storage, so the
 * fixture gets an unreachable S3 endpoint everywhere, and any object access
 * would fail loudly.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, DEFAULT_LONG_POLL_HOLD_MS } from '@byok-sdk/cloud';
import {
  EventsPollResponseSchema,
  PROTOCOL_VERSION,
  createEnvelope,
  type AgentEgressPolicy,
  type AgentMessagePublishPayload,
  type AgentRef,
  type Envelope,
} from '@byok-sdk/protocol';
import { createDeviceSimulator, type DeviceSimulator } from '../../../testkit/src/index';
import { migrate } from '../migrate';
import {
  COMPOSE_COMMAND,
  COMPOSE_POSTGRES_URL,
  POSTGRES_URL,
  POSTGRES_URL_ENV,
  createDataplaneScope,
  type DataplaneScope,
} from './support/dataplane';
import { H_WORKER_DIR, startWranglerDev, type WranglerDev } from './support/wrangler';

const OPT_IN_ENV = 'BYOK_TEST_WORKER_DATAPLANE';
const REQUIRE_ENV = 'BYOK_REQUIRE_WORKER_DATAPLANE';

const SKIP_REASON =
  `${OPT_IN_ENV} is not set (or ${POSTGRES_URL_ENV} is unset), so the Topology H Worker suite is skipped. To run it:\n` +
  `  export ${OPT_IN_ENV}=1\n` +
  `  ${COMPOSE_COMMAND}\n` +
  `  export ${POSTGRES_URL_ENV}=${COMPOSE_POSTGRES_URL}`;

const RUN = process.env[OPT_IN_ENV] === '1' && POSTGRES_URL !== undefined;

if (process.env[REQUIRE_ENV] === '1' && !RUN) {
  // Thrown at import time, as worker-e2e does: a skipped suite reports a pass.
  throw new Error(`${REQUIRE_ENV}=1 but the Topology H Worker gate is unmet.\n${SKIP_REASON}`);
}

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

/** The fixture's fallback (README, Mailbox wake: Workers Hosts use 1 s). */
const WAKE_FALLBACK_MS = 1_000;
/** The daemon's pause after an empty page: `packages/client/src/daemon/long-poll-transport.ts:530`. */
const DAEMON_IDLE_DELAY_MS = 250;
/** `DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS`, `packages/client/src/daemon/presence-publisher.ts:50`. */
const PRESENCE_INTERVAL_MS = 30_000;
/** `RENEW_MARGIN_MS`, `packages/client/src/daemon/auth-manager.ts:83`. */
const RENEW_MARGIN_MS = 60_000;
const LATENCY_SAMPLES = 12;

const PRODUCT_ID = 'byok-h-worker';
const MESSAGE_CONTRACT = 'h-worker.turn.v1';
/** What a daemon that can run fresh, message-egress Agent executions advertises. */
const DEVICE_CAPABILITIES = [
  'agent-home-contract',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  'agent-message-egress',
  'terminal-projection-selection',
];
const EGRESS_POLICY: AgentEgressPolicy = {
  policyRevision: 'h-policy-1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262_144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4_096, maxPendingBytesPerTenant: 8_192 },
  transfers: {
    workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled',
    artifact: 'disabled',
  },
};

interface Device {
  readonly name: string;
  readonly sim: DeviceSimulator;
  readonly deviceId: string;
  readonly agentRef: AgentRef;
  /** The ack the next poll brings back: the cursor of the last non-empty page. */
  cursor: number;
}

interface Exchange {
  readonly status: number;
  readonly body: unknown;
  /** `mailbox.readAfter` calls, SQL statements and injected observer throws of the serving invocation. */
  readonly readAfter: number;
  readonly sql: number;
  readonly observerThrows: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

interface Poll extends Exchange {
  readonly events: readonly Envelope[];
}

interface Intent {
  readonly taskId: string;
  readonly deviceId: string;
  readonly state: 'pending' | 'settled';
  readonly settledBy?: 'observer' | 'alarm';
  readonly terminal?: { readonly state: string; readonly summary?: string; readonly deviceTerminalType?: string };
  readonly settleCount: number;
  readonly ignoredSettles: number;
}

interface Ledger {
  readonly intents: readonly Intent[];
  readonly consumes: readonly {
    readonly deviceId: string;
    readonly taskId: string;
    readonly messageId: string;
    readonly context: unknown;
    readonly calls: number;
    readonly commits: number;
  }[];
  readonly alarmRuns: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBody(text: string): unknown {
  try {
    return text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

describe.skipIf(!RUN)('Topology H on a real workerd: two devices, one hosted Host', () => {
  const tenant = `h-worker-${randomUUID()}`;
  let worker: WranglerDev | undefined;
  /** This run's role and schema. The Worker connects as the same role. */
  let scope: DataplaneScope | undefined;
  let deviceA: Device;
  let deviceB: Device;
  const taskA = `h-task-a-${randomUUID()}`;
  const taskB = `h-task-b-${randomUUID()}`;
  let messageA: AgentMessagePublishPayload;
  let messageB: AgentMessagePublishPayload;

  function base(): string {
    if (worker === undefined) throw new Error('wrangler dev is not running');
    return worker.base;
  }

  async function probe<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${base()}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }

  async function exchange(
    routePath: string,
    init: { readonly method: string; readonly bearer?: string; readonly body?: unknown; readonly fault?: string; readonly timeoutMs?: number },
  ): Promise<Exchange> {
    const headers = new Headers();
    if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.fault !== undefined) headers.set('x-h-fault', init.fault);
    const startedAt = performance.now();
    const response = await fetch(`${base()}${routePath}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: parseBody(text),
      readAfter: Number(response.headers.get('x-h-read-after')),
      sql: Number(response.headers.get('x-h-sql')),
      observerThrows: Number(response.headers.get('x-h-observer-throws')),
      startedAt,
      finishedAt: performance.now(),
    };
  }

  function bearer(device: Device): string {
    const session = device.sim.session;
    if (session === undefined) throw new Error(`device ${device.name} is not paired`);
    return session.accessToken;
  }

  function send(device: Device, messages: readonly Envelope[], fault?: string): Promise<Exchange> {
    return exchange('/byok/messages', {
      method: 'POST',
      bearer: bearer(device),
      body: { messages },
      ...(fault === undefined ? {} : { fault }),
    });
  }

  /** One daemon poll: ack the cursor, wait for events, adopt the new cursor. */
  async function poll(device: Device, timeoutMs = 70_000): Promise<Poll> {
    const result = await exchange(`/byok/events?cursor=${device.cursor}`, {
      method: 'GET',
      bearer: bearer(device),
      timeoutMs,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const page = EventsPollResponseSchema.parse(result.body);
    if (page.events.length > 0) device.cursor = page.cursor;
    return { ...result, events: page.events as Envelope[] };
  }

  async function pairDevice(name: string): Promise<Device> {
    const { code } = await probe<{ code: string }>('/probe/pairing-code', { productId: PRODUCT_ID });
    const sim = await createDeviceSimulator({ baseUrl: base(), deviceName: `h-worker device ${name}` });
    const session = await sim.pair(code);
    const device: Device = {
      name,
      sim,
      deviceId: session.deviceId,
      agentRef: { agentId: `h-agent-${name}`, profileRevision: '1' },
      cursor: 0,
    };
    // The only cloud path that admits capabilities: an authenticated hello.
    const hello = await send(device, [
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: DEVICE_CAPABILITIES,
        deviceId: device.deviceId,
        productId: PRODUCT_ID,
      }),
    ]);
    expect(hello.body).toMatchObject({ accepted: 1 });
    return device;
  }

  /** The Host's persisted input for one fresh execution on `device`. */
  function execution(device: Device, taskId: string, withMessage: boolean) {
    return {
      taskId,
      deviceId: device.deviceId,
      payload: {
        instruction: `h-worker turn for device ${device.name}`,
        runtime: 'codex',
        agentRef: device.agentRef,
        session: { mode: 'fresh' },
        egressPolicy: EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
        ...(withMessage
          ? { messageEgress: { mode: 'required', contract: MESSAGE_CONTRACT, contentType: 'text/markdown', maxBytes: 4_096 } }
          : {}),
      },
      ...(withMessage
        ? { agentMessageContext: { destinationBinding: `conversation/${device.name}`, freshnessCursor: 'turn-1' } }
        : {}),
    };
  }

  function publication(device: Device, body: string): AgentMessagePublishPayload {
    return {
      agentRef: device.agentRef,
      sessionRef: `session-${device.name}`,
      contract: MESSAGE_CONTRACT,
      messageId: randomUUID(),
      cursor: 1,
      contentType: 'text/markdown',
      body,
      contentHash: sha256(body),
      byteCount: Buffer.byteLength(body, 'utf8'),
    };
  }

  function claim(device: Device, taskId: string, agentRef: AgentRef = device.agentRef): Envelope {
    return createEnvelope('task.claim', { deviceId: device.deviceId, agentRef, runtime: 'codex' }, { taskId });
  }

  function intentOf(ledger: Ledger, taskId: string): Intent {
    const intent = ledger.intents.find((candidate) => candidate.taskId === taskId);
    if (intent === undefined) throw new Error(`no product intent for ${taskId}`);
    return intent;
  }

  async function ledgerUntil(predicate: (ledger: Ledger) => boolean, timeoutMs: number): Promise<Ledger> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ledger = await probe<Ledger>('/probe/ledger');
      if (predicate(ledger)) return ledger;
      if (Date.now() > deadline) throw new Error(`product ledger never reached the expected state: ${JSON.stringify(ledger)}`);
      await sleep(100);
    }
  }

  /** The durable admission row: present and terminal-free means pending. */
  async function admission(device: Device, taskId: string) {
    if (scope === undefined) throw new Error('no dataplane scope');
    const result = await scope.pool.query<{ message_id: string; pending: boolean }>(
      `SELECT message_id, terminal_body IS NULL AS pending
         FROM agent_message_admission
        WHERE tenant_id = $1 AND device_id = $2 AND task_id = $3`,
      [tenant, device.deviceId, taskId],
    );
    return result.rows;
  }

  beforeAll(async () => {
    // A schema of its own, not worker-e2e's shared `byok_worker_e2e`:
    // `createPostgresCloudStores` refuses to compose while any pending mailbox
    // row in its schema is not protocol v3, and worker-e2e writes such a row
    // there while vitest runs it in parallel with this file.
    scope = await createDataplaneScope(2);
    // Node migrates; the Worker serves. Both use the scope's role.
    await migrate(scope.pool, DEPLOY_SQL);

    worker = await startWranglerDev(
      H_WORKER_DIR,
      [
        `BYOK_TOKEN_SECRET:${randomBytes(32).toString('hex')}`,
        // Port 9 (discard) refuses connections: object storage is out of scope.
        'BYOK_S3_ENDPOINT:http://127.0.0.1:9',
        'BYOK_S3_BUCKET:byok-h-worker-unused',
        'BYOK_S3_ACCESS_KEY_ID:unused',
        'BYOK_S3_SECRET_ACCESS_KEY:unused',
        'BYOK_S3_REGION:us-east-1',
      ],
      // The fixture's config has no `localConnectionString`; wrangler dev
      // reads the Hyperdrive string for binding BYOK_PG from this variable.
      { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG: scope.connectionString },
    );
    await probe('/probe/tenant');
  }, 180_000);

  afterAll(async () => {
    // workerd's connections close with it, before the scope drops its role.
    await worker?.stop();
    await scope?.dispose();
  }, 30_000);

  it('a: routes each fresh execution to its own device, and only there', async () => {
    deviceA = await pairDevice('a');
    deviceB = await pairDevice('b');

    const offerA = await probe<{ taskId: string; type: string }>('/probe/submit', { input: execution(deviceA, taskA, true) });
    const offerB = await probe<{ taskId: string; type: string }>('/probe/submit', { input: execution(deviceB, taskB, true) });
    expect([offerA, offerB]).toMatchObject([
      { taskId: taskA, type: 'task.offer' },
      { taskId: taskB, type: 'task.offer' },
    ]);

    // Both offers are durable before either device polls, so each page holds
    // everything pending for its device: exactly its own offer.
    const [pageA, pageB] = await Promise.all([poll(deviceA), poll(deviceB)]);
    expect(pageA.events.map((event) => [event.type, event.task_id])).toEqual([
      ['task.offer', taskA],
    ]);
    expect(pageB.events.map((event) => [event.type, event.task_id])).toEqual([
      ['task.offer', taskB],
    ]);
    expect(pageA.events[0]?.payload).toMatchObject({ agentRef: deviceA.agentRef });
    expect(pageB.events[0]?.payload).toMatchObject({ agentRef: deviceB.agentRef });
    // The Host-only destination never reaches a device.
    expect(JSON.stringify([pageA.events, pageB.events])).not.toContain('conversation/');

    // A device cannot take the other device's task, even with its AgentRef.
    const stolen = await send(deviceA, [claim(deviceA, taskB, deviceB.agentRef)]);
    expect(stolen.body).toMatchObject({ accepted: 0, rejected: 1, outcomes: [{ outcome: 'rejected', reason: 'not_permitted' }] });

    expect((await send(deviceA, [claim(deviceA, taskA)])).body).toMatchObject({ accepted: 1 });
    expect((await send(deviceB, [claim(deviceB, taskB)])).body).toMatchObject({ accepted: 1 });
    await expect(probe('/probe/read', { taskId: taskA })).resolves.toMatchObject({
      attempt: { status: 'claimed', deviceId: deviceA.deviceId, ownerDeviceId: deviceA.deviceId },
    });
    await expect(probe('/probe/read', { taskId: taskB })).resolves.toMatchObject({
      attempt: { status: 'claimed', deviceId: deviceB.deviceId, ownerDeviceId: deviceB.deviceId },
    });
  }, 60_000);

  it('b: hands device A\'s Agent message to the product consumer once', async () => {
    messageA = publication(deviceA, 'reply from device a');
    const sent = await send(deviceA, [createEnvelope('agent.message.publish', messageA, { taskId: taskA })]);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ accepted: 1, outcomes: [{ outcome: 'accepted' }] });

    const ledger = await probe<Ledger>('/probe/ledger');
    expect(ledger.consumes).toEqual([
      expect.objectContaining({
        deviceId: deviceA.deviceId,
        taskId: taskA,
        messageId: messageA.messageId,
        // The consumer sees the Host-only context frozen at submit time.
        context: { destinationBinding: 'conversation/a', freshnessCursor: 'turn-1' },
        calls: 1,
        commits: 1,
      }),
    ]);

    // The device learns the decision on its own next poll.
    const next = await poll(deviceA);
    expect(next.events).toEqual([
      expect.objectContaining({
        type: 'agent.message.disposition',
        task_id: taskA,
        payload: expect.objectContaining({ messageId: messageA.messageId, outcome: 'accepted' }),
      }),
    ]);
  }, 60_000);

  it('c: keeps a thrown consume pending and commits the product effect once on redelivery', async () => {
    messageB = publication(deviceB, 'reply from device b');
    const envelope = createEnvelope('agent.message.publish', messageB, { taskId: taskB });

    // The consumer commits its effect, then throws: inbound.ts leaves the
    // reservation pending and the route answers 500, which the daemon retries.
    const failed = await send(deviceB, [envelope], 'consume-throw-after-commit');
    expect(failed.status).toBe(500);
    // Pending, not missing: the row exists and has no terminal disposition.
    // `readAgentMessageDisposition` answers undefined for both, so read SQL.
    expect(await admission(deviceB, taskB)).toEqual([{ message_id: messageB.messageId, pending: true }]);
    await expect(
      probe('/probe/read', { taskId: taskB, deviceId: deviceB.deviceId, payload: messageB }),
    ).resolves.toMatchObject({ disposition: null });
    const afterThrow = await probe<Ledger>('/probe/ledger');
    expect(afterThrow.consumes.find((entry) => entry.taskId === taskB)).toMatchObject({
      deviceId: deviceB.deviceId,
      messageId: messageB.messageId,
      context: { destinationBinding: 'conversation/b', freshnessCursor: 'turn-1' },
      calls: 1,
      commits: 1,
    });

    // Redelivery of the same batch calls the consumer again; its dedup ledger
    // keeps the effect single, and the SDK finalizes the pending admission.
    const retried = await send(deviceB, [envelope]);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ accepted: 1, outcomes: [{ outcome: 'accepted' }] });
    expect(await admission(deviceB, taskB)).toEqual([{ message_id: messageB.messageId, pending: false }]);
    const afterRetry = await probe<Ledger>('/probe/ledger');
    expect(afterRetry.consumes.find((entry) => entry.taskId === taskB)).toMatchObject({ calls: 2, commits: 1 });
    await expect(
      probe('/probe/read', { taskId: taskB, deviceId: deviceB.deviceId, payload: messageB }),
    ).resolves.toMatchObject({ disposition: { messageId: messageB.messageId, outcome: 'accepted' } });

    // A further exact replay is answered from the terminal admission.
    const replay = await send(deviceB, [envelope]);
    expect(replay.body).toMatchObject({ accepted: 1, outcomes: [{ outcome: 'duplicate' }] });
    const afterReplay = await probe<Ledger>('/probe/ledger');
    expect(afterReplay.consumes.find((entry) => entry.taskId === taskB)).toMatchObject({ calls: 2, commits: 1 });

    // Three posts, one durable disposition on device B's mailbox.
    const next = await poll(deviceB);
    expect(next.events.map((event) => [event.type, event.task_id])).toEqual([['agent.message.disposition', taskB]]);
    expect(next.events[0]?.payload).toMatchObject({ messageId: messageB.messageId, outcome: 'accepted' });
  }, 60_000);

  it('d: reads both terminals back through readTaskResult and readDeviceTerminal', async () => {
    const completeA = await send(deviceA, [
      createEnvelope(
        'task.complete',
        { agentRef: deviceA.agentRef, summary: 'device a done', finalMessage: 'a: final', sessionRef: 'session-a' },
        { taskId: taskA },
      ),
    ]);
    expect(completeA.body).toMatchObject({ accepted: 1 });
    expect(completeA.observerThrows).toBe(0);
    // B's observer throws on this terminal; the answer does not change.
    const completeB = await send(
      deviceB,
      [
        createEnvelope(
          'task.complete',
          { agentRef: deviceB.agentRef, summary: 'device b done', finalMessage: 'b: final', sessionRef: 'session-b' },
          { taskId: taskB },
        ),
      ],
      'observer-throw',
    );
    expect(completeB.status).toBe(200);
    expect(completeB.body).toMatchObject({ accepted: 1, outcomes: [{ outcome: 'accepted' }] });
    expect(completeB.observerThrows, 'the observer ran on the committed terminal and threw').toBe(1);

    for (const [device, taskId] of [[deviceA, taskA], [deviceB, taskB]] as const) {
      // Each read is its own invocation with a fresh pool: durable readback.
      await expect(probe('/probe/read', { taskId })).resolves.toMatchObject({
        attempt: { status: 'complete', ownerDeviceId: device.deviceId },
        result: {
          taskId,
          state: 'complete',
          agentRef: device.agentRef,
          summary: `device ${device.name} done`,
          finalMessage: `${device.name}: final`,
          sessionRef: `session-${device.name}`,
        },
        deviceTerminal: {
          envelope: {
            type: 'task.complete',
            task_id: taskId,
            payload: { agentRef: device.agentRef, summary: `device ${device.name} done` },
          },
        },
      });
    }
  }, 60_000);

  it('e: settles the intent whose observer call failed through a Durable Object alarm', async () => {
    // A's observer relayed its terminal. B's threw, so its intent waits.
    const relayed = await ledgerUntil((ledger) => intentOf(ledger, taskA).state === 'settled', 10_000);
    expect(intentOf(relayed, taskA)).toMatchObject({
      settledBy: 'observer',
      settleCount: 1,
      terminal: { state: 'complete', summary: 'device a done', deviceTerminalType: 'task.complete' },
    });
    expect(intentOf(relayed, taskB)).toMatchObject({ state: 'pending', settleCount: 0 });

    // The alarm reads again through readTaskResult and settles B.
    await probe('/probe/rescan');
    const rescanned = await ledgerUntil((ledger) => intentOf(ledger, taskB).state === 'settled', 20_000);
    expect(intentOf(rescanned, taskB)).toMatchObject({
      settledBy: 'alarm',
      settleCount: 1,
      ignoredSettles: 0,
      terminal: { state: 'complete', summary: 'device b done', deviceTerminalType: 'task.complete' },
    });
    expect(rescanned.alarmRuns).toBeGreaterThanOrEqual(1);

    // A second alarm pass finds nothing pending and applies nothing.
    await probe('/probe/rescan');
    const again = await ledgerUntil((ledger) => ledger.alarmRuns > rescanned.alarmRuns, 20_000);
    expect(intentOf(again, taskA)).toEqual(intentOf(rescanned, taskA));
    expect(intentOf(again, taskB)).toEqual(intentOf(rescanned, taskB));
  }, 60_000);

  it('measures cross-invocation wake latency, one idle hold, and the idle hourly budget', async () => {
    const deviceC = await pairDevice('c');
    const deviceD = await pairDevice('d');

    // Wake latency on C: hold a poll, then submit from another invocation at
    // a phase stepped across one fallback interval. Lower bound: from the
    // submit's answer (after commit). Upper bound: from the submit's start.
    const latency = async () => {
      const samples: { readonly lowerMs: number; readonly upperMs: number }[] = [];
      for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
        const taskId = `h-latency-${index}-${randomUUID()}`;
        const held = poll(deviceC);
        await sleep(300 + Math.round((index * WAKE_FALLBACK_MS) / LATENCY_SAMPLES));
        const submitStartedAt = performance.now();
        await probe('/probe/submit', { input: execution(deviceC, taskId, false) });
        const submitFinishedAt = performance.now();
        const delivered = await held;
        expect(delivered.events.map((event) => event.task_id)).toEqual([taskId]);
        samples.push({
          lowerMs: delivered.finishedAt - submitFinishedAt,
          upperMs: delivered.finishedAt - submitStartedAt,
        });
      }
      return samples;
    };

    // One idle hold on D at the default longPollHoldMs, concurrently: the
    // counts are per invocation, so C's traffic cannot reach them.
    const idleHold = async () => {
      const idle = await poll(deviceD, DEFAULT_LONG_POLL_HOLD_MS + 20_000);
      expect(idle.events).toEqual([]);
      return idle;
    };

    const [samples, idle] = await Promise.all([latency(), idleHold()]);

    // The other idle-device requests, one each, for their SQL cost.
    const presence = await exchange('/byok/presence', { method: 'PUT', bearer: bearer(deviceD), body: { level: 'online' } });
    expect(presence.status).toBe(200);
    const challenge = await exchange('/byok/challenge', { method: 'POST', body: { deviceId: deviceD.deviceId } });
    expect(challenge.status).toBe(200);
    const nonce = (challenge.body as { nonce: string }).nonce;
    const token = await exchange('/byok/token', {
      method: 'POST',
      body: { deviceId: deviceD.deviceId, nonce, signature: await deviceD.sim.identity.signNonce(nonce) },
    });
    expect(token.status).toBe(200);

    const upper = samples.map((sample) => sample.upperMs).sort((left, right) => left - right);
    const lower = samples.map((sample) => sample.lowerMs).sort((left, right) => left - right);
    // Bounded by the fallback, not the 50 s hold.
    expect(upper.at(-1)).toBeLessThan(WAKE_FALLBACK_MS + 1_500);
    // No wake hint crosses invocations: some samples wait most of an interval.
    expect(lower.at(-1), 'a near-zero maximum means a wake hint crossed invocations').toBeGreaterThan(250);

    const holdMs = idle.finishedAt - idle.startedAt;
    expect(holdMs).toBeGreaterThanOrEqual(DEFAULT_LONG_POLL_HOLD_MS - 50);
    expect(holdMs).toBeLessThan(DEFAULT_LONG_POLL_HOLD_MS + 10_000);
    // One read per fallback interval plus the first: about 1 + hold / fallback.
    expect(idle.readAfter).toBeGreaterThanOrEqual(40);
    expect(idle.readAfter).toBeLessThanOrEqual(1 + Math.ceil(DEFAULT_LONG_POLL_HOLD_MS / WAKE_FALLBACK_MS));
    expect(idle.sql).toBeGreaterThan(idle.readAfter);

    // Computed from the measured hold and the daemon's own cadence constants.
    const hour = 3_600_000;
    const pollsPerHour = hour / (holdMs + DAEMON_IDLE_DELAY_MS);
    const presencePerHour = hour / PRESENCE_INTERVAL_MS;
    const renewalsPerHour = hour / (ACCESS_TOKEN_TTL_SECONDS * 1_000 - RENEW_MARGIN_MS);
    const round = (value: number) => Math.round(value * 10) / 10;
    const pick = (sorted: readonly number[], quantile: number) =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? Number.NaN);
    // Straight to stdout: vitest hides console output of passed tests, and
    // the CI log is where these numbers are read.
    process.stdout.write(`[topology-h] ${JSON.stringify({
      measured: {
        wakeLatencyMs: {
          fallbackMs: WAKE_FALLBACK_MS,
          samples: LATENCY_SAMPLES,
          lowerBound: { min: pick(lower, 0), p50: pick(lower, 0.5), max: pick(lower, 1) },
          upperBound: { min: pick(upper, 0), p50: pick(upper, 0.5), max: pick(upper, 1) },
        },
        idleHold: { holdMs: Math.round(holdMs), readAfter: idle.readAfter, sql: idle.sql },
        sqlPerRequest: { presence: presence.sql, challenge: challenge.sql, token: token.sql },
      },
      computedPerIdleDeviceHour: {
        eventsPolls: round(pollsPerHour),
        presencePuts: round(presencePerHour),
        renewalRequests: round(2 * renewalsPerHour),
        workerRequests: round(pollsPerHour + presencePerHour + 2 * renewalsPerHour),
        readAfterCalls: round(pollsPerHour * idle.readAfter),
        sqlStatements: round(
          pollsPerHour * idle.sql + presencePerHour * presence.sql + renewalsPerHour * (challenge.sql + token.sql),
        ),
      },
    })}\n`);
  }, 150_000);
});
