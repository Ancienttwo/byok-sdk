import type { Pool } from 'pg';
import type { Json } from '@byok-sdk/example-host-execution-core';
import type { ChannelPort } from '@byok-sdk/example-bot-collaboration/channel';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { checkHomeReadback, homeRequests, type HomeReadback } from '@byok-sdk/example-bot-collaboration/team';
import { CONNECTOR_TIMEOUT, inSchema, lockScope, type DeliveryTimes, type HomeClaim, type HomeStep, type HostedCollaborationStore } from './store';

/**
 * The Host's projection receiver. It must deduplicate by `(scope, id)`: a send is at least once, as K4's projection flush
 * is, and a crash after the receiver call and before the settle sends the same value again.
 */
export interface ProjectionPort {
  deliver(scope: string, id: string, value: Json, signal: AbortSignal): Promise<void>;
}
type HomeRequest = Extract<HomeClaim, { kind: 'flush' }>['op']['request'];
/**
 * The SDK Agent home calls of one tenant (#793 S13), as L binds `readAgentHomeProjection` and `enqueueAgentHomeProjection`:
 * the SDK `getAgentHomeProjectionStatus` and `enqueueAgentHomeProjection` for the request's device.
 */
export interface HostedHomePort {
  read(request: HomeRequest): Promise<HomeReadback | undefined>;
  enqueue(request: HomeRequest): Promise<unknown>;
}
/** The Host connector of a confirmed card (#793 S12), as L's `HostOptions.connector`. */
export type CardConnector = (id: string, action: string, draft: Json, signal: AbortSignal) => Promise<unknown>;
export interface SenderOptions {
  projections: ProjectionPort;
  /** The channel of the K8 deliveries. Absent: the Host has no channel, and a delivery row fails. */
  channel?: ChannelPort;
  /** The connector of the confirmed cards. Absent: the Host has no connector, and a card row fails. */
  connector?: CardConnector;
  /** The deadline of one connector call, as L's `connectorTimeoutMs`. Default 30 s. With a connector, `leaseMs` must be longer. */
  connectorTimeoutMs?: number;
  /** The Agent home calls of the tenant that owns `scope`. Absent: the Host has no home port, and a home row fails. */
  homes?: (scope: string) => HostedHomePort;
  /**
   * Called once per pass for each scope whose state a card call or a home operation's terminal changed, so the deployment
   * syncs it, as the reconciler's `changed`.
   */
  changed?: (scope: string) => void;
  now?: () => number;
  /** How long a claim holds a row. It must be longer than `sendTimeoutMs`, or a running send could be recovered. Default 60 s. */
  leaseMs?: number;
  /** The deadline of one receiver or channel send, as L's `sendTimeoutMs`. Default 15 s. */
  sendTimeoutMs?: number;
  /** The wait between two readbacks of an `unknown` delivery. Default 30 s. */
  readbackMs?: number;
  /** The wait after a failed projection send, or after a step that threw. It does not grow with `tries`. Default 60 s. */
  backoffMs?: number;
  /** The most rows that one pass takes. Default 100. */
  batch?: number;
}
/**
 * A row whose step threw, or a projection send or delivery readback that failed. The pass went on with the next row. `id` is
 * the row's id: a projection or delivery id, `['card', cardId]` or `['home', sequence]`.
 */
export interface SendFailure { scope: string; id: OutboxId; error: unknown }
export type OutboxId = string | readonly ['card', string] | readonly ['home', number];
/** `steps`: the rows on which this pass changed something, a send among them. */
export interface SendPass { steps: number; failed: SendFailure[] }

type DueRow = { scope: string; key: string; kind: 'projection' | 'delivery' | 'card' | 'home' };

/**
 * The H outbox sender (#793 D2b-out-2). One pass reads the unsettled rows that are due, across scopes, and runs each in its
 * own steps; a failed row does not stop the later rows.
 * - A projection is sent at least once: a claim raises `tries` and takes a lease under the scope lock, the receiver call runs
 *   with no lock, and the settle is fenced by that `tries`. A sent projection keeps its row, with `settled_at`.
 * - A delivery runs the K8 delivery rules through the store (`claimDelivery`, `finishDelivery`, `readDelivery`), as L's
 *   `flushDeliveries` does: the claim commits before the send, and a claim whose lease passed becomes `unknown`.
 * - A card calls its connector at most once (#793 S12): the claim (`claimCard`) takes a try and a lease before the call, the
 *   call runs with no lock and `connectorTimeoutMs`, and the settle (`settleCard`) is fenced by that try. A claim whose lease
 *   passed with no settle ends the card as a timeout, where L calls again after a crash (owner Q3 A).
 * - An Agent home operation runs L's `flushHomes` step (#793 S13): the claim (`claimHome`) checks that it is its Bot's head
 *   and takes a lease, the readbacks and the enqueue run with no lock, and each settle is fenced by the operation's retry
 *   count. The operation is the authority: its `retryAt` is the row's `next_at`, so H enqueues at `retryAt` where L enqueues
 *   again at each pass.
 */
export class HostedOutboxSender {
  private readonly now: () => number;
  private readonly times: DeliveryTimes;
  private readonly sendTimeoutMs: number;
  private readonly connectorTimeoutMs: number;
  private readonly backoffMs: number;
  private readonly batch: number;

  constructor(private readonly pool: Pool, private readonly store: HostedCollaborationStore, private readonly options: SenderOptions) {
    this.now = options.now ?? Date.now;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 15_000;
    this.backoffMs = options.backoffMs ?? 60_000;
    this.batch = options.batch ?? 100;
    this.times = { leaseMs: options.leaseMs ?? 60_000, readback: options.channel?.readback !== undefined, readbackMs: options.readbackMs ?? 30_000 };
    if (!Number.isSafeInteger(this.sendTimeoutMs) || this.sendTimeoutMs < 1 || !Number.isSafeInteger(this.times.leaseMs)
      || this.times.leaseMs <= this.sendTimeoutMs) throw new Error('The outbox lease must be longer than the send timeout');
    if (![this.backoffMs, this.times.readbackMs, this.batch].every(value => Number.isSafeInteger(value) && value >= 1)) {
      throw new Error('The outbox backoff, readback wait and batch must be positive integers');
    }
    this.connectorTimeoutMs = options.connectorTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.connectorTimeoutMs) || this.connectorTimeoutMs < 1 || this.connectorTimeoutMs > 2_147_483_647
      || options.connector && this.times.leaseMs <= this.connectorTimeoutMs) {
      throw new Error('The outbox lease must be longer than the connector timeout');
    }
  }

  async run(): Promise<SendPass> {
    // A scope of a store version this code does not support is left out before the limit, as in the submitter.
    const due = await inSchema(this.pool, this.store.schema, client => client.query<DueRow>(
      `SELECT o.scope, o.key, o.kind FROM outbox o JOIN scope s ON s.scope = o.scope
        WHERE s.state_version = ANY($1::integer[]) AND o.settled_at IS NULL AND o.next_at <= $2
        ORDER BY o.next_at, o.scope, o.ordinal LIMIT $3`, [[...SUPPORTED_STORE_VERSIONS], this.now(), this.batch]), true);
    const pass: SendPass = { steps: 0, failed: [] }, changed = new Set<string>();
    for (const row of due.rows) {
      const scope = JSON.parse(row.scope) as string, id = JSON.parse(row.key) as OutboxId;
      try {
        const step = row.kind === 'card' ? await this.call(scope, (id as readonly ['card', string])[1], changed)
          : row.kind === 'home' ? await this.home(scope, (id as readonly ['home', number])[1], changed)
          : row.kind === 'projection' ? await this.project(row.scope, row.key, scope, id as string) : await this.deliver(scope, id as string);
        if (step === false) continue;
        pass.steps++;
        if (step !== true) pass.failed.push({ scope, id, error: step.error });
      } catch (error) {
        pass.failed.push({ scope, id, error });
        // A failure to write the wait is a store failure, not a row failure, so it ends the pass. It keeps the step error.
        try { await this.store.deferOutbox(scope, id, this.now, this.backoffMs); }
        catch (deferError) { throw new AggregateError([deferError, error], message(deferError)); }
      }
    }
    for (const scope of changed) this.options.changed?.(scope);
    return pass;
  }

  /**
   * C1-C3 of one card row: claim, one connector call, fenced settle. A connector error or timeout is the card's outcome, as
   * in L, not a failed step. Returns false when the claim found nothing to call.
   */
  private async call(scope: string, cardId: string, changed: Set<string>): Promise<boolean> {
    const connector = this.options.connector;
    if (!connector) throw new Error('The Host has no connector for a card call');
    const claim = await this.store.claimCard(scope, cardId, this.now, this.times.leaseMs);
    if (claim.kind === 'none') return false;
    if (claim.kind === 'ended') { changed.add(scope); return true; }
    let outcome: Parameters<HostedCollaborationStore['settleCard']>[3];
    try { outcome = { result: await this.callDeadline(signal => connector(cardId, claim.action, claim.draft, signal)) }; }
    catch (error) { outcome = { error }; }
    if (await this.store.settleCard(scope, cardId, claim.tries, outcome, this.now)) changed.add(scope);
    return true;
  }

  /**
   * H1-H4 of one home row: claim, the readback of each request in order (K8 `checkHomeReadback`), the fenced settle, then for
   * a retry the enqueue of the latest request and `homeEnqueued`. A read or enqueue that throws or outlasts `sendTimeoutMs`
   * is the operation's error (K8 `failHomeFlush`), as a throw is in L, which awaits these calls with no deadline. Returns
   * false when the claim found nothing to flush.
   */
  private async home(scope: string, sequence: number, changed: Set<string>): Promise<boolean | { error: unknown }> {
    const homes = this.options.homes;
    if (!homes) throw new Error('The Host has no Agent home port for a home operation');
    const claim = await this.store.claimHome(scope, sequence, this.now, this.times.leaseMs, this.backoffMs);
    if (claim.kind === 'none') return false;
    const port = homes(scope);
    let step: HomeStep;
    try {
      let terminal: HomeReadback | undefined;
      for (const request of homeRequests(claim.op)) {
        terminal = checkHomeReadback(request, await this.deadline(() => port.read(request)));
        if (terminal) break;
      }
      step = terminal ? { terminal } : { retry: true };
    } catch (error) { step = { error }; }
    const settled = await this.store.settleHome(scope, sequence, claim.retries, step, this.now, claim.lease);
    if ('terminal' in step && settled) changed.add(scope);
    if ('error' in step) return { error: step.error };
    if (!settled?.enqueue) return true;
    try { await this.deadline(() => port.enqueue(settled.enqueue!)); }
    catch (error) {
      await this.store.settleHome(scope, sequence, settled.retries, { error }, this.now, claim.lease);
      return { error };
    }
    await this.store.homeEnqueued(scope, sequence, settled.retries, this.now);
    return true;
  }

  /** A connector call with an abort signal, which rejects with L's timeout error after `connectorTimeoutMs`. */
  private async callDeadline<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { const error = new Error(CONNECTOR_TIMEOUT); controller.abort(error); reject(error); }, this.connectorTimeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => call(controller.signal)), deadline]); }
    finally { clearTimeout(timer); }
  }

  /** P1-P3 of one projection row. Returns false when another sender holds it or it settled, true when sent. */
  private async project(scopeKey: string, key: string, scope: string, id: string): Promise<boolean | { error: unknown }> {
    const claim = await inSchema(this.pool, this.store.schema, async client => {
      await lockScope(client, scopeKey);
      const now = this.now();
      const found = await client.query<{ body: Json; tries: number }>(`UPDATE outbox SET tries = tries + 1, next_at = $3 + $4
        WHERE scope = $1 AND key = $2 AND kind = 'projection' AND settled_at IS NULL AND next_at <= $3 RETURNING body, tries`,
      [scopeKey, key, now, this.times.leaseMs]);
      return found.rows[0];
    });
    if (!claim) return false;
    // A tagged failure: a receiver may reject with `undefined`, and that is a failure too.
    let failure: { error: unknown } | undefined;
    try { await this.deadline(signal => this.options.projections.deliver(scope, id, claim.body, signal)); }
    catch (error) { failure = { error }; }
    await inSchema(this.pool, this.store.schema, async client => {
      await lockScope(client, scopeKey);
      const now = this.now();
      // A settle after another claim took the row matches nothing.
      if (!failure) {
        await client.query(`UPDATE outbox SET settled_at = $4, last_error = NULL WHERE scope = $1 AND key = $2 AND tries = $3
          AND settled_at IS NULL`, [scopeKey, key, claim.tries, now]);
      } else {
        await client.query(`UPDATE outbox SET last_error = $4, next_at = $5 WHERE scope = $1 AND key = $2 AND tries = $3
          AND settled_at IS NULL`, [scopeKey, key, claim.tries, message(failure.error), now + this.backoffMs]);
      }
    });
    return failure ?? true;
  }

  /** D1-D5 of one delivery row. Returns false when the row needed no step. */
  private async deliver(scope: string, id: string): Promise<boolean | { error: unknown }> {
    const port = this.options.channel;
    if (!port) throw new Error('The Host has no channel for a delivery');
    const claim = await this.store.claimDelivery(scope, id, this.now, this.times);
    if (claim.kind === 'none') return false;
    if (claim.kind === 'moved') return true;
    if (claim.kind === 'readback') {
      // Missing readback evidence leaves the row unknown, as in L. A readback that outlasts the send deadline is missing
      // evidence too, so one hung readback cannot stop the rest of the pass. Its wait is fenced by the attempt it read back,
      // and by its claim's lease, so a later readback claim keeps the row.
      let result: Awaited<ReturnType<NonNullable<ChannelPort['readback']>>> | undefined, failure: { error: unknown } | undefined;
      try { result = await this.deadline(() => port.readback!(id)); }
      catch (error) { failure = { error }; }
      await this.store.readDelivery(scope, id, claim.attempt, claim.lease, result, this.now, this.times.readbackMs);
      return failure ?? true;
    }
    let outcome: Parameters<HostedCollaborationStore['finishDelivery']>[3];
    try { outcome = { result: await this.deadline(signal => port.send({ deliveryId: id, route: claim.route, body: claim.body }, signal)) }; }
    catch (error) {
      // The send has started: neither an exception nor the deadline proves absence.
      outcome = { code: error instanceof SendDeadline ? 'send_timeout' : 'send_failed' };
    }
    await this.store.finishDelivery(scope, id, claim.attempt, outcome, this.now, this.times);
    return true;
  }

  /**
   * Runs a channel or receiver call with an abort signal, and rejects with `SendDeadline` after `sendTimeoutMs`, as L's
   * delivery deadline. H bounds a readback with it too, where L awaits a readback with no deadline.
   */
  private async deadline<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SendDeadline()); }, this.sendTimeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => send(controller.signal)), deadline]); }
    finally { clearTimeout(timer); }
  }
}

class SendDeadline extends Error {
  constructor() { super('send_timeout'); this.name = 'SendDeadline'; }
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1024);
