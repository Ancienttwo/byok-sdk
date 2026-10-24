import type { Pool } from 'pg';
import type { Json } from '@byok-sdk/example-host-execution-core';
import type { ChannelPort } from '@byok-sdk/example-bot-collaboration/channel';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { inSchema, lockScope, type DeliveryTimes, type HostedCollaborationStore } from './store';

/**
 * The Host's projection receiver. It must deduplicate by `(scope, id)`: a send is at least once, as K4's projection flush
 * is, and a crash after the receiver call and before the settle sends the same value again.
 */
export interface ProjectionPort {
  deliver(scope: string, id: string, value: Json, signal: AbortSignal): Promise<void>;
}
export interface SenderOptions {
  projections: ProjectionPort;
  /** The channel of the K8 deliveries. Absent: the Host has no channel, and a delivery row fails. */
  channel?: ChannelPort;
  now?: () => number;
  /** How long a claim holds a row. It must be longer than `sendTimeoutMs`, or a running send could be recovered. Default 60 s. */
  leaseMs?: number;
  /** The deadline of one receiver or channel send, as L's `sendTimeoutMs`. Default 15 s. */
  sendTimeoutMs?: number;
  /** The wait between two readbacks of an `unknown` delivery. Default 30 s. */
  readbackMs?: number;
  /** The wait after a failed projection send, or after a step that threw. Default 60 s. */
  backoffMs?: number;
  /** The most rows that one pass takes. */
  batch?: number;
}
/** A row whose step threw, or a projection send that failed. The pass went on with the next row. */
export interface SendFailure { scope: string; id: string; error: unknown }
/** `steps`: the rows on which this pass changed something, a send among them. */
export interface SendPass { steps: number; failed: SendFailure[] }

type DueRow = { scope: string; key: string; kind: 'projection' | 'delivery' };

/**
 * The H outbox sender (#793 D2b-out-2). One pass reads the unsettled rows that are due, across scopes, and runs each in its
 * own steps; a failed row does not stop the later rows.
 * - A projection is sent at least once: a claim raises `tries` and takes a lease under the scope lock, the receiver call runs
 *   with no lock, and the settle is fenced by that `tries`. A sent projection keeps its row, with `settled_at`.
 * - A delivery runs the K8 delivery rules through the store (`claimDelivery`, `finishDelivery`, `readDelivery`), as L's
 *   `flushDeliveries` does: the claim commits before the send, and a claim whose lease passed becomes `unknown`.
 */
export class HostedOutboxSender {
  private readonly now: () => number;
  private readonly times: DeliveryTimes;
  private readonly sendTimeoutMs: number;

  constructor(private readonly pool: Pool, private readonly store: HostedCollaborationStore, private readonly options: SenderOptions) {
    this.now = options.now ?? Date.now;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 15_000;
    this.times = { leaseMs: options.leaseMs ?? 60_000, readback: options.channel?.readback !== undefined, readbackMs: options.readbackMs ?? 30_000 };
    if (!Number.isSafeInteger(this.sendTimeoutMs) || this.sendTimeoutMs < 1 || !Number.isSafeInteger(this.times.leaseMs)
      || this.times.leaseMs <= this.sendTimeoutMs) throw new Error('The outbox lease must be longer than the send timeout');
  }

  async run(): Promise<SendPass> {
    // A scope of a store version this code does not support is left out before the limit, as in the submitter.
    const due = await inSchema(this.pool, this.store.schema, client => client.query<DueRow>(
      `SELECT o.scope, o.key, o.kind FROM outbox o JOIN scope s ON s.scope = o.scope
        WHERE s.state_version = ANY($1::integer[]) AND o.settled_at IS NULL AND o.next_at <= $2
        ORDER BY o.next_at, o.scope, o.ordinal LIMIT $3`, [[...SUPPORTED_STORE_VERSIONS], this.now(), this.options.batch ?? 100]), true);
    const pass: SendPass = { steps: 0, failed: [] };
    for (const row of due.rows) {
      const scope = JSON.parse(row.scope) as string, id = JSON.parse(row.key) as string;
      try {
        const step = row.kind === 'projection' ? await this.project(row.scope, row.key, scope, id) : await this.deliver(scope, id);
        if (step === false) continue;
        pass.steps++;
        if (step !== true) pass.failed.push({ scope, id, error: step.error });
      } catch (error) {
        pass.failed.push({ scope, id, error });
        await this.store.deferOutbox(scope, id, this.now() + (this.options.backoffMs ?? 60_000)).catch(() => undefined);
      }
    }
    return pass;
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
    let error: unknown;
    try { await this.deadline(signal => this.options.projections.deliver(scope, id, claim.body, signal)); }
    catch (cause) { error = cause; }
    await inSchema(this.pool, this.store.schema, async client => {
      await lockScope(client, scopeKey);
      const now = this.now();
      // A settle after another claim took the row matches nothing.
      if (error === undefined) {
        await client.query(`UPDATE outbox SET settled_at = $4, last_error = NULL WHERE scope = $1 AND key = $2 AND tries = $3
          AND settled_at IS NULL`, [scopeKey, key, claim.tries, now]);
      } else {
        await client.query(`UPDATE outbox SET last_error = $4, next_at = $5 WHERE scope = $1 AND key = $2 AND tries = $3
          AND settled_at IS NULL`, [scopeKey, key, claim.tries, message(error), now + (this.options.backoffMs ?? 60_000)]);
      }
    });
    return error === undefined ? true : { error };
  }

  /** D1-D5 of one delivery row. Returns false when the row needed no step. */
  private async deliver(scope: string, id: string): Promise<boolean | { error: unknown }> {
    const port = this.options.channel;
    if (!port) throw new Error('The Host has no channel for a delivery');
    const claim = await this.store.claimDelivery(scope, id, this.now(), this.times);
    if (claim.kind === 'none') return true;
    if (claim.kind === 'readback') {
      let result: Awaited<ReturnType<NonNullable<ChannelPort['readback']>>>;
      // Missing readback evidence leaves the row unknown, as in L. A readback that outlasts the send deadline is missing
      // evidence too, so one hung readback cannot stop the rest of the pass.
      try { result = await this.deadline(() => port.readback!(id)); }
      catch (error) {
        await this.store.deferOutbox(scope, id, this.now() + this.times.readbackMs);
        return { error };
      }
      await this.store.readDelivery(scope, id, claim.attempt, result, this.now(), this.times.readbackMs);
      return true;
    }
    let outcome: Parameters<HostedCollaborationStore['finishDelivery']>[3];
    try { outcome = { result: await this.deadline(signal => port.send({ deliveryId: id, route: claim.route, body: claim.body }, signal)) }; }
    catch (error) {
      // The send has started: neither an exception nor the deadline proves absence.
      outcome = { code: error instanceof SendDeadline ? 'send_timeout' : 'send_failed' };
    }
    await this.store.finishDelivery(scope, id, claim.attempt, outcome, this.now(), this.times);
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
