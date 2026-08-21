/**
 * Layer 2 of the six-layer isolation model (§12.6.2) — the tenant-closed
 * facade a handler actually receives.
 *
 * `@byok-sdk/core`'s `stores.ts` deliberately left this undefined: it is shaped by
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
  type BoardClaimInput,
  type BoardItem,
  type BoardItemInput,
  type BoardListQuery,
  type BoardPage,
  type BoardStatusUpdateInput,
  type BoardUnclaimInput,
  type CoreStores,
  type MailboxAdvanceCursorInput,
  type MailboxAppendInput,
  type MailboxCursorState,
  type MailboxMessage,
  type MailboxPage,
  type MailboxReadQuery,
  type Principal,
  type PresenceHint,
  type PresenceHintInput,
  type StorageFinalizeInput,
  type StorageFinalizeResult,
  type StorageReservation,
  type StorageReservationInput,
  type TenantId,
} from '@byok-sdk/core';
import type { ActivityAppendInput, ActivityTail } from './activity';
import type {
  ApprovalTimelineAppendInput,
  ApprovalTimelineTail,
} from './approval-timeline';
import type {
  BlobObservation,
  CloudStores,
  DeviceRecord,
  RequestReceipt,
  TaskCancellationMutation,
  TaskCancellationRequest,
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

export interface TenantBoundBoard {
  create(input: BoardItemInput): Promise<BoardItem>;
  get(itemId: string): Promise<BoardItem | undefined>;
  list(query: BoardListQuery): Promise<BoardPage>;
  claim(input: BoardClaimInput): Promise<BoardItem>;
  unclaim(input: BoardUnclaimInput): Promise<BoardItem>;
  updateStatus(input: BoardStatusUpdateInput): Promise<BoardItem>;
}

export interface TenantBoundPresence {
  publish(input: PresenceHintInput): Promise<PresenceHint>;
  read(deviceId: string): Promise<PresenceHint | undefined>;
  list(): Promise<readonly PresenceHint[]>;
}

export interface TenantBoundActivity {
  append(input: ActivityAppendInput): Promise<ActivityTail>;
  read(taskId: string): Promise<ActivityTail | undefined>;
}

export interface TenantBoundApprovalTimeline {
  append(input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
  read(taskId: string): Promise<ApprovalTimelineTail | undefined>;
}

export interface TenantBoundDevices {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  list(): Promise<readonly DeviceRecord[]>;
  revoke(deviceId: string): Promise<void>;
}

export interface TenantBoundTaskAttempts {
  open(input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt>;
  get(taskId: string): Promise<TaskAttempt | undefined>;
  getMany(taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
  claim(input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt | undefined>;
  recordStatus(input: { readonly taskId: string; readonly status: TaskAttemptStatus }): Promise<TaskAttempt | undefined>;
}

export interface TenantBoundTaskCancellations {
  request(input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
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

export interface TenantBoundRateLimiter {
  consume(deviceId: string): Promise<boolean>;
}

export interface TenantStores {
  readonly tenant: TenantId;
  readonly principal: Principal;
  readonly mailbox: TenantBoundMailbox;
  readonly board: TenantBoundBoard;
  readonly presence: TenantBoundPresence;
  readonly activity: TenantBoundActivity;
  readonly approvals: TenantBoundApprovalTimeline;
  readonly devices: TenantBoundDevices;
  readonly tasks: TenantBoundTaskAttempts;
  readonly cancellations: TenantBoundTaskCancellations;
  readonly dedup: TenantBoundDedup;
  readonly receipts: TenantBoundReceipts;
  readonly blobs: TenantBoundBlobs;
  readonly quota: TenantBoundQuota;
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
    board: {
      create: (input) => core.board.create(tenant, input),
      get: (itemId) => core.board.get(tenant, itemId),
      list: (query) => core.board.list(tenant, query),
      claim: (input) => core.board.claim(tenant, input),
      unclaim: (input) => core.board.unclaim(tenant, input),
      updateStatus: (input) => core.board.updateStatus(tenant, input),
    },
    presence: {
      publish: (input) => core.presence.publish(tenant, input),
      read: (deviceId) => core.presence.read(tenant, deviceId),
      list: () => core.presence.list(tenant),
    },
    activity: {
      append: (input) => cloud.activity.append(tenant, input),
      read: (taskId) => cloud.activity.read(tenant, taskId),
    },
    approvals: {
      append: (input) => cloud.approvals.append(tenant, input),
      read: (taskId) => cloud.approvals.read(tenant, taskId),
    },
    devices: {
      get: (deviceId) => cloud.devices.get(tenant, deviceId),
      list: () => cloud.devices.list(tenant),
      revoke: (deviceId) => cloud.devices.revoke(tenant, deviceId),
    },
    tasks: {
      open: (input) => cloud.tasks.open(tenant, input),
      get: (taskId) => cloud.tasks.get(tenant, taskId),
      getMany: (taskIds) => cloud.tasks.getMany(tenant, taskIds),
      claim: (input) => cloud.tasks.claim(tenant, input),
      recordStatus: (input) => cloud.tasks.recordStatus(tenant, input),
    },
    cancellations: {
      request: (input) => cloud.cancellations.request(tenant, input),
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
    rateLimiter: {
      consume: (deviceId) => cloud.rateLimiter.consume(tenant, deviceId),
    },
  };
}
