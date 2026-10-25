/**
 * The hosted (H) Bot collaboration Host as one Cloudflare Worker (#794 D3).
 *
 * Every invocation (a request or a clock alarm) composes the whole Host and ends its pools before it is done:
 *
 * - two new pools over the Hyperdrive binding: the SDK pool from `createByokPool` (its int8 parser), and the H store's own
 *   `pg.Pool`, as the H README asks;
 * - the SDK stores and `createByokCloud`, with H's message consumer and a new in-process mailbox wake with a 1 s fallback;
 * - the H store and its passes, with the scope configs read from Postgres.
 *
 * Module scope holds no mutable state. Postgres is the only memory between invocations: no `LISTEN`, no timer that outlives
 * an invocation, no session map. The Host passes run from the alarm of `HostClock`, one Durable Object for the deployment,
 * every `H_CLOCK_MS`, and from `POST /host/passes`; both call the same function. The alarm holds no Host state, only its next
 * time; a cron trigger only arms the clock, once a minute, and runs no pass. A notification (an SDK observer call after a
 * device commit, or a product command) only schedules one more pass with
 * `ctx.waitUntil`, and that pass rereads Postgres. Losing a notification or an alarm delays work until the next pass;
 * repeating either is harmless.
 *
 * `H_FAULT` is per instance, set with `--var` at start, as a comma-separated list: `drop-notify` and `duplicate-notify`
 * change the notifications, `drop-alarm` and `duplicate-alarm` change the alarm passes, and the `hang-*` faults stop an
 * invocation at one point after a durable step and print a `[h-fault]` line, so a test can kill the instance there. A
 * restart without the var clears it.
 */
import pg from 'pg';
import { CLOUD_CAPABILITIES, createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration,
  tenantId, type ByokCloud, type ByokCloudObserver, type TenantId } from '@byok-sdk/cloud';
import { createByokPool, createPostgresCloudStores, createPostgresCoreStores } from '@byok-sdk/cloud-dataplane/runtime';
import { COALESCE_DEFAULTS } from '@byok-sdk/example-bot-collaboration/coalesce';
import type { FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { EntryRefusedError, HostedCollaborationStore, HostedCommandEntry, HostedDeviceObserver, HostedDueScheduler, HostedReconciler,
  HostedReplyChecker, HostedRoutineScheduler, HostedSubmitter, hostedMessageConsumer, UnauthenticatedError, type HostedSyncOptions,
  type HostedTaskPort } from '@byok-sdk/example-hosted-bot-collaboration/src/index';
import { releaseAfterBody } from './body-lifetime';
import { readHostScopes, sha256Hex, type HostScope } from './host-scopes';

// The Workers runtime surface this Worker touches, written out because the example typechecks against Node types only.
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }
interface DurableObjectState { readonly storage: { getAlarm(): Promise<number | null>; setAlarm(scheduledTime: number): Promise<void> } }
interface DurableObjectNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string): Promise<Response> } }
interface ScheduledController { readonly cron: string }

export interface Env {
  readonly BYOK_PG: { readonly connectionString: string };
  readonly HOST_CLOCK: DurableObjectNamespace;
  /** The H store's schema and the schema of the `host_scope` table. Node migrates both before the Worker serves. */
  readonly H_SCHEMA: string;
  readonly HOST_SCHEMA: string;
  /** Lowercase hex HMAC key of the SDK token signer: a bearer minted in one invocation must verify in every later one. */
  readonly BYOK_TOKEN_SECRET: string;
  /** The operator bearer of `/host/pairing-code` and `/host/passes`. */
  readonly HOST_ADMIN_TOKEN: string;
  readonly BYOK_S3_ENDPOINT: string;
  readonly BYOK_S3_BUCKET: string;
  readonly BYOK_S3_ACCESS_KEY_ID: string;
  readonly BYOK_S3_SECRET_ACCESS_KEY: string;
  readonly BYOK_S3_REGION: string;
  /** Optional pass timings in ms, as strings: the submitter lease and the reconciler's wait between readbacks. */
  readonly H_SUBMIT_LEASE_MS?: string;
  readonly H_RECONCILE_POLL_MS?: string;
  /** The clock's alarm interval in ms, from 1 to 15 000; 10 000 when unset. The routine scheduler checks it too. */
  readonly H_CLOCK_MS?: string;
  /** Input coalescing (the H store's `coalesce` option) with this window in ms and the K8 defaults otherwise. Off when unset. */
  readonly H_COALESCE_WINDOW_MS?: string;
  readonly H_FAULT?: string;
}

// The Worker's module exports only its handlers and its Durable Object class: workerd refuses any other value export.
const PRODUCT_ID = 'hosted-collaboration-worker';
/** The sync limits of every scope. A product reads them from the scope's plan. */
const SYNC: Omit<HostedSyncOptions, 'now'> = { limits: { turnLimit: 12, contextMaxBytes: 32_768, instructionMaxBytes: 65_536 }, historyMode: false };
const FAULTS = ['drop-notify', 'duplicate-notify', 'drop-alarm', 'duplicate-alarm', 'hang-after-submit', 'hang-after-terminal-read',
  'hang-after-consume'] as const;
type Fault = typeof FAULTS[number];
/** The one clock of the deployment: every invocation addresses the same Durable Object. */
const CLOCK_NAME = 'deployment';
const DEFAULT_CLOCK_MS = 10_000;
/** The longest alarm interval. A routine slot then fires at most this long plus one pass late, well inside the K8 60 s bound. */
const MAX_CLOCK_MS = 15_000;
/** How long a `hang-*` fault holds its invocation: longer than any test waits for the kill. */
const HANG_MS = 600_000;

const clock = { now: () => new Date() };
const crypto = createWebCrypto();

function hexBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) throw new Error('BYOK_TOKEN_SECRET must be lowercase hex');
  return Uint8Array.from(hex.match(/../gu) ?? [], byte => Number.parseInt(byte, 16));
}
function milliseconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`${name} must be a non-negative integer`);
  return ms;
}
function clockMs(env: Env): number {
  const ms = milliseconds(env.H_CLOCK_MS, 'H_CLOCK_MS') ?? DEFAULT_CLOCK_MS;
  if (ms < 1 || ms > MAX_CLOCK_MS) throw new Error(`H_CLOCK_MS must be from 1 to ${MAX_CLOCK_MS}`);
  return ms;
}
function faults(env: Env): ReadonlySet<Fault> {
  const named = env.H_FAULT === undefined || env.H_FAULT === '' ? [] : env.H_FAULT.split(',');
  for (const name of named) if (!(FAULTS as readonly string[]).includes(name)) throw new Error(`Unknown H_FAULT ${name}`);
  return new Set(named as Fault[]);
}
/** Stops this invocation after a durable step. The test reads the line, then kills the instance. */
async function hang(env: Env, point: Fault, detail: string): Promise<void> {
  if (!faults(env).has(point)) return;
  console.log(`[h-fault] ${point} ${detail}`);
  await new Promise(resolve => setTimeout(resolve, HANG_MS));
}

/** One scope is one SDK tenant (H README, Host auth). The scope string is the tenant id, so the two maps are inverse. */
const tenantOf = (scope: string): TenantId => tenantId(scope);
const scopeOf = (tenant: TenantId): string => String(tenant);

interface Host {
  readonly cloud: ByokCloud;
  readonly store: HostedCollaborationStore;
  readonly scopes: ReadonlyMap<string, HostScope>;
  passes(): Promise<PassReport>;
  syncScope(scope: string, now: number): Promise<unknown>;
  close(): Promise<void>;
}

/** One invocation's Host. `notify` schedules one more pass after the invocation's own work. */
async function compose(env: Env, notify: () => void): Promise<Host> {
  // A Worker invocation may hold only a few connections open at once (six per invocation, sockets and fetches together, at
  // the time of writing). The two pools together stay below that, with room for the object store's fetches.
  const sdkPool = createByokPool({ connectionString: env.BYOK_PG.connectionString, max: 3 });
  const hostPool = new pg.Pool({ connectionString: env.BYOK_PG.connectionString, max: 2 });
  // A pg pool needs an 'error' listener, or an idle client's reset is an uncaught error (cloud-dataplane pool.ts).
  hostPool.on('error', error => { console.error('[h-worker] idle H pool client error', error); });
  const close = async () => { await Promise.all([sdkPool.end(), hostPool.end()]); };
  try {
    const scopes = await readHostScopes(hostPool, env.HOST_SCHEMA);
    const config = (scope: string): HostScope => {
      const found = scopes.get(scope);
      if (!found) throw new Error(`Unknown scope ${scope}`);
      return found;
    };
    const windowMs = milliseconds(env.H_COALESCE_WINDOW_MS, 'H_COALESCE_WINDOW_MS');
    const store = new HostedCollaborationStore(hostPool, env.H_SCHEMA, { host: scope => config(scope).config,
      ...(windowMs === undefined ? {} : { coalesce: { ...COALESCE_DEFAULTS, windowMs } }) });
    const objectStorage = { endpoint: env.BYOK_S3_ENDPOINT, bucket: env.BYOK_S3_BUCKET, accessKeyId: env.BYOK_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BYOK_S3_SECRET_ACCESS_KEY, region: env.BYOK_S3_REGION, signingClock: clock };
    const core = createPostgresCoreStores({ pool: sdkPool, clock, objectStorage });
    const stores = await createPostgresCloudStores({ pool: sdkPool, clock, crypto, objectStorage });
    const consumer = hostedMessageConsumer(store, { scopeOf });
    const observer: ByokCloudObserver = { onInboundCommitted: () => { notify(); } };
    const declared = fullCapabilityDeclaration();
    const cloud = createByokCloud({ core, cloud: stores, clock, crypto, observer,
      mailboxWake: createInProcessMailboxWake({ fallbackMs: 1_000 }),
      tokenSigner: createHmacTokenSigner(hexBytes(env.BYOK_TOKEN_SECRET), clock),
      // An object-storage composition hands out presigned URLs, so it declares no byte proxy.
      capabilities: { ...declared, capabilities: declared.capabilities.filter(capability => capability !== CLOUD_CAPABILITIES.blobsContentProxy) },
      agentMessage: { consume: async input => {
        const decision = await consumer.consume(input);
        await hang(env, 'hang-after-consume', `${input.taskId} ${input.payload.messageId}`);
        return decision;
      } } });

    const taskPort = (scope: string): FrozenSubmitPort & HostedTaskPort => {
      config(scope);
      const tenant = tenantOf(scope);
      return {
        submit: async input => {
          const result = await cloud.submitAgentExecution(tenant, input);
          await hang(env, 'hang-after-submit', input.taskId);
          return result;
        },
        offer: id => cloud.readTaskOffer(tenant, id),
        attempt: id => cloud.readTaskAttempt(tenant, id),
        deviceTerminal: async id => {
          const terminal = await cloud.readDeviceTerminal(tenant, id);
          if (terminal) await hang(env, 'hang-after-terminal-read', id);
          return terminal;
        },
        cancel: (id, reason) => cloud.cancelTask(tenant, id, reason),
      };
    };
    const checker = new HostedReplyChecker(store, { port: scope => ({
      agentMessage: (taskId, deviceId, agentRef) => cloud.readTaskAgentMessage(tenantOf(scope), deviceId, taskId, agentRef) }) });
    const devices = new HostedDeviceObserver(store, { port: scope => ({ readiness: () => cloud.readTenantReadiness(tenantOf(scope)) }) });
    // The composed sync of the H README (Reply checks): each step commits in its own transaction.
    const syncScope = async (scope: string, now: number) => {
      await checker.check(scope, now);
      await devices.observe(scope);
      return store.sync(scope, { ...SYNC, now });
    };
    const passes = async (): Promise<PassReport> => {
      const changed = new Set<string>();
      // The clock times these passes, so the scheduler checks the clock's interval against the K8 late bound.
      const routines = new HostedRoutineScheduler(hostPool, store, { intervalMs: clockMs(env), changed: scope => { changed.add(scope); } });
      const submitter = new HostedSubmitter(hostPool, env.H_SCHEMA, { port: taskPort,
        ...optional('leaseMs', milliseconds(env.H_SUBMIT_LEASE_MS, 'H_SUBMIT_LEASE_MS')) });
      const reconciler = new HostedReconciler(hostPool, env.H_SCHEMA, store, { port: taskPort, changed: scope => { changed.add(scope); },
        ...optional('pollMs', milliseconds(env.H_RECONCILE_POLL_MS, 'H_RECONCILE_POLL_MS')) });
      const due = new HostedDueScheduler(hostPool, store, { sync: syncScope });
      // `start()` is K4 `recover`: it reads the routine rows, so it is safe on every pass, and a Worker has no process start.
      const routineStart = failures(await routines.start());
      const routinePass = await routines.run();
      const reconcile = await reconciler.run();
      const synced: { scope: string; error?: string }[] = [];
      for (const scope of changed) {
        try { await syncScope(scope, Date.now()); synced.push({ scope }); } catch (error) { synced.push({ scope, error: text(error) }); }
      }
      const duePass = await due.run();
      // Last, so a Turn that this pass froze is offered in the same pass.
      const submit = await submitter.run();
      return { routineStart, routines: { fired: routinePass.fired, fenced: failures(routinePass.fenced), failed: failures(routinePass.failed) },
        reconcile: { concluded: reconcile.concluded, failed: failures(reconcile.failed) }, synced,
        due: { synced: duePass.synced, stalled: duePass.stalled, failed: failures(duePass.failed) },
        submit: { tried: submit.tried, failed: failures(submit.failed) } };
    };
    return { cloud, store, scopes, passes, syncScope, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface PassReport {
  routineStart: Failure[];
  routines: { fired: number; fenced: Failure[]; failed: Failure[] };
  reconcile: { concluded: number; failed: Failure[] };
  synced: { scope: string; error?: string }[];
  due: { synced: number; stalled: string[]; failed: Failure[] };
  submit: { tried: number; failed: Failure[] };
}
interface Failure { scope: string; id?: string; error: string }
const text = (error: unknown): string => error instanceof Error ? error.message : String(error);
function failures(list: readonly { scope: string; error: unknown; routineId?: string; turnId?: string }[]): Failure[] {
  return list.map(item => ({ scope: item.scope, ...(item.routineId || item.turnId ? { id: item.routineId || item.turnId } : {}), error: text(item.error) }));
}
function optional<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : { [key]: value } as Record<K, number>;
}

/**
 * One notification: one more pass in its own composition, after the current invocation. `drop-notify` loses it and
 * `duplicate-notify` sends it twice, at once.
 */
function notifier(env: Env, ctx: ExecutionContext): () => void {
  let sent = false;
  return () => {
    // One pass per invocation is enough: the pass reads every due row.
    if (sent) return;
    sent = true;
    const mode = faults(env);
    if (mode.has('drop-notify')) return;
    const id = globalThis.crypto.randomUUID(), copies = mode.has('duplicate-notify') ? 2 : 1;
    for (let copy = 1; copy <= copies; copy++) {
      console.log(`[h-worker] notified pass ${id} ${copy}/${copies}`);
      ctx.waitUntil(runPasses(env).catch(error => { console.error('[h-worker] notified pass failed', error); }));
    }
  };
}

/** One Host pass in its own composition. A pass sends no notification: it already reads every due row. */
async function runPasses(env: Env): Promise<PassReport> {
  const host = await compose(env, () => {});
  try { return await host.passes(); } finally { await host.close(); }
}

/**
 * The deployment's clock (H4 of #794 D3): one Durable Object whose alarm runs the Host passes every `H_CLOCK_MS`, so routine
 * slots and due steps run inside the K8 late bound, which a once-a-minute cron cannot meet. It keeps no Host state: each alarm
 * pass rereads Postgres, so an alarm that is lost, delivered twice, or cut off by a lost instance is made up by the next one.
 */
export class HostClock {
  readonly #state: DurableObjectState;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  /**
   * Arms a clock that has no alarm, to fire at once. The cron trigger asks once a minute, so a new deployment starts its
   * clock, and a clock whose alarm is gone starts again, within a minute and with no request.
   */
  async fetch(): Promise<Response> {
    const storage = this.#state.storage;
    if (await storage.getAlarm() !== null) return Response.json({ armed: false });
    await storage.setAlarm(Date.now());
    return Response.json({ armed: true });
  }

  /**
   * Sets the next alarm first, so a pass that throws or an instance lost mid-pass still leaves one set. A failed pass is
   * logged, not thrown: a thrown alarm would also start the platform's own retries, next to the fixed interval. It throws
   * only on an invalid `H_CLOCK_MS` (before the next alarm is set) or `H_FAULT`: invalid config fails closed, and the cron
   * arms the clock again each minute.
   */
  async alarm(): Promise<void> {
    await this.#state.storage.setAlarm(Date.now() + clockMs(this.#env));
    const mode = faults(this.#env);
    if (mode.has('drop-alarm')) { console.log('[h-clock] alarm dropped'); return; }
    const id = globalThis.crypto.randomUUID(), copies = mode.has('duplicate-alarm') ? 2 : 1;
    await Promise.all(Array.from({ length: copies }, async (_, index) => {
      const label = `${id} ${index + 1}/${copies}`;
      try { console.log(`[h-clock] alarm pass ${label} ${JSON.stringify(await runPasses(this.#env))}`); }
      catch (error) { console.error(`[h-clock] alarm pass ${label} failed`, error); }
    }));
  }
}

/** Asks the clock to arm itself. Returns whether it had no alarm. */
async function armClock(env: Env): Promise<boolean> {
  const clock = env.HOST_CLOCK.get(env.HOST_CLOCK.idFromName(CLOCK_NAME));
  const { armed } = await (await clock.fetch('https://host-clock/arm')).json() as { armed: boolean };
  return armed;
}

async function bearer(request: Request): Promise<string | undefined> {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}
async function admin(request: Request, env: Env): Promise<boolean> {
  const token = await bearer(request);
  return token !== undefined && await sha256Hex(token) === await sha256Hex(env.HOST_ADMIN_TOKEN);
}

/** The product side: the operator routes and the owner's command entry. */
async function serveHost(request: Request, env: Env, ctx: ExecutionContext, route: string): Promise<Response> {
  if (route === '/host/input') return serveInput(request, env, ctx);
  if (!await admin(request, env)) return new Response('unauthorized\n', { status: 401 });
  if (route === '/host/passes') return Response.json(await runPasses(env));
  if (route === '/host/board-item') {
    // The Host's own board write, as a product creates a board row for its devices.
    const { scope, item } = await request.json() as { scope: string; item: Parameters<ByokCloud['createBoardItem']>[1] };
    const host = await compose(env, () => {});
    try {
      if (!host.scopes.has(scope)) return new Response('unknown scope\n', { status: 404 });
      return Response.json(await host.cloud.createBoardItem(tenantOf(scope), item));
    } finally { await host.close(); }
  }
  if (route === '/host/pairing-code') {
    const { scope } = await request.json() as { scope: string };
    const host = await compose(env, () => {});
    try {
      if (!host.scopes.has(scope)) return new Response('unknown scope\n', { status: 404 });
      return Response.json(await host.cloud.createPairingCode(tenantOf(scope), { productId: PRODUCT_ID }));
    } finally { await host.close(); }
  }
  return new Response('not found\n', { status: 404 });
}

/** `POST /host/input {botId, key, request}` with the owner's session bearer: H's authenticated command entry. */
async function serveInput(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const notify = notifier(env, ctx);
  const host = await compose(env, notify);
  try {
    const credential = await bearer(request);
    const entry = new HostedCommandEntry<string | undefined>(host.store, {
      authenticate: async token => {
        if (token === undefined) return undefined;
        const hashed = await sha256Hex(token);
        const found = [...host.scopes.values()].find(scope => scope.ownerTokenSha256 === hashed);
        return found && { scope: found.scope, principal: found.owner };
      },
      owner: scope => host.scopes.get(scope)!.owner.id,
      sync: host.syncScope,
    });
    const body = await request.json() as { botId: string; key: string; request: string };
    try {
      const turnId = await entry.input(credential, body.botId, body.key, body.request);
      // The commit froze the Turn's intent. The notified pass offers it; the next alarm pass would too.
      notify();
      return Response.json({ turnId });
    } catch (error) {
      if (error instanceof UnauthenticatedError) return Response.json({ error: error.code }, { status: 401 });
      if (error instanceof EntryRefusedError) return Response.json({ error: error.code }, { status: 403 });
      throw error;
    }
  } finally { await host.close(); }
}

/**
 * The device surface. The SDK observer's notification runs after the response. The pools stay open until the response body
 * ends or is cancelled, because a streamed route (the board SSE stream) keeps querying after the headers return.
 */
async function serveDevice(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const host = await compose(env, notifier(env, ctx));
  let response: Response;
  try { response = await host.cloud.fetch(request); } catch (error) { ctx.waitUntil(host.close()); throw error; }
  return releaseAfterBody(response, () => { ctx.waitUntil(host.close()); });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const route = new URL(request.url).pathname;
    try {
      if (route.startsWith('/byok/')) return await serveDevice(request, env, ctx);
      if (route.startsWith('/host/') && request.method === 'POST') return await serveHost(request, env, ctx, route);
    } catch (error) {
      return Response.json({ error: text(error) }, { status: 500 });
    }
    return new Response('routes: /byok/* (device surface); POST /host/input /host/passes /host/pairing-code /host/board-item\n', { status: 404 });
  },
  /** The cron trigger arms the clock and runs no pass. */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    console.log(`[h-clock] cron ${controller.cron} armed ${await armClock(env)}`);
  },
};
