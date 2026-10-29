import { CollectExpiredFailure } from '../retention';
import { assertCollectExpiredInput, type CollectExpiredResult } from '../retention';
/**
 * In-memory {@link MailboxStore} reference (§12.7.3).
 *
 * Every row lives under a `(tenant, device)` composite key, so a cross-tenant
 * read is not "denied" — it addresses a different key space and finds nothing.
 * That is the in-memory expression of §12.6.2 layer 3: there is no bare device
 * index to accidentally query.
 *
 * Mailbox bytes are never counted: usage is the sum over the retained
 * `pending` rows, and a `limited` append sums, checks and inserts without
 * yielding, so no append on another device of the same tenant can interleave
 * with the check.
 */
import { ByokCoreError, CoreConflictError } from '../errors';
import type {
  MailboxAdvanceCursorInput,
  MailboxAppendInput,
  MailboxCursorState,
  MailboxMessage,
  MailboxPage,
  MailboxReadQuery,
  MailboxRecordDeliveryInput,
  MailboxCollectExpiredInput,
  MailboxExpirePendingInput,
  MailboxStore,
  MailboxUsage,
} from '../mailbox';
import type { QuotaStore } from '../quota';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';
import { registerArchiveAccess } from './archive-access';
import { assertCanonicalTimestamp } from '../time';

const DEFAULT_READ_LIMIT = 50;

interface DeviceMailbox {
  nextSeq: number;
  deliveredSeq: number;
  ackedSeq: number;
  cursorUpdatedAt: string;
  mutationTail: Promise<void>;
  readonly messages: MailboxMessage[];
  readonly byMessageId: Map<string, MailboxMessage>;
}

export class InMemoryMailboxStore implements MailboxStore {
  readonly #devices = new Map<string, DeviceMailbox>();
  readonly #clock: Clock;
  readonly #quota: Pick<QuotaStore, 'readEntitlement'>;

  /** The mailbox reads its limit from quota; quota never reads the mailbox. */
  constructor(clock: Clock, quota: Pick<QuotaStore, 'readEntitlement'>) {
    this.#clock = clock;
    this.#quota = quota;
    registerArchiveAccess(this, {
      messagesOf: (tenant, deviceId) => this.#devices.get(tenantKey(tenant, deviceId))?.messages ?? [],
      replaceBody: (tenant, deviceId, seq, body) => {
        const device = this.#devices.get(tenantKey(tenant, deviceId));
        const index = device?.messages.findIndex((message) => message.seq === seq) ?? -1;
        if (device === undefined || index < 0) return;
        const replaced: MailboxMessage = { ...device.messages[index]!, ...body };
        device.messages[index] = replaced;
        device.byMessageId.set(replaced.messageId, replaced);
      },
    });
  }

  async append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage> {
    const device = this.#device(tenant, input.deviceId);
    const appended = device.mutationTail.then(async () => {
      const existing = device.byMessageId.get(input.messageId);
      if (existing !== undefined) return existing;

      // Anything but the one exempt class is limited: an unknown admission
      // fails closed instead of skipping the check.
      const limit =
        input.admission === 'cancellation' ? undefined : await this.#mailboxLimit(tenant);
      const seq = device.nextSeq;
      const materialized = await input.materialize(seq);
      // No await from here to the push: the sum, the check and the insert are
      // one synchronous step, so the check is exact across devices.
      if (limit !== undefined) {
        const used = this.#usedBytes(tenant);
        if (used + materialized.byteSize > limit) {
          throw new ByokCoreError(
            'storage_quota_exceeded',
            `Mailbox would reach ${String(used + materialized.byteSize)} bytes, over the limit of ${String(limit)} bytes.`,
          );
        }
      }
      const message: MailboxMessage = {
        tenantId: tenant,
        deviceId: input.deviceId,
        seq,
        messageId: input.messageId,
        ...materialized,
        state: 'pending',
        appendedAt: this.#now(),
      };
      device.nextSeq += 1;
      device.messages.push(message);
      device.byMessageId.set(message.messageId, message);
      return message;
    });
    // A failed materializer rejects its own append but must not poison the
    // per-device serializer; the next append starts from the same sequence.
    device.mutationTail = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  async readUsage(tenant: TenantId): Promise<MailboxUsage> {
    return { bytes: this.#usedBytes(tenant) };
  }

  async readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage> {
    const device = this.#devices.get(tenantKey(tenant, query.deviceId));
    const limit = query.limit ?? DEFAULT_READ_LIMIT;
    if (device === undefined) {
      // A device with no mailbox has lost nothing, so cursor 0 is inside its
      // (empty) window rather than behind a floor it could never have met.
      return { messages: [], nextSeq: query.afterSeq, hasMore: false, recoverableFrom: 1 };
    }
    const pending = device.messages
      .filter((message) => message.state === 'pending' && message.seq > query.afterSeq)
      .sort((left, right) => left.seq - right.seq);
    const page = pending.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: page,
      // Reading is not acknowledging: the returned position is a *read* cursor.
      // Nothing above was mutated, so an identical call replays the same page.
      nextSeq: last?.seq ?? query.afterSeq,
      hasMore: pending.length > page.length,
      // Computed over the WHOLE mailbox, not the queried slice: the floor is a
      // property of the device's history, and reporting it relative to
      // `afterSeq` would make every cursor look recoverable from itself.
      recoverableFrom: this.#recoverableFrom(device),
    };
  }

  async advanceCursor(
    tenant: TenantId,
    input: MailboxAdvanceCursorInput,
  ): Promise<MailboxCursorState> {
    const device = this.#device(tenant, input.deviceId);
    const advanced = device.mutationTail.then(() => {
      if (input.ackedSeq < device.ackedSeq) {
        throw new CoreConflictError(
          'mailbox_cursor_regression',
          `Cursor for device ${input.deviceId} is at ${device.ackedSeq}; refusing to move it back to ${input.ackedSeq}.`,
          this.#cursorState(tenant, input.deviceId, device),
          this.#now(),
        );
      }
      if (input.ackedSeq > device.deliveredSeq) {
        throw new CoreConflictError(
          'mailbox_cursor_ahead_of_delivery',
          `Cursor for device ${input.deviceId} was delivered through ${device.deliveredSeq}; refusing to acknowledge future cursor ${input.ackedSeq}.`,
          this.#cursorState(tenant, input.deviceId, device),
          this.#now(),
        );
      }
      device.ackedSeq = input.ackedSeq;
      device.cursorUpdatedAt = this.#now();
      for (const [index, message] of device.messages.entries()) {
        if (message.state === 'pending' && message.seq <= input.ackedSeq) {
          device.messages[index] = { ...message, state: 'acked' };
          device.byMessageId.set(message.messageId, device.messages[index]!);
        }
      }
      return this.#cursorState(tenant, input.deviceId, device);
    });
    device.mutationTail = advanced.then(
      () => undefined,
      () => undefined,
    );
    return advanced;
  }

  async recordDelivery(
    tenant: TenantId,
    input: MailboxRecordDeliveryInput,
  ): Promise<MailboxCursorState> {
    const device = this.#device(tenant, input.deviceId);
    const recorded = device.mutationTail.then(() => {
      if (input.deliveredSeq > device.deliveredSeq) {
        device.deliveredSeq = input.deliveredSeq;
      }
      return this.#cursorState(tenant, input.deviceId, device);
    });
    device.mutationTail = recorded.then(
      () => undefined,
      () => undefined,
    );
    return recorded;
  }

  async readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState> {
    const device = this.#devices.get(tenantKey(tenant, deviceId));
    if (device === undefined) {
      return { tenantId: tenant, deviceId, deliveredSeq: 0, ackedSeq: 0, updatedAt: this.#now() };
    }
    return this.#cursorState(tenant, deviceId, device);
  }

  async collectExpired(tenant: TenantId, input: MailboxCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.ackedBefore, 'ackedBefore');
    assertCanonicalTimestamp(input.expireUnackedBefore, 'expireUnackedBefore');
    assertCanonicalTimestamp(input.reapDeadLettersBefore, 'reapDeadLettersBefore');
    let removed = 0, expired = 0, more = false;
    // The reap runs before this call's expiry, so only rows that were already
    // `expired` qualify, and never the device's highest-seq dead letter: that
    // row is the recoverableFrom floor.
    const reapable = (device: DeviceMailbox, message: MailboxMessage): boolean =>
      message.state === 'expired' && message.appendedAt < input.reapDeadLettersBefore
      && device.messages.some((other) => other.state === 'expired' && other.seq > message.seq);
    try {
      phases: for (const phase of ['acked', 'reap', 'pending'] as const) {
        for (const [key, device] of this.#devices) {
          if (!key.startsWith(tenantKey(tenant, ''))) continue;
          const collected = device.mutationTail.then(() => {
            for (let index = 0; index < device.messages.length;) {
              const message = device.messages[index]!;
              const eligible = phase === 'reap'
                ? reapable(device, message)
                : message.state === phase
                  && message.appendedAt < (phase === 'acked' ? input.ackedBefore : input.expireUnackedBefore);
              if (!eligible) { index++; continue; }
              if (removed + expired === input.limit) { more = true; return; }
              if (phase === 'pending') {
                const retired: MailboxMessage = { ...message, state: 'expired' };
                device.messages[index] = retired;
                device.byMessageId.set(retired.messageId, retired);
                expired++; index++;
              } else {
                device.messages.splice(index, 1);
                device.byMessageId.delete(message.messageId);
                removed++;
              }
            }
          });
          device.mutationTail = collected.then(() => undefined, () => undefined);
          await collected;
          if (more) break phases;
        }
      }
      // This call's expiry can leave rows reapable for the next call.
      if (!more) {
        more = [...this.#devices].some(([key, device]) => key.startsWith(tenantKey(tenant, ''))
          && device.messages.some((message) => reapable(device, message)));
      }
    } catch (cause) {
      throw new CollectExpiredFailure({ removed, expired, releasedBytes: 0n }, 0, undefined, { cause });
    }
    // Mailbox usage is the pending rows, never a mutable accounting counter, so no phase moves it.
    return { removed, expired, releasedBytes: 0n, more };
  }

  async expirePending(tenant: TenantId, input: MailboxExpirePendingInput): Promise<{ readonly expired: number }> {
    const device = this.#devices.get(tenantKey(tenant, input.deviceId));
    if (device === undefined) return { expired: 0 };
    const selected = input.seqs === 'all' ? undefined : new Set(input.seqs);
    const retired = device.mutationTail.then(() => {
      let expired = 0;
      for (const [index, message] of device.messages.entries()) {
        if (message.state !== 'pending' || (selected !== undefined && !selected.has(message.seq))) continue;
        const dead: MailboxMessage = { ...message, state: 'expired' };
        device.messages[index] = dead;
        device.byMessageId.set(dead.messageId, dead);
        expired++;
      }
      return { expired };
    });
    device.mutationTail = retired.then(() => undefined, () => undefined);
    return retired;
  }

  async #mailboxLimit(tenant: TenantId): Promise<bigint> {
    const entitlement = await this.#quota.readEntitlement(tenant);
    if (entitlement === undefined) {
      throw new ByokCoreError(
        'storage_entitlement_missing',
        'No storage entitlement has been issued for this tenant.',
      );
    }
    return entitlement.mailboxLimitBytes;
  }

  /**
   * Every `pending` row of the tenant, on any device. Acked and dead-lettered
   * rows are retained but hold no quota (#1115).
   */
  #usedBytes(tenant: TenantId): bigint {
    const prefix = tenantKey(tenant, '');
    let bytes = 0n;
    for (const [key, device] of this.#devices.entries()) {
      if (!key.startsWith(prefix)) continue;
      for (const message of device.messages) {
        if (message.state === 'pending') bytes += message.byteSize;
      }
    }
    return bytes;
  }

  #device(tenant: TenantId, deviceId: string): DeviceMailbox {
    if (deviceId.length === 0) {
      throw new ByokCoreError('mailbox_message_not_found', 'Device id must not be empty.');
    }
    const key = tenantKey(tenant, deviceId);
    const existing = this.#devices.get(key);
    if (existing !== undefined) return existing;
    const created: DeviceMailbox = {
      nextSeq: 1,
      deliveredSeq: 0,
      ackedSeq: 0,
      cursorUpdatedAt: this.#now(),
      mutationTail: Promise.resolve(),
      messages: [],
      byMessageId: new Map(),
    };
    this.#devices.set(key, created);
    return created;
  }

  /**
   * One past the highest row this device lost, which is exactly the highest
   * `expired` seq: dead-lettered rows are kept rather than deleted (§12.7.5),
   * so the loss stays observable and needs no column of its own to remember it.
   *
   * `acked` is deliberately not counted. A consumed row is not a lost one, and
   * counting it would turn a daemon re-polling from an old cursor — which the
   * at-least-once contract explicitly allows — into a hard failure.
   */
  #recoverableFrom(device: DeviceMailbox): number {
    let lost = 0;
    for (const message of device.messages) {
      if (message.state === 'expired' && message.seq > lost) lost = message.seq;
    }
    return lost + 1;
  }

  #cursorState(
    tenant: TenantId,
    deviceId: string,
    device: DeviceMailbox,
  ): MailboxCursorState {
    return {
      tenantId: tenant,
      deviceId,
      deliveredSeq: device.deliveredSeq,
      ackedSeq: device.ackedSeq,
      updatedAt: device.cursorUpdatedAt,
    };
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
