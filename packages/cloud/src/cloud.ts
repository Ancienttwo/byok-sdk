/**
 * `createByokCloud` — the hosted device surface, assembled.
 *
 * What this is NOT: an embedded coordinator. There is no `TaskHandle`, no
 * connection registry, no per-task object that a host holds onto. Sprint 0.1's
 * non-goal is explicit about that — the embedded `TaskHandle` must not become
 * the hosted API — so the host's control-plane input is a function
 * ({@link ByokCloud.enqueueOffer}) and its read model is a store query
 * ({@link ByokCloud.readTaskAttempt}).
 *
 * Every route is stateless in the strict sense: it resolves a principal from
 * the request, binds stores to that principal's tenant, and returns. Nothing
 * survives the response but what a store wrote. The one shape that would
 * quietly undo that — a Running/session map — is asserted absent by
 * `src/__tests__/constraints.test.ts`.
 */
import {
  contentHash,
  parseCapabilityDeclaration,
  type CapabilityDeclaration,
  type Clock,
  type ControlPlanePrincipal,
  type CoreStores,
  type TenantId,
} from '@byok/core';
import { createEnvelope, encodeEnvelope, type Envelope, type TaskOfferPayload } from '@byok/protocol';
import { createAuthPlane, type AuthPlane } from './auth/plane';
import type { TokenSigner } from './auth/tokens';
import { CLOUD_CAPABILITIES, declares } from './capabilities';
import type { CloudCrypto } from './crypto/port';
import { ByokCloudError } from './errors';
import {
  blobDownloadContentHandler,
  blobDownloadUrlHandler,
  blobUploadContentHandler,
  createBlobHandler,
} from './handlers/blobs';
import { capabilitiesHandler } from './handlers/capabilities';
import { challengeHandler, pairHandler, tokenHandler } from './handlers/auth';
import { eventsHandler } from './handlers/events';
import { messagesHandler } from './handlers/messages';
import { CloudRouteRegistry, type RouteDescriptor } from './router/registry';
import { terminalReceiptKey } from './inbound';
import type { CloudStores, DeviceRecord, PairingCodeInfo, RequestReceipt, TaskAttempt } from './stores/ports';
import { tenantStoresFor, type CloudRootStores } from './tenant-stores';

/** Matches the reference server's ceiling (§7). */
export const DEFAULT_MAX_BLOB_SIZE_BYTES = 100 * 1024 * 1024;
/** Matches the reference server's hold (§8). */
export const DEFAULT_LONG_POLL_HOLD_MS = 50_000;
/** How often a held poll re-reads the mailbox. */
export const DEFAULT_LONG_POLL_INTERVAL_MS = 250;
/** Rows per `GET /byok/events` response. */
export const DEFAULT_EVENTS_PAGE_LIMIT = 50;

export interface ByokCloudOptions {
  readonly core: CoreStores;
  readonly cloud: CloudStores;
  readonly crypto: CloudCrypto;
  readonly tokenSigner: TokenSigner;
  readonly clock: Clock;
  /** What this deployment serves (ADR-010). Routes are mounted from it, so it can never over-declare. */
  readonly capabilities: CapabilityDeclaration;
  /** Recorded on the control-plane principal every host-side call is made under. */
  readonly operatorId?: string;
  readonly maxBlobSizeBytes?: number;
  readonly longPollHoldMs?: number;
  readonly longPollIntervalMs?: number;
  readonly eventsPageLimit?: number;
  readonly accessTokenTtlSeconds?: number;
}

export interface EnqueueOfferInput {
  /** Supply one to make the enqueue addressable by the host's own id; otherwise cloud mints one. */
  readonly taskId?: string;
  readonly payload: TaskOfferPayload;
}

export interface EnqueuedOffer {
  readonly taskId: string;
  /** The per-(tenant, device) delivery seq — the daemon's redelivery cursor position for this envelope. */
  readonly seq: number;
  readonly envelope: Envelope;
  readonly attempt: TaskAttempt;
}

export interface ByokCloud {
  /** WHATWG fetch handler — mount on `@hono/node-server`, a Worker, or Deno. */
  readonly fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response>;
  /** The I1 route inventory: every mounted route and the credential class it requires. */
  readonly routes: readonly RouteDescriptor[];
  /**
   * What the router ACTUALLY holds, read back off the router itself. Exposed
   * so the I1 matrix can close in both directions: an inventory is only
   * evidence if a route mounted some other way would show up here without a
   * matching entry in {@link routes}.
   */
  readonly mountedRoutes: readonly { readonly method: string; readonly path: string }[];
  readonly capabilities: CapabilityDeclaration;
  /** Host control plane: mint a single-use pairing code for a tenant/product. */
  createPairingCode(tenant: TenantId, input: { readonly productId: string; readonly ttlMs?: number }): Promise<PairingCodeInfo>;
  /** Host control plane: hand a device a frozen-v1 `task.offer`. The hosted replacement for `dispatch()` — a function, not a handle. */
  enqueueOffer(tenant: TenantId, deviceId: string, input: EnqueueOfferInput): Promise<EnqueuedOffer>;
  readTaskAttempt(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
  /** The recorded terminal for a task — the first one, re-encoded canonically under the frozen v1 codec (see `recordTerminal`, `inbound.ts`: the stored body is `encodeEnvelope` of the zod-parsed envelope, not the device's original byte sequence). */
  readTerminalReceipt(tenant: TenantId, taskId: string): Promise<RequestReceipt | undefined>;
  listDevices(tenant: TenantId): Promise<readonly DeviceRecord[]>;
  revokeDevice(tenant: TenantId, deviceId: string): Promise<void>;
}

export function createByokCloud(options: ByokCloudOptions): ByokCloud {
  const declaration = parseDeclaration(options.capabilities);
  const root: CloudRootStores = { core: options.core, cloud: options.cloud };
  const auth: AuthPlane = createAuthPlane({
    stores: options.cloud,
    crypto: options.crypto,
    clock: options.clock,
    tokenSigner: options.tokenSigner,
    ...(options.accessTokenTtlSeconds !== undefined
      ? { accessTokenTtlSeconds: options.accessTokenTtlSeconds }
      : {}),
  });

  const deviceRouteDeps = {
    root,
    bearer: { tokenSigner: options.tokenSigner, devices: options.cloud.devices },
  };

  const registry = new CloudRouteRegistry();

  // Auth v2 (§6) — always mounted: without pairing there is no deployment.
  registry.register({ method: 'POST', path: '/byok/pair', class: 'public' }, pairHandler({ auth }));
  registry.register({ method: 'POST', path: '/byok/challenge', class: 'public' }, challengeHandler({ auth }));
  registry.register({ method: 'POST', path: '/byok/token', class: 'public' }, tokenHandler({ auth }));

  // ADR-010 — the declaration itself is always readable; a client that cannot
  // read it has no way to learn anything else without probing status codes.
  registry.register(
    { method: 'GET', path: '/byok/capabilities', class: 'public' },
    capabilitiesHandler({ declaration }),
  );

  if (declares(declaration, CLOUD_CAPABILITIES.eventsLongPoll)) {
    registry.register(
      { method: 'GET', path: '/byok/events', class: 'device' },
      eventsHandler({
        ...deviceRouteDeps,
        longPollHoldMs: options.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS,
        longPollIntervalMs: options.longPollIntervalMs ?? DEFAULT_LONG_POLL_INTERVAL_MS,
        pageLimit: options.eventsPageLimit ?? DEFAULT_EVENTS_PAGE_LIMIT,
      }),
    );
  }

  if (declares(declaration, CLOUD_CAPABILITIES.messagesBatch)) {
    registry.register({ method: 'POST', path: '/byok/messages', class: 'device' }, messagesHandler(deviceRouteDeps));
  }

  if (declares(declaration, CLOUD_CAPABILITIES.blobsPresigned)) {
    const blobDeps = {
      ...deviceRouteDeps,
      blobs: options.cloud.blobs,
      maxBlobSizeBytes: options.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES,
    };
    registry.register({ method: 'POST', path: '/byok/blobs', class: 'device' }, createBlobHandler(blobDeps));
    registry.register({ method: 'GET', path: '/byok/blobs/:id/url', class: 'device' }, blobDownloadUrlHandler(blobDeps));
    registry.register(
      { method: 'PUT', path: '/byok/blobs/:id/content', class: 'presigned' },
      blobUploadContentHandler(blobDeps),
    );
    registry.register(
      { method: 'GET', path: '/byok/blobs/:id/content', class: 'presigned' },
      blobDownloadContentHandler(blobDeps),
    );
  }

  // Task approval is deliberately absent, exactly as it is on the reference
  // server: every route above is authenticated by a DEVICE's own credential,
  // and a device-bearer-authed approval route would let any validly paired
  // device approve any task in its tenant. Approval is an operator action and
  // belongs to the host's own control-plane surface.

  const operatorId = options.operatorId ?? 'host';

  function controlPlane(tenant: TenantId): ControlPlanePrincipal {
    return { kind: 'control-plane', tenantId: tenant, operatorId };
  }

  return {
    fetch: registry.fetch,
    routes: registry.routes,
    mountedRoutes: registry.mounted,
    capabilities: declaration,

    createPairingCode(tenant, input) {
      return auth.createPairingCode(tenant, input);
    },

    async enqueueOffer(tenant, deviceId, input) {
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const taskId = input.taskId ?? `task_${options.crypto.randomUuid()}`;

      // The delivery seq has to exist before the envelope does — it is a field
      // INSIDE the bytes the mailbox stores, and the mailbox transports opaque
      // bytes it cannot renumber. So allocate, build, append, then check the
      // mailbox agreed rather than letting two counters drift.
      const seq = await stores.sequence.next(deviceId);
      const envelope = createEnvelope('task.offer', input.payload, { taskId, seq });
      const body = encodeEnvelope(envelope);
      const bytes = new TextEncoder().encode(body);

      const message = await stores.mailbox.append({
        deviceId,
        body,
        bodyHash: contentHash(await options.crypto.sha256(bytes)),
        byteSize: BigInt(bytes.length),
        messageId: envelope.id,
      });
      if (message.seq !== seq) {
        throw new ByokCloudError(
          'mailbox_seq_mismatch',
          `Mailbox numbered this offer ${message.seq} while the delivery sequence allocated ${seq}; the daemon's redelivery cursor would be wrong.`,
        );
      }

      const attempt = await stores.tasks.open({ taskId, deviceId });
      return { taskId, seq, envelope, attempt };
    },

    readTaskAttempt(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).tasks.get(taskId);
    },

    readTerminalReceipt(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).receipts.get(terminalReceiptKey(taskId));
    },

    listDevices(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).devices.list();
    },

    revokeDevice(tenant, deviceId) {
      return tenantStoresFor(controlPlane(tenant), root).devices.revoke(deviceId);
    },
  };
}

function parseDeclaration(declaration: CapabilityDeclaration): CapabilityDeclaration {
  try {
    return parseCapabilityDeclaration(declaration);
  } catch (cause) {
    throw new ByokCloudError(
      'capability_declaration_invalid',
      'The capability declaration this deployment was configured with is not a valid ADR-010 declaration.',
      { cause },
    );
  }
}
