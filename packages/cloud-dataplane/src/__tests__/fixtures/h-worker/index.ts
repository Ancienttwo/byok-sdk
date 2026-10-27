/**
 * The Topology H probe Worker: one hosted Host, serving real paired devices
 * under local workerd.
 *
 * Topology H moves the Host off the device. `createByokCloud` runs in a Worker
 * over the `@byok-sdk/cloud-dataplane/runtime` stores, and the daemon stays on
 * the device. `worker-smoke/` proves the data path; this fixture proves the
 * device surface end to end: pairing, `GET /byok/events`, `POST /byok/messages`,
 * the `agentMessage.consume` admission hook and the post-commit observer.
 *
 * Every invocation composes the Host the way the package README documents for
 * Workers (Deployment compositions, Mailbox wake):
 *
 * - a new `Pool` over the Hyperdrive binding, never held in module scope;
 * - both store compositions over that pool;
 * - a new `createInProcessMailboxWake({ fallbackMs: 1_000 })`. A write from any
 *   other invocation therefore reaches a held poll only through the fallback
 *   read. That is the cross-isolate path, whichever isolate the writer ran in;
 * - the default `longPollHoldMs`.
 *
 * Product state lives in one Durable Object per tenant (`ProductLedger`): the
 * Host's submitted intents, the consumer's durable dedup ledger, and the alarm
 * rescan that settles an intent whose observer call failed. None of it is SDK
 * state. The SDK's authority stays in Postgres.
 *
 * Fault injection is per request, through the `x-h-fault` header on a device
 * request: `consume-throw-after-commit` makes the consumer commit its effect
 * and then throw; `observer-throw` makes the observer throw on a terminal.
 *
 * Every `/byok/*` response carries per-invocation counts: `x-h-read-after`
 * (`mailbox.readAfter` calls), `x-h-sql` (SQL statements sent on this
 * invocation's pool) and `x-h-observer-throws` (injected observer failures).
 */
import {
  CLOUD_CAPABILITIES,
  createByokCloud,
  createHmacTokenSigner,
  createInProcessMailboxWake,
  createWebCrypto,
  fullCapabilityDeclaration,
  tenantId,
  type AgentExecutionInput,
  type ByokCloud,
  type ByokCloudOptions,
} from '@byok-sdk/cloud';
import {
  createByokPool,
  createPostgresCloudStores,
  createPostgresCoreStores,
} from '@byok-sdk/cloud-dataplane/runtime';
import type { Clock, CoreStores } from '@byok-sdk/core';
import type { AgentMessagePublishPayload, AgentMessageServerContext, AgentRef } from '@byok-sdk/protocol';
import type { Pool } from 'pg';

// The Workers runtime surface this fixture touches, written out because the
// package typechecks against Node types only (no `cloudflare:workers` import).
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { readonly prefix: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
}
interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  readonly BYOK_PG: { readonly connectionString: string };
  readonly PRODUCT_LEDGER: DurableObjectNamespace;
  /** Lowercase hex HMAC key, fixed for the run: a bearer minted at pairing must verify in every later invocation. */
  readonly BYOK_TOKEN_SECRET: string;
  readonly BYOK_S3_ENDPOINT?: string;
  readonly BYOK_S3_BUCKET?: string;
  readonly BYOK_S3_ACCESS_KEY_ID?: string;
  readonly BYOK_S3_SECRET_ACCESS_KEY?: string;
  readonly BYOK_S3_REGION?: string;
}

/** The fallback the README prescribes for Workers Hosts. */
const WAKE_FALLBACK_MS = 1_000;
const FAULT_HEADER = 'x-h-fault';

/** Wall time: this fixture asserts delivery and durability, not TTL edges. */
const clock: Clock = { now: () => new Date() };
const crypto = createWebCrypto();

function hexBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) throw new Error('BYOK_TOKEN_SECRET must be lowercase hex');
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

/**
 * The object-storage half both compositions require. No probe here touches
 * an object, so the test passes an endpoint that refuses connections: any
 * object access on the H path fails loudly instead of passing unseen.
 */
function objectStorage(env: Env) {
  const { BYOK_S3_ENDPOINT, BYOK_S3_BUCKET, BYOK_S3_ACCESS_KEY_ID, BYOK_S3_SECRET_ACCESS_KEY, BYOK_S3_REGION } = env;
  if (!BYOK_S3_ENDPOINT || !BYOK_S3_BUCKET || !BYOK_S3_ACCESS_KEY_ID || !BYOK_S3_SECRET_ACCESS_KEY || !BYOK_S3_REGION) {
    throw new Error('the h-worker fixture needs the BYOK_S3_* wrangler vars; the test passes them');
  }
  return {
    endpoint: BYOK_S3_ENDPOINT,
    bucket: BYOK_S3_BUCKET,
    accessKeyId: BYOK_S3_ACCESS_KEY_ID,
    secretAccessKey: BYOK_S3_SECRET_ACCESS_KEY,
    region: BYOK_S3_REGION,
    signingClock: clock,
  };
}

interface Counts {
  readAfter: number;
  sql: number;
}

interface Host {
  readonly cloud: ByokCloud;
  readonly core: CoreStores;
  readonly pool: Pool;
  readonly counts: Counts;
}

type ProductHooks = Pick<ByokCloudOptions, 'agentMessage' | 'observer'>;

/** One invocation's Host. The caller ends `pool` when the invocation is done with it. */
async function composeHost(env: Env, hooks: ProductHooks): Promise<Host> {
  const counts: Counts = { readAfter: 0, sql: 0 };
  const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString });
  // `Pool.query` also runs on a pooled client, so counting at the client
  // covers plain queries and transactions alike.
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    Object.assign(client, {
      query: (...args: unknown[]) => {
        counts.sql += 1;
        return query(...args);
      },
    });
  });
  const storage = objectStorage(env);
  const core = createPostgresCoreStores({ pool, clock, objectStorage: storage });
  const readAfter = core.mailbox.readAfter.bind(core.mailbox);
  core.mailbox.readAfter = (tenant, query) => {
    counts.readAfter += 1;
    return readAfter(tenant, query);
  };
  const stores = await createPostgresCloudStores({ pool, clock, crypto, objectStorage: storage });
  const full = fullCapabilityDeclaration();
  const cloud = createByokCloud({
    mailboxWake: createInProcessMailboxWake({ fallbackMs: WAKE_FALLBACK_MS }),
    core,
    cloud: stores,
    crypto,
    tokenSigner: createHmacTokenSigner(hexBytes(env.BYOK_TOKEN_SECRET), clock),
    clock,
    // No byte proxy: an object-storage composition hands out presigned URLs.
    capabilities: {
      ...full,
      capabilities: full.capabilities.filter((capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy),
    },
    ...hooks,
  });
  return { cloud, core, pool, counts };
}

/** The product's Durable Object for one tenant, addressed by op name. */
function ledger(env: Env, tenant: string) {
  const stub = env.PRODUCT_LEDGER.get(env.PRODUCT_LEDGER.idFromName(tenant));
  return async <T>(op: string, body: Record<string, unknown> = {}): Promise<T> => {
    const response = await stub.fetch(`https://product-ledger/${op}`, {
      method: 'POST',
      body: JSON.stringify({ ...body, tenant }),
    });
    if (!response.ok) throw new Error(`product ledger ${op}: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
}

type TerminalState = 'complete' | 'failed' | 'cancelled';

interface InjectedFaults {
  observerThrows: number;
}

function terminalState(type: string): TerminalState | undefined {
  if (type === 'task.complete') return 'complete';
  if (type === 'task.fail' || type === 'task.decline') return 'failed';
  if (type === 'task.cancelled') return 'cancelled';
  return undefined;
}

/**
 * The product hooks one invocation hands `createByokCloud`.
 *
 * `consume` commits the product effect in the Durable Object first, so an
 * injected throw lands in the window `inbound.ts` names: the product
 * committed, then its transport failed. The observer is synchronous by
 * contract, so its relay to the ledger rides `waitUntil`, and its injected
 * failure is a throw before any relay starts.
 */
function productHooks(env: Env, ctx: ExecutionContext, fault: string | null, injected: InjectedFaults): ProductHooks {
  return {
    agentMessage: {
      async consume(input) {
        const decision = await ledger(env, input.tenant)<{ outcome: 'accepted' }>('consume', {
          deviceId: input.deviceId,
          taskId: input.taskId,
          agentRef: input.payload.agentRef,
          messageId: input.payload.messageId,
          contentHash: input.payload.contentHash,
          context: input.context,
        });
        if (fault === 'consume-throw-after-commit') {
          throw new Error('injected: the product committed its effect, then its transport failed');
        }
        return decision;
      },
    },
    observer: {
      onInboundCommitted({ tenantId: tenant, envelope }) {
        const state = terminalState(envelope.type);
        if (state === undefined || envelope.task_id === undefined) return;
        if (fault === 'observer-throw') {
          injected.observerThrows += 1;
          throw new Error('injected: the observer relay failed');
        }
        ctx.waitUntil(
          ledger(env, tenant)('settle', {
            taskId: envelope.task_id,
            by: 'observer',
            terminal: {
              state,
              ...(envelope.type === 'task.complete' && envelope.payload.sealed === undefined ? { summary: envelope.payload.summary } : {}),
              deviceTerminalType: envelope.type,
            },
          }),
        );
      },
    },
  };
}

/** The device surface, with this invocation's counts on the response. */
async function serveDevice(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const injected: InjectedFaults = { observerThrows: 0 };
  const host = await composeHost(env, productHooks(env, ctx, request.headers.get(FAULT_HEADER), injected));
  try {
    const response = await host.cloud.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('x-h-read-after', String(host.counts.readAfter));
    headers.set('x-h-sql', String(host.counts.sql));
    headers.set('x-h-observer-throws', String(injected.observerThrows));
    return new Response(response.body, { status: response.status, headers });
  } finally {
    ctx.waitUntil(host.pool.end());
  }
}

interface ProbeBody {
  readonly tenant: string;
  readonly productId?: string;
  readonly input?: AgentExecutionInput;
  readonly taskId?: string;
  readonly deviceId?: string;
  readonly payload?: AgentMessagePublishPayload;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`probe body is missing ${name}`);
  return value;
}

/**
 * The Host control plane and the product read side. The SDK mounts no admin
 * route, so a Host defines its own; these are this fixture's.
 */
async function serveProbe(route: string, body: ProbeBody, env: Env, ctx: ExecutionContext): Promise<Response> {
  const tenant = tenantId(body.tenant);
  if (route === '/probe/ledger') return Response.json(await ledger(env, tenant)('state'));
  if (route === '/probe/rescan') return Response.json(await ledger(env, tenant)('rescan'));
  const host = await composeHost(env, productHooks(env, ctx, null, { observerThrows: 0 }));
  try {
    if (route === '/probe/tenant') {
      // A limited mailbox append is admitted against the tenant entitlement.
      await host.core.quota.writeEntitlement(tenant, {
        version: 1n,
        hardLimitBytes: 1_000_000_000n,
        maxObjectBytes: 100_000_000n,
        maxInlineBytes: 1_000_000n,
        mailboxLimitBytes: 100_000_000n,
        retentionPolicyId: 'default',
      });
      return Response.json({ ok: true });
    }
    if (route === '/probe/pairing-code') {
      return Response.json(await host.cloud.createPairingCode(tenant, { productId: required(body.productId, 'productId') }));
    }
    if (route === '/probe/submit') {
      const input = required(body.input, 'input');
      // The Host persists its intent before dispatch; the ledger is its own.
      await ledger(env, tenant)('intent', { taskId: input.taskId, deviceId: input.deviceId });
      const offered = await host.cloud.submitAgentExecution(tenant, input);
      return Response.json({ taskId: offered.taskId, seq: offered.seq, type: offered.envelope.type });
    }
    if (route === '/probe/read') {
      const taskId = required(body.taskId, 'taskId');
      const attempt = await host.cloud.readTaskAttempt(tenant, taskId);
      const disposition = body.payload === undefined
        ? undefined
        : await host.cloud.readAgentMessageDisposition(tenant, required(body.deviceId, 'deviceId'), taskId, body.payload);
      return Response.json({
        attempt: attempt === undefined
          ? null
          : { status: attempt.status, deviceId: attempt.deviceId, ownerDeviceId: attempt.ownerDeviceId ?? null },
        result: (await host.cloud.readTaskResult(tenant, taskId)) ?? null,
        deviceTerminal: (await host.cloud.readDeviceTerminal(tenant, taskId)) ?? null,
        disposition: disposition ?? null,
      });
    }
    return new Response(`no probe route ${route}\n`, { status: 404 });
  } finally {
    await host.pool.end();
  }
}

interface Intent {
  readonly taskId: string;
  readonly deviceId: string;
  readonly state: 'pending' | 'settled';
  readonly settledBy?: 'observer' | 'alarm';
  readonly terminal?: { readonly state: TerminalState; readonly summary?: string; readonly deviceTerminalType?: string };
  /** Settlements applied: 0 while pending, 1 after. A second settle is ignored, not applied. */
  readonly settleCount: number;
  readonly ignoredSettles: number;
}

interface ConsumeEntry {
  readonly deviceId: string;
  readonly taskId: string;
  readonly agentRef: AgentRef;
  readonly messageId: string;
  readonly contentHash: string;
  readonly context: AgentMessageServerContext;
  readonly outcome: 'accepted';
  /** Every consumer call for this exact message identity. */
  readonly calls: number;
  /** Product effects applied for it. The dedup ledger keeps this at 1. */
  readonly commits: number;
}

/**
 * The product's per-tenant ledger. Requests and the alarm share one storage;
 * each read-then-write below has no non-storage await in between, so the
 * Durable Object input gate keeps it atomic against concurrent requests.
 */
export class ProductLedger {
  readonly #state: DurableObjectState;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const op = new URL(request.url).pathname.slice(1);
    const body = (await request.json()) as Record<string, unknown> & { readonly tenant: string };
    const storage = this.#state.storage;
    if (op === 'intent') {
      await storage.put('tenant', body.tenant);
      const key = `intent:${String(body.taskId)}`;
      if ((await storage.get<Intent>(key)) === undefined) {
        await storage.put<Intent>(key, {
          taskId: String(body.taskId),
          deviceId: String(body.deviceId),
          state: 'pending',
          settleCount: 0,
          ignoredSettles: 0,
        });
      }
      return Response.json({ ok: true });
    }
    if (op === 'consume') {
      const agentRef = body.agentRef as AgentRef;
      const key = `consume:${String(body.deviceId)}:${String(body.taskId)}:${agentRef.agentId}:${agentRef.profileRevision}:${String(body.messageId)}`;
      const prior = await storage.get<ConsumeEntry>(key);
      // The exact tenant/device/task/AgentRef/message identity is the dedup
      // key, as the consume contract requires: one effect, one outcome.
      const entry: ConsumeEntry = prior === undefined
        ? {
            deviceId: String(body.deviceId),
            taskId: String(body.taskId),
            agentRef,
            messageId: String(body.messageId),
            contentHash: String(body.contentHash),
            context: body.context as AgentMessageServerContext,
            outcome: 'accepted',
            calls: 1,
            commits: 1,
          }
        : { ...prior, calls: prior.calls + 1 };
      await storage.put(key, entry);
      return Response.json({ outcome: entry.outcome });
    }
    if (op === 'settle') {
      return Response.json(await this.#settle(String(body.taskId), body.by as 'observer' | 'alarm', body.terminal as Intent['terminal']));
    }
    if (op === 'rescan') {
      await storage.put('tenant', body.tenant);
      await storage.setAlarm(Date.now());
      return Response.json({ armed: true });
    }
    if (op === 'state') {
      return Response.json({
        intents: [...(await storage.list<Intent>({ prefix: 'intent:' })).values()],
        consumes: [...(await storage.list<ConsumeEntry>({ prefix: 'consume:' })).values()],
        alarmRuns: (await storage.get<number>('alarmRuns')) ?? 0,
      });
    }
    return new Response(`no ledger op ${op}\n`, { status: 404 });
  }

  /**
   * The rescan. Observer errors are swallowed by the SDK, so the product
   * reads again: every still-pending intent is settled from `readTaskResult`,
   * the durable read model the observer only relayed.
   */
  async alarm(): Promise<void> {
    const storage = this.#state.storage;
    await storage.put('alarmRuns', ((await storage.get<number>('alarmRuns')) ?? 0) + 1);
    const tenant = await storage.get<string>('tenant');
    if (tenant === undefined) return;
    const pending = [...(await storage.list<Intent>({ prefix: 'intent:' })).values()].filter(
      (intent) => intent.state === 'pending',
    );
    if (pending.length === 0) return;
    const host = await composeHost(this.#env, {});
    try {
      for (const intent of pending) {
        const result = await host.cloud.readTaskResult(tenantId(tenant), intent.taskId);
        if (result === undefined) continue;
        const device = await host.cloud.readDeviceTerminal(tenantId(tenant), intent.taskId);
        await this.#settle(intent.taskId, 'alarm', {
          state: result.state,
          ...(result.summary === undefined ? {} : { summary: result.summary }),
          ...(device === undefined ? {} : { deviceTerminalType: device.envelope.type }),
        });
      }
    } finally {
      await host.pool.end();
    }
  }

  async #settle(taskId: string, by: 'observer' | 'alarm', terminal: Intent['terminal']): Promise<Intent | null> {
    const storage = this.#state.storage;
    const key = `intent:${taskId}`;
    const intent = await storage.get<Intent>(key);
    if (intent === undefined) return null;
    const next: Intent = intent.state === 'pending'
      ? { ...intent, state: 'settled', settledBy: by, ...(terminal === undefined ? {} : { terminal }), settleCount: intent.settleCount + 1 }
      : { ...intent, ignoredSettles: intent.ignoredSettles + 1 };
    await storage.put(key, next);
    return next;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const route = new URL(request.url).pathname;
    try {
      if (route.startsWith('/byok/')) return await serveDevice(request, env, ctx);
      if (route.startsWith('/probe/') && request.method === 'POST') {
        return await serveProbe(route, (await request.json()) as ProbeBody, env, ctx);
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
    return new Response(
      'routes: /byok/* (device surface); POST /probe/tenant /probe/pairing-code /probe/submit /probe/read /probe/ledger /probe/rescan\n',
      { status: 404 },
    );
  },
} satisfies { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };
