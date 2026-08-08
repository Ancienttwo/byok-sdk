/**
 * Layer 2 of the six-layer isolation model (§12.6.2) — the tenant-closed
 * facade a handler actually receives.
 *
 * `@byok/core`'s `stores.ts` deliberately left this undefined: it is shaped by
 * how handlers are written, and the first handlers live here. This is that
 * shape, and the two properties it exists to enforce are:
 *
 * 1. **It can only be built from an authenticated principal.** {@link
 *    tenantStoresFor} is the only constructor, and its first parameter is a
 *    `Principal` — a value that only `authenticateBearer` (`auth/bearer.ts`)
 *    mints, and only from a device ROW. There is no path from a device-supplied
 *    string to a facade.
 * 2. **No handler ever passes a `TenantId` again.** Every method below has the
 *    tenant pre-applied, so a handler cannot read `principal.tenantId` off one
 *    principal and hand a different tenant to a store. Grep the handler tree
 *    for `TenantId` and you will not find one — asserted by
 *    `src/__tests__/constraints.test.ts`.
 *
 * The three pre-tenant store methods (`resolveByDeviceId`, `redeem`, the
 * presigned blob calls) are deliberately absent from this surface: a
 * device-facing handler must not be able to reach them.
 */
import {
  principalTenant,
  type CoreStores,
  type MailboxAdvanceCursorInput,
  type MailboxAppendInput,
  type MailboxCursorState,
  type MailboxMessage,
  type MailboxPage,
  type MailboxReadQuery,
  type Principal,
  type StorageFinalizeInput,
  type StorageFinalizeResult,
  type StorageReservation,
  type StorageReservationInput,
  type TenantId,
} from '@byok/core';
import type {
  BlobObservation,
  CloudStores,
  DeviceRecord,
  RequestReceipt,
  TaskAttempt,
  TaskAttemptStatus,
} from './stores/ports';

export interface TenantBoundMailbox {
  append(input: MailboxAppendInput): Promise<MailboxMessage>;
  /** Pure read. Never advances the cursor — the daemon's next poll is the only ack. */
  readAfter(query: MailboxReadQuery): Promise<MailboxPage>;
  advanceCursor(input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
  readCursor(deviceId: string): Promise<MailboxCursorState>;
}

export interface TenantBoundDevices {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  list(): Promise<readonly DeviceRecord[]>;
  revoke(deviceId: string): Promise<void>;
}

export interface TenantBoundTaskAttempts {
  open(input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt>;
  get(taskId: string): Promise<TaskAttempt | undefined>;
  claim(input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt | undefined>;
  recordStatus(input: { readonly taskId: string; readonly status: TaskAttemptStatus }): Promise<TaskAttempt | undefined>;
}

export interface TenantBoundDedup {
  checkAndRecord(deviceId: string, envelopeId: string): Promise<boolean>;
}

export interface TenantBoundReceipts {
  record(input: { readonly key: string; readonly body: string }): Promise<{
    readonly receipt: RequestReceipt;
    readonly created: boolean;
  }>;
  get(key: string): Promise<RequestReceipt | undefined>;
}

export interface TenantBoundBlobs {
  createUpload(reservation: StorageReservation): Promise<{ readonly blobId: string; readonly uploadUrl: string }>;
  observeUpload(blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
  getDownloadUrl(blobId: string): Promise<string | undefined>;
}

export interface TenantBoundQuota {
  readReservation(reservationId: string): Promise<StorageReservation | undefined>;
  reserve(input: StorageReservationInput): Promise<StorageReservation>;
  finalizeReservation(input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
  abortReservation(reservationId: string): Promise<StorageReservation>;
}

export interface TenantBoundSequence {
  next(deviceId: string): Promise<number>;
}

export interface TenantBoundRateLimiter {
  consume(deviceId: string): Promise<boolean>;
}

export interface TenantStores {
  readonly tenant: TenantId;
  readonly principal: Principal;
  readonly mailbox: TenantBoundMailbox;
  readonly devices: TenantBoundDevices;
  readonly tasks: TenantBoundTaskAttempts;
  readonly dedup: TenantBoundDedup;
  readonly receipts: TenantBoundReceipts;
  readonly blobs: TenantBoundBlobs;
  readonly quota: TenantBoundQuota;
  readonly sequence: TenantBoundSequence;
  readonly rateLimiter: TenantBoundRateLimiter;
}

/** Every naked store a composition supplies. Only {@link tenantStoresFor} reads this. */
export interface CloudRootStores {
  readonly core: CoreStores;
  readonly cloud: CloudStores;
}

export function tenantStoresFor(principal: Principal, root: CloudRootStores): TenantStores {
  const tenant = principalTenant(principal);
  const { core, cloud } = root;

  return {
    tenant,
    principal,
    mailbox: {
      append: (input) => core.mailbox.append(tenant, input),
      readAfter: (query) => core.mailbox.readAfter(tenant, query),
      advanceCursor: (input) => core.mailbox.advanceCursor(tenant, input),
      readCursor: (deviceId) => core.mailbox.readCursor(tenant, deviceId),
    },
    devices: {
      get: (deviceId) => cloud.devices.get(tenant, deviceId),
      list: () => cloud.devices.list(tenant),
      revoke: (deviceId) => cloud.devices.revoke(tenant, deviceId),
    },
    tasks: {
      open: (input) => cloud.tasks.open(tenant, input),
      get: (taskId) => cloud.tasks.get(tenant, taskId),
      claim: (input) => cloud.tasks.claim(tenant, input),
      recordStatus: (input) => cloud.tasks.recordStatus(tenant, input),
    },
    dedup: {
      checkAndRecord: (deviceId, envelopeId) => cloud.dedup.checkAndRecord(tenant, deviceId, envelopeId),
    },
    receipts: {
      record: (input) => cloud.receipts.record(tenant, input),
      get: (key) => cloud.receipts.get(tenant, key),
    },
    blobs: {
      createUpload: (reservation) => cloud.blobs.createUpload(tenant, reservation),
      observeUpload: (blobId, reservation) => cloud.blobs.observeUpload(tenant, blobId, reservation),
      getDownloadUrl: (blobId) => cloud.blobs.getDownloadUrl(tenant, blobId),
    },
    quota: {
      readReservation: (reservationId) => core.quota.readReservation(tenant, reservationId),
      reserve: (input) => core.quota.reserve(tenant, input),
      finalizeReservation: (input) => core.quota.finalizeReservation(tenant, input),
      abortReservation: (reservationId) => core.quota.abortReservation(tenant, reservationId),
    },
    sequence: {
      next: (deviceId) => cloud.sequence.next(tenant, deviceId),
    },
    rateLimiter: {
      consume: (deviceId) => cloud.rateLimiter.consume(tenant, deviceId),
    },
  };
}
