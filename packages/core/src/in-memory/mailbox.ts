/**
 * In-memory {@link MailboxStore} reference (§12.7.3).
 *
 * Every row lives under a `(tenant, device)` composite key, so a cross-tenant
 * read is not "denied" — it addresses a different key space and finds nothing.
 * That is the in-memory expression of §12.6.2 layer 3: there is no bare device
 * index to accidentally query.
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
  MailboxRetentionInput,
  MailboxRetentionResult,
  MailboxStore,
} from '../mailbox';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';
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

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage> {
    const device = this.#device(tenant, input.deviceId);
    const appended = device.mutationTail.then(async () => {
      const existing = device.byMessageId.get(input.messageId);
      if (existing !== undefined) return existing;

      const seq = device.nextSeq;
      const materialized = await input.materialize(seq);
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

  async collectRetired(
    tenant: TenantId,
    input: MailboxRetentionInput,
  ): Promise<MailboxRetentionResult> {
    // Both cutoffs are compared against `appendedAt` as strings; the canonical
    // form is what makes that a time comparison. Validate before the sweep so a
    // malformed cutoff deletes nothing rather than a wrong prefix of history.
    assertCanonicalTimestamp(input.ackedBefore, 'ackedBefore');
    assertCanonicalTimestamp(input.expireUnackedBefore, 'expireUnackedBefore');

    let deletedCount = 0;
    let expiredCount = 0;
    let releasedBytes = 0n;

    for (const [key, device] of this.#devices.entries()) {
      if (!key.startsWith(tenantKey(tenant, ''))) continue;
      if (input.deviceId !== undefined && key !== tenantKey(tenant, input.deviceId)) continue;

      for (let index = device.messages.length - 1; index >= 0; index -= 1) {
        const message = device.messages[index]!;
        if (message.state === 'acked' && message.appendedAt < input.ackedBefore) {
          device.messages.splice(index, 1);
          device.byMessageId.delete(message.messageId);
          deletedCount += 1;
          releasedBytes += message.byteSize;
          continue;
        }
        if (message.state === 'pending' && message.appendedAt < input.expireUnackedBefore) {
          // Dead-letter, never delete: §12.7.5 requires an unacked row that
          // aged out to stay visible instead of disappearing silently.
          const expired: MailboxMessage = { ...message, state: 'expired' };
          device.messages[index] = expired;
          device.byMessageId.set(expired.messageId, expired);
          expiredCount += 1;
        }
      }
    }

    return { deletedCount, expiredCount, releasedBytes };
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
