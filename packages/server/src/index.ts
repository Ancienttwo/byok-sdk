import { Hono } from 'hono';
import {
  agentHomeProjectionRequestKey,
  createByokCloud,
  createHmacTokenSigner,
  fullCapabilityDeclaration,
  pendingApproval,
  type ByokCloud,
  type EnqueuedOffer,
  type PairingCodeInfo,
  type PendingApproval,
  type TaskAttempt,
  type TenantId,
  type TerminalResult,
} from '@byok-sdk/cloud';
import {
  AgentContentReadPayloadSchema,
  AgentEgressPolicySchema,
  AgentHomeProjectionPayloadSchema,
  AgentMessageEgressRequirementSchema,
  AgentMessageServerContextSchema,
  AgentRefSchema,
  DispatchSelectionSchema,
  RequiredToolsetsSchema,
  STRICT_AGENT_ONLY_CAPABILITY,
  TASK_STATES,
  TerminalProjectionSelectionSchema,
  type AgentHomeProjectionPayload,
  type PermissionPolicy,
  type TaskState,
} from '@byok-sdk/protocol';
import type { MailboxRetentionInput, MailboxRetentionResult } from '@byok-sdk/core';
import { DeviceConnections } from './connections';
import { pickFirstConnectedDevice, type DeviceCandidate } from './device-selection';
import { TaskEventRelay } from './relay';
import { toMachineInfo, toTaskResult, toTaskSnapshot, type DispatchFacts } from './snapshot';
import { composeFacadeStores, serverTenantId, DEFAULT_MAX_BLOB_SIZE_BYTES } from './stores';
import { createTaskHandle } from './task-handle';
import type {
  ByokServerEvent,
  AgentContentReadRequest,
  AgentHomeProjectionRequest,
  AgentHomeProjectionStatusReadback,
  AgentEgressReceipt,
  ByokServerStorage,
  CreateByokServerOptions,
  DispatchInput,
  FreshAgentEgressDispatchInput,
  HubStats,
  MachineInfo,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';

export type {
  ByokServerEvent,
  AgentContentReadRequest,
  AgentHomeProjectionRequest,
  AgentHomeProjectionStatusReadback,
  AgentEgressReceipt,
  ByokServerStorage,
  CreateByokServerOptions,
  DispatchInput,
  FreshAgentEgressDispatchInput,
  HubStats,
  MachineInfo,
  ServerTaskEvent,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';
/**
 * M5 (approval targeting, docs/protocol.md §5.3): `TaskHandle.approve`/`reject`'s
 * `opts.approvalId` targeting throws this when the id names an approval the
 * task has already superseded, so a caller needs it to `instanceof`-check and
 * inspect the two ids. Re-exported from `@byok-sdk/cloud`, which owns the gate
 * both the embedded and the hosted surface are decided by — one class, one
 * `instanceof` that works across both.
 */
export { StaleApprovalError } from '@byok-sdk/cloud';
/**
 * S0 (GAP-002): `TaskHandle.steer` throws this when the runtime that claimed
 * the task cannot be steered, when the task isn't running, or when it's already
 * terminal. The GATE is the kernel's — it reads the claim-time capability
 * snapshot and nothing else — and so is the `code`. The CLASS is this
 * package's, because it carries `state: TaskState`, the wire vocabulary this
 * surface speaks and the kernel deliberately has no field for. See
 * `task-handle.ts` for the full reasoning and for why `SteerRejectionCode` and
 * {@link StaleApprovalError} stay kernel re-exports.
 */
export { SteerRejectedError } from './task-handle';
export type { SteerRejectionCode } from '@byok-sdk/cloud';
/**
 * Auth v2 types an embedder needs to talk about devices and tokens. All owned
 * by `@byok-sdk/cloud` now — this package no longer has an auth plane of its
 * own to keep in agreement with one.
 */
export type { AccessTokenClaims, DeviceRecord, PairingCodeInfo, TenantId, TokenSigner } from '@byok-sdk/cloud';
export { createHmacTokenSigner } from '@byok-sdk/cloud';
/** Cutoffs and result of {@link ByokServer.mailbox.collectRetired}, owned by `@byok-sdk/core`. */
export type { MailboxRetentionInput, MailboxRetentionResult } from '@byok-sdk/core';
export { SqliteUnavailableError } from './sqlite-support';
export type { RateLimiterOptions } from './rate-limiter';
export { DEFAULT_TASK_EVENT_BUFFER_LIMIT, DEFAULT_TASK_EVENT_RETENTION_MS } from './relay';

/** `GET /byok/events` hold duration (§8): ~50s unless overridden (e.g. for tests). */
const DEFAULT_LONG_POLL_HOLD_MS = 50_000;
/** Ceiling on how often a held poll re-reads the mailbox, ms. */
const MAX_LONG_POLL_INTERVAL_MS = 250;
/** Floor on the same, so a short test hold still re-reads several times. */
const MIN_LONG_POLL_INTERVAL_MS = 5;
/** Attempts a held poll makes across its window; sets the re-read interval with the hold. */
const LONG_POLL_READS_PER_HOLD = 8;
/** Bytes of HMAC secret minted when an embedder supplies no {@link TokenSigner}. */
const TOKEN_SECRET_BYTES = 32;
/** Page size `tasks.list()` uses when the caller names none. */
export const DEFAULT_TASK_PAGE_LIMIT = 100;

/** Input to {@link ByokServer.pairing.createPairingCode}. */
export interface CreatePairingCodeInput {
  /**
   * The product the redeeming device pairs into. Must be this instance's own
   * `productId`: an embedded server serves exactly one product, and a code for
   * some other product would mint a device every bearer-authed route then
   * refuses (`instanceProductId`, `@byok-sdk/cloud`). Fail closed rather than
   * silently issuing an unusable code.
   *
   * The TENANT is not a parameter: it is derived from `productId` once, at
   * construction (`serverTenantId`, `stores.ts`), because this surface has no
   * second tenant to name.
   */
  readonly productId: string;
  /** Overrides the default single-use code lifetime. */
  readonly ttlMs?: number;
}

/** One bounded page of this server's tasks. */
export interface TaskPage {
  readonly tasks: readonly TaskSnapshot[];
  /**
   * Pass as the next call's `cursor`. ABSENT means the walk is over — a caller
   * stops on absence, not on an empty page, so a page that exactly fills
   * `limit` with nothing after it still terminates.
   */
  readonly nextCursor?: string;
}

/** Query for {@link ByokServer.tasks.list}. */
export interface TaskListQuery {
  /** Maximum snapshots in the page. Defaults to {@link DEFAULT_TASK_PAGE_LIMIT}. */
  readonly limit?: number;
  /** The `nextCursor` from the previous page; absent starts at the beginning. */
  readonly cursor?: string;
}

/** The object `createByokServer` returns — the SaaS-embedder-facing surface. */
export interface ByokServer {
  /** Hono app exposing every device route, plus the opt-in `/healthz`. Mount it, or use its `.fetch` with `@hono/node-server`. */
  hono: Hono;
  pairing: {
    /** Mint a single-use pairing code for this server's product and tenant (docs/protocol.md §6.1). */
    createPairingCode(input: CreatePairingCodeInput): Promise<PairingCodeInfo>;
  };
  dispatch(input: DispatchInput): Promise<TaskHandle>;
  /** Dispatch a fresh Agent execution whose runtime will mint its session after start. */
  dispatchFreshAgentEgress(input: FreshAgentEgressDispatchInput): Promise<TaskHandle>;
  /** Enqueue one capability-gated, exact-identity content-read request. */
  requestAgentContentRead(input: AgentContentReadRequest): Promise<void>;
  /** Enqueue one task-free, exact-device Agent-home projection. */
  enqueueAgentHomeProjection(input: AgentHomeProjectionRequest): Promise<AgentHomeProjectionStatusReadback>;
  /** Durable desired-state and terminal-outcome readback for one projection request. */
  readAgentHomeProjection(deviceId: string, requestId: string): Promise<AgentHomeProjectionStatusReadback | undefined>;
  tasks: {
    get(taskId: string): Promise<TaskSnapshot | undefined>;
    /**
     * One bounded page, keyset-paged by task id. Paged rather than "all of
     * them" because the underlying store is: an unbounded `list()` would have
     * to walk every page internally and hand back a snapshot that was never
     * consistent at any single instant.
     */
    list(query?: TaskListQuery): Promise<TaskPage>;
  };
  /** Trusted embedder access to committed blob download grants. */
  blobs: {
    getDownloadUrl(blobId: string): Promise<string | undefined>;
  };
  /** Reliable Agent egress receipt readback. */
  egress: {
    get(deviceId: string, eventId: string): Promise<AgentEgressReceipt | undefined>;
  };
  machines: {
    list(): Promise<MachineInfo[]>;
  };
  events: {
    subscribe(): AsyncIterable<ByokServerEvent>;
  };
  /**
   * Device revocation (§6.3) — server-side only, no wire message. Revoking a
   * device DELETES its registration, so its next `/byok/challenge`,
   * `/byok/token`, or authed HTTP call gets a 401 — the same answer as for a
   * device id that was never registered — and its only recourse is to re-run
   * `/byok/pair`. The device-scoped state the row owned (outstanding challenge
   * nonces, presence, inbound dedup) is deleted with it; what the device DID
   * (tasks, receipts) is history and survives.
   *
   * DEVICE-ID ONLY. The hosted control plane's own revocation is tenant-first
   * (a tenant may only revoke a device it owns), but an embedded server owns
   * exactly ONE tenant and binds it here itself: `TenantId` is a branded type an
   * embedder cannot mint, and nothing on this surface — `ByokServer`,
   * `MachineInfo`, `PairingCodeInfo` — hands one back, so a tenant-first
   * parameter would make this method uncallable from outside the package rather
   * than safer. The scoping it provided is unchanged, just not the caller's to
   * state: a device id this server does not know resolves to nothing and is a
   * silent no-op.
   */
  devices: {
    revoke(deviceId: string): Promise<void>;
  };
  /**
   * Mailbox retention for this server's tenant — the host control-plane
   * operation core defines (`MailboxStore.collectRetired`), forwarded verbatim.
   *
   * A pass-through, deliberately, and NOT a retention policy: the caller names
   * both cutoffs, so this package invents no TTL, runs no timer, and holds no
   * second opinion about when a device's undelivered work is declared lost.
   * Nothing in `@byok-sdk/core`, `@byok-sdk/cloud` or this façade drives the
   * sweep on its own, which is exactly why an embedder needs a way to reach it:
   * without one, an embedded server retires nothing, ever, and the
   * `cursor_too_old` floor can never move.
   *
   * Acked rows appended before `ackedBefore` are DELETED; unacked rows appended
   * before `expireUnackedBefore` are dead-lettered as `expired` and stay
   * visible, which is what moves `recoverableFrom` and turns a device polling
   * from a lost cursor into a `409 cursor_too_old` resync instead of a silently
   * short page. Both cutoffs must be canonical ISO-8601 UTC.
   */
  mailbox: {
    collectRetired(input: MailboxRetentionInput): Promise<MailboxRetentionResult>;
  };
  /**
   * Release what this instance holds: the relay's per-task feeds and their
   * reclamation timers, and the connection observations. Call it on shutdown so
   * nothing keeps the process alive or leaks a handle in tests; safe to call
   * more than once. SQLite embedders that need to await handle release should
   * call {@link ByokServer.close} instead.
   */
  stop(): void;
  /** Drain pending store calls and release the selected storage authority. */
  close(): Promise<void>;
  /**
   * A plain, serializable snapshot of this server's current state. See
   * {@link HubStats} for the field-by-field contract.
   *
   * Async because `taskCountsByState` is COMPUTED from the durable task store
   * on every call rather than mirrored into a counter this package would then
   * have to keep in agreement with it — that mirror was the second task
   * authority the fold exists to remove. Deliberately in-process only: never
   * exposed over HTTP by this SDK itself (see
   * `CreateByokServerOptions.healthzRoute`); an embedder that wants any of it
   * surfaced remotely builds its own authenticated route around this method.
   */
  stats(): Promise<HubStats>;
}

/**
 * Embedded reference coordinator: a thin façade over `@byok-sdk/cloud`'s
 * kernel, composed against the explicitly selected embedded stores.
 *
 * What that means concretely — and it is the whole point of WP3B — is that this
 * package owns NO coordination semantics any more. Pairing, tokens, the inbound
 * gate, task ownership, first-terminal-wins, approvals, steering, cancellation,
 * long-poll redelivery and the `cursor_too_old` floor are all the kernel's, and
 * a device cannot tell this from a hosted deployment. What is left here is the
 * embedded shape: one product, one tenant, a `TaskHandle` for hosts that want
 * one, an in-process notification relay, and the observability an embedder used
 * to get from the hub.
 *
 * State is in-memory by default. Explicit SQLite mode persists the six
 * coordination interfaces whose contracts cross a process restart; all other
 * ports remain process-local.
 */
export function createByokServer(opts: CreateByokServerOptions): ByokServer {
  const startedAtMs = Date.now();
  const tenant = serverTenantId(opts.productId);
  const maxBlobSizeBytes = opts.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES;
  const longPollHoldMs = opts.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS;

  const connections = new DeviceConnections();
  const relay = new TaskEventRelay({
    connections,
    ...(opts.taskEventBufferLimit === undefined ? {} : { taskEventBufferLimit: opts.taskEventBufferLimit }),
    ...(opts.taskEventRetentionMs === undefined ? {} : { taskEventRetentionMs: opts.taskEventRetentionMs }),
  });

  const composition = composeFacadeStores({
    tenant,
    maxBlobSizeBytes,
    ...(opts.storage === undefined ? {} : { storage: opts.storage }),
    ...(opts.rateLimit === undefined ? {} : { rateLimit: opts.rateLimit }),
    connections,
    onRateLimited: (deviceId, at) => relay.emitServerEvent({ kind: 'device.rate_limited', deviceId, at }),
  });

  const tokenSigner =
    opts.tokenSigner ??
    createHmacTokenSigner(
      globalThis.crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES)),
      composition.clock,
    );

  const cloud: ByokCloud = createByokCloud({
    core: composition.core,
    cloud: composition.cloud,
    blobContentProxy: composition.blobContentProxy,
    crypto: composition.crypto,
    tokenSigner,
    clock: composition.clock,
    capabilities: fullCapabilityDeclaration(),
    // S1: the product this instance serves is part of every bearer-authed
    // route's decision, not just of the pairing claims.
    instanceProductId: opts.productId,
    observer: relay,
    ...(opts.agentMessage === undefined ? {} : { agentMessage: opts.agentMessage }),
    maxBlobSizeBytes,
    longPollHoldMs,
    longPollIntervalMs: longPollInterval(longPollHoldMs),
  });

  /**
   * Dispatch input the kernel does not persist. See `DispatchFacts` for why
   * this exists and why it is not TTL-reclaimed.
   */
  const dispatched = new Map<string, DispatchFacts>();

  const hono = new Hono();
  if (opts.healthzRoute === true) {
    // Deliberately UNAUTHENTICATED and minimal: a liveness probe must not need
    // a device credential, and the body carries no device ids and no counts.
    // `stats()` is the richer surface and is never routed anywhere by this SDK.
    hono.get('/healthz', (c) => c.json({ ok: true, uptimeMs: Date.now() - startedAtMs }, 200));
  }
  // Everything else IS the kernel. Mounted as a fallthrough rather than
  // re-declared route by route so this package can never publish a route the
  // kernel does not serve, or shadow one it does.
  hono.all('*', (c) => cloud.fetch(c.req.raw));

  async function readPending(taskId: string): Promise<PendingApproval | undefined> {
    return pendingApproval(await cloud.readApprovalTimeline(tenant, taskId));
  }

  async function readTerminal(taskId: string): Promise<TerminalResult | undefined> {
    return cloud.readTaskResult(tenant, taskId);
  }

  async function projectTask(attempt: TaskAttempt): Promise<TaskSnapshot> {
    const [pending, terminal] = await Promise.all([readPending(attempt.taskId), readTerminal(attempt.taskId)]);
    return toTaskSnapshot(attempt, pending, terminal, dispatched.get(attempt.taskId));
  }

  /**
   * The state `byok.tasks.get(taskId)` would report right now.
   *
   * Deliberately routed through `projectTask` rather than re-deriving it: a
   * refused steer reports the same `TaskState` the snapshot does, because it is
   * literally the snapshot's, read at the moment of the refusal.
   */
  async function readTaskState(taskId: string): Promise<TaskState | undefined> {
    const attempt = await cloud.readTaskAttempt(tenant, taskId);
    return attempt === undefined ? undefined : (await projectTask(attempt)).state;
  }

  /**
   * M4 Phase 3 hardening: the daemon resolved a pending approval entirely
   * locally and never sent `task.approval_resolved`, but its next
   * progress/artifact message proves, after the fact, that it did. Recorded on
   * the same timeline as any other resolution so the read model resumes, and
   * announced as `task.approval_resolved_implicit` so an embedder can tell the
   * inferred path from the reported one.
   *
   * Runs off the relay's request path, not on it: it needs a store read, and
   * the kernel's observer contract is synchronous and inline. A failure here
   * changes nothing durable — the next message re-runs the same check.
   */
  relay.onTaskActivity = (
    taskId: string,
    pendingRequestSourceEnvelopeId: string | undefined,
    activitySourceEnvelopeId: string,
    activityAt: string,
  ): void => {
    void (async () => {
      // The relay captured this request identity when it observed the native
      // `task.await_approval`. An activity that committed before that request
      // is therefore never retroactively allowed to resolve it after an async
      // timeline read observes the newer pending slot.
      if (pendingRequestSourceEnvelopeId === undefined) return;
      const pending = await readPending(taskId);
      if (
        pending === undefined ||
        pending.sourceEnvelopeId !== pendingRequestSourceEnvelopeId
      ) {
        return;
      }
      const attempt = await cloud.readTaskAttempt(tenant, taskId);
      if (attempt === undefined) return;
      const sourceEnvelopeId = await composition.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({
            domain: 'byok:implicit-approval',
            tenant,
            taskId,
            deviceId: attempt.deviceId,
            ownerDeviceId: attempt.ownerDeviceId,
            agentRef: attempt.agentRef,
            requestSourceEnvelopeId: pending.sourceEnvelopeId,
            requestRevision: pending.revision,
            activitySourceEnvelopeId,
          }),
        ),
      );
      const resolved = await composition.cloud.approvals.resolvePending(tenant, {
        taskId,
        sourceEnvelopeId,
        expectedSourceEnvelopeId: pending.sourceEnvelopeId,
        expectedRevision: pending.revision,
        event: {
          type: 'approval_resolved',
          ...(pending.approvalId === undefined ? {} : { approvalId: pending.approvalId }),
          decision: 'approve',
          resolvedBy: 'host',
          at: activityAt,
        },
      });
      if (resolved.status === 'applied' || resolved.status === 'replayed') {
        relay.emitImplicitApprovalResolved(taskId, activityAt);
      }
    })().catch(() => undefined);
  };

  async function candidatesInObservationOrder(): Promise<DeviceCandidate[]> {
    const candidates: DeviceCandidate[] = [];
    for (const deviceId of connections.ids()) {
      if (!connections.isConnected(deviceId)) continue;
      const device = await composition.cloud.devices.get(tenant, deviceId);
      if (device === undefined || device.revoked) continue;
      candidates.push({
        deviceId,
        capabilities: device.capabilities,
        configuredToolsets: connections.get(deviceId)?.configuredToolsets,
      });
    }
    return candidates;
  }

  async function deviceCapabilities(deviceId: string): Promise<readonly string[] | undefined> {
    return (await composition.cloud.devices.get(tenant, deviceId))?.capabilities;
  }

  async function requireConnected(deviceId: string): Promise<void> {
    if (!connections.isConnected(deviceId)) throw new Error(`device ${deviceId} is not connected`);
  }

  async function dispatchInternal(
    input: DispatchInput | FreshAgentEgressDispatchInput,
    freshAgentEgress: boolean,
  ): Promise<TaskHandle> {
    const sessionRef = 'sessionRef' in input ? input.sessionRef : undefined;
    const agentRef = input.agentRef === undefined ? undefined : AgentRefSchema.parse(input.agentRef);
    const egressPolicy =
      input.egressPolicy === undefined ? undefined : AgentEgressPolicySchema.parse(input.egressPolicy);
    const messageEgress =
      input.messageEgress === undefined ? undefined : AgentMessageEgressRequirementSchema.parse(input.messageEgress);
    const terminalProjection =
      input.terminalProjection === undefined
        ? undefined
        : TerminalProjectionSelectionSchema.parse(input.terminalProjection);
    if (messageEgress === undefined && input.agentMessageContext !== undefined) {
      throw new Error('agentMessageContext requires messageEgress');
    }
    const agentMessageContext =
      messageEgress === undefined ? undefined : AgentMessageServerContextSchema.parse(input.agentMessageContext);
    const dispatchSelection =
      input.dispatchSelection === undefined ? undefined : DispatchSelectionSchema.parse(input.dispatchSelection);
    const requiredToolsets =
      input.requiredToolsets === undefined ? undefined : RequiredToolsetsSchema.parse(input.requiredToolsets);

    if (agentRef !== undefined && input.deviceId === undefined) {
      throw new Error('Agent-bound dispatch requires an explicit deviceId for capability admission');
    }
    if (egressPolicy !== undefined && agentRef === undefined) {
      throw new Error('Agent egress policy requires an explicit AgentRef; legacy task dispatch cannot consume it');
    }
    if (messageEgress !== undefined && egressPolicy === undefined) {
      throw new Error('Agent message egress requires the typed Agent egress offer path');
    }

    const deviceId =
      input.deviceId ??
      pickFirstConnectedDevice(await candidatesInObservationOrder(), {
        ...(requiredToolsets === undefined ? {} : { requiredToolsets }),
        allowStrictAgentOnly: agentRef !== undefined,
      });
    // No queue-until-connect: reject clearly instead of silently enqueuing a
    // task nothing will ever claim.
    if (deviceId === undefined) {
      throw new Error('no connected device to dispatch to (M0 does not queue tasks until a device connects)');
    }
    await requireConnected(deviceId);

    // The gates the kernel does not run, in the pre-fold order. Everything
    // below the kernel DOES run (strict-agent-only, agent-home-contract, the
    // egress/message/terminal-projection capabilities) is left to it rather
    // than duplicated here, so there is one place each admission is decided.
    const capabilities = await deviceCapabilities(deviceId);
    if (dispatchSelection !== undefined && !(capabilities?.includes('dispatch-selection') ?? false)) {
      throw new Error(
        `device ${deviceId} did not advertise dispatch-selection capability; refusing authoritative provider/model dispatch`,
      );
    }
    if (requiredToolsets !== undefined) {
      if (!(capabilities?.includes('toolset-selection') ?? false)) {
        throw new Error(
          `device ${deviceId} did not advertise toolset-selection capability; refusing a task whose semantics require local MCP tools`,
        );
      }
      const configuredToolsets = connections.get(deviceId)?.configuredToolsets;
      if (configuredToolsets === undefined) {
        throw new Error(
          `device ${deviceId} did not advertise its configured toolset inventory; refusing to guess from runtime capability`,
        );
      }
      const configured = new Set(configuredToolsets);
      const missing = requiredToolsets.filter((toolsetId) => !configured.has(toolsetId));
      if (missing.length > 0) {
        throw new Error(`device ${deviceId} is missing required MCP toolset(s): ${missing.join(', ')}`);
      }
    }
    if (
      dispatchSelection !== undefined &&
      input.runtime !== undefined &&
      input.runtime !== dispatchSelection.runtimeId
    ) {
      throw new Error(
        `dispatch runtime ${input.runtime} does not match dispatchSelection.runtimeId ${dispatchSelection.runtimeId}`,
      );
    }
    if (agentRef === undefined && capabilities?.includes(STRICT_AGENT_ONLY_CAPABILITY) === true) {
      throw new Error(
        `device ${deviceId} advertises strict-agent-only; legacy task dispatch is refused before enqueue`,
      );
    }

    const policy: PermissionPolicy = input.policy ?? { mode: 'confirm' };
    const runtime = dispatchSelection?.runtimeId ?? input.runtime;
    const common = {
      instruction: input.instruction,
      policy,
      ...(runtime === undefined ? {} : { runtime }),
      ...(dispatchSelection === undefined ? {} : { dispatchSelection }),
    };

    // A known id lets the relay exist before enqueue can make the offer
    // observable. Inbound claim/terminal traffic racing append is buffered by
    // that provisional relay state and reconciled once the offer succeeds.
    const taskId = globalThis.crypto.randomUUID();
    relay.provision(taskId);
    let enqueued: EnqueuedOffer;
    try {
      enqueued = await (async () => {
        if (agentRef !== undefined && egressPolicy !== undefined && freshAgentEgress) {
          return cloud.enqueueFreshAgentEgressOffer(tenant, deviceId, {
            taskId,
            payload: {
              ...common,
              agentRef,
              egressPolicy,
              ...(terminalProjection === undefined ? {} : { terminalProjection }),
              ...(messageEgress === undefined ? {} : { messageEgress }),
              ...(requiredToolsets === undefined ? {} : { requiredToolsets }),
            },
            ...(agentMessageContext === undefined ? {} : { agentMessageContext }),
          });
        }
        if (agentRef !== undefined && egressPolicy !== undefined) {
          if (sessionRef === undefined) {
            throw new Error(
              'Agent egress resume dispatch requires an exact sessionRef; use dispatchFreshAgentEgress for fresh execution',
            );
          }
          return cloud.enqueueAgentEgressOffer(tenant, deviceId, {
            taskId,
            payload: {
              ...common,
              sessionRef,
              agentRef,
              egressPolicy,
              ...(terminalProjection === undefined ? {} : { terminalProjection }),
              ...(messageEgress === undefined ? {} : { messageEgress }),
              ...(requiredToolsets === undefined ? {} : { requiredToolsets }),
            },
            ...(agentMessageContext === undefined ? {} : { agentMessageContext }),
          });
        }
        if (agentRef !== undefined) {
          return cloud.enqueueAgentOffer(tenant, deviceId, {
            taskId,
            payload: {
              ...common,
              agentRef,
              ...(sessionRef === undefined ? {} : { sessionRef }),
              ...(terminalProjection === undefined ? {} : { terminalProjection }),
              ...(requiredToolsets === undefined ? {} : { requiredToolsets }),
            },
          });
        }
        if (requiredToolsets !== undefined) {
          return cloud.enqueueToolsetOffer(tenant, deviceId, {
            taskId,
            payload: { ...common, ...(sessionRef === undefined ? {} : { sessionRef }), requiredToolsets },
          });
        }
        return cloud.enqueueOffer(tenant, deviceId, {
          taskId,
          payload: { ...common, ...(sessionRef === undefined ? {} : { sessionRef }) },
        });
      })();
    } catch (error) {
      relay.abort(taskId);
      throw error;
    }

    // The offer envelope's own timestamp, so the feed and the snapshot agree on
    // when the task began rather than each stamping its own "now".
    const createdAt = enqueued.envelope.ts;
    dispatched.set(enqueued.taskId, {
      createdAt,
      ...(sessionRef === undefined ? {} : { sessionRef }),
    });
    relay.noteDispatched(enqueued.taskId, createdAt);
    return handleFor(enqueued.taskId);
  }

  function handleFor(taskId: string): TaskHandle {
    return createTaskHandle(taskId, {
      tenant,
      cloud,
      relay,
      readState: readTaskState,
      readResult: async (id) => toTaskResult(await readTerminal(id)),
    });
  }

  return {
    hono,

    pairing: {
      // `async`, not a plain function that throws: the declared contract is a
      // promise, and a guard that threw synchronously would refuse a
      // cross-product mint through a channel no `await`/`.catch()` caller of a
      // promise-returning method handles. Fail closed, on the same channel as
      // every other failure of this method.
      async createPairingCode(input: CreatePairingCodeInput): Promise<PairingCodeInfo> {
        if (input.productId !== opts.productId) {
          throw new Error(
            `pairing code product ${input.productId} does not match this server's product ${opts.productId}`,
          );
        }
        return cloud.createPairingCode(tenant, {
          productId: input.productId,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        });
      },
    },

    dispatch(input: DispatchInput): Promise<TaskHandle> {
      return dispatchInternal(input, false);
    },

    dispatchFreshAgentEgress(input: FreshAgentEgressDispatchInput): Promise<TaskHandle> {
      if (Object.prototype.hasOwnProperty.call(input, 'sessionRef')) {
        throw new Error('fresh Agent egress dispatch must not carry sessionRef');
      }
      if (typeof input.deviceId !== 'string' || input.deviceId.length === 0) {
        throw new Error('fresh Agent egress dispatch requires an explicit deviceId');
      }
      if (input.agentRef === undefined || input.egressPolicy === undefined) {
        throw new Error('fresh Agent egress dispatch requires exact AgentRef and egress policy');
      }
      return dispatchInternal(input, true);
    },

    async requestAgentContentRead(input: AgentContentReadRequest): Promise<void> {
      const payload = AgentContentReadPayloadSchema.parse(input.payload);
      await requireConnected(input.deviceId);
      await cloud.enqueueAgentContentRead(tenant, input.deviceId, { payload });
    },

    async enqueueAgentHomeProjection(
      input: AgentHomeProjectionRequest,
    ): Promise<AgentHomeProjectionStatusReadback> {
      const payload = AgentHomeProjectionPayloadSchema.parse(input.payload);
      await requireConnected(input.deviceId);
      return (await cloud.enqueueAgentHomeProjection(tenant, input.deviceId, payload)).status;
    },

    async readAgentHomeProjection(
      deviceId: string,
      requestId: string,
    ): Promise<AgentHomeProjectionStatusReadback | undefined> {
      // The kernel's readback is keyed by the WHOLE immutable request identity
      // (`requestId` + `agentRef` + `projectionHash`) so a status read can never
      // be answered for a different desired state that happens to share an id.
      // A host holding only the id gets the rest from the durable request the
      // enqueue recorded — one authority, read twice, not a second index.
      const stored = await composition.cloud.receipts.get(
        tenant,
        agentHomeProjectionRequestKey(deviceId, requestId),
      );
      if (stored === undefined) return undefined;
      let desired: AgentHomeProjectionPayload;
      try {
        desired = AgentHomeProjectionPayloadSchema.parse(JSON.parse(stored.body));
      } catch {
        return undefined;
      }
      return cloud.getAgentHomeProjectionStatus(tenant, deviceId, {
        requestId: desired.requestId,
        agentRef: desired.agentRef,
        projectionHash: desired.projectionHash,
      });
    },

    tasks: {
      async get(taskId: string): Promise<TaskSnapshot | undefined> {
        const attempt = await cloud.readTaskAttempt(tenant, taskId);
        return attempt === undefined ? undefined : projectTask(attempt);
      },
      async list(query: TaskListQuery = {}): Promise<TaskPage> {
        const page = await cloud.listTaskAttempts(tenant, {
          limit: query.limit ?? DEFAULT_TASK_PAGE_LIMIT,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return {
          tasks: await Promise.all(page.attempts.map((attempt) => projectTask(attempt))),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      },
    },

    blobs: {
      getDownloadUrl(blobId: string): Promise<string | undefined> {
        return composition.cloud.blobs.getDownloadUrl(tenant, blobId);
      },
    },

    egress: {
      async get(deviceId: string, eventId: string): Promise<AgentEgressReceipt | undefined> {
        const record = await cloud.readAgentEgress(tenant, deviceId, eventId);
        return record === undefined
          ? undefined
          : {
              deviceId: record.deviceId,
              payload: record.payload,
              receiptId: record.receiptId,
              recordedAt: record.recordedAt,
            };
      },
    },

    machines: {
      async list(): Promise<MachineInfo[]> {
        const devices = await cloud.listDevices(tenant);
        return devices.map((device) => toMachineInfo(device, connections.get(device.deviceId)));
      },
    },

    events: {
      subscribe: () => relay.serverEvents(),
    },

    devices: {
      async revoke(deviceId: string): Promise<void> {
        // §6.3: a tenant can only revoke a device it owns. This server owns one
        // tenant and supplies it here, so a device id belonging to nobody
        // addresses nothing and touches nothing.
        await cloud.revokeDevice(tenant, deviceId);
        connections.forget(deviceId);
      },
    },

    mailbox: {
      collectRetired(input: MailboxRetentionInput): Promise<MailboxRetentionResult> {
        return composition.core.mailbox.collectRetired(tenant, input);
      },
    },

    stop(): void {
      relay.stop();
      dispatched.clear();
      void composition.close();
    },

    async close(): Promise<void> {
      relay.stop();
      dispatched.clear();
      await composition.close();
    },

    async stats(): Promise<HubStats> {
      const taskCountsByState = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<
        TaskState,
        number
      >;
      let cursor: string | undefined;
      do {
        const page = await cloud.listTaskAttempts(tenant, {
          limit: DEFAULT_TASK_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const attempt of page.attempts) {
          taskCountsByState[toStateForCount(attempt, await readPending(attempt.taskId))] += 1;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      return {
        connectedDeviceCount: connections.connectedCount(),
        taskCountsByState,
        envelopesIn: composition.counters.envelopesIn,
        dedupDrops: composition.counters.dedupDrops,
        rateLimitEvents: composition.counters.rateLimitEvents,
        uptimeMs: Date.now() - startedAtMs,
      };
    },
  };
}

/** Same projection `tasks.get` uses; named so the count and the snapshot can never disagree. */
function toStateForCount(attempt: TaskAttempt, pending: PendingApproval | undefined): TaskState {
  return toTaskSnapshot(attempt, pending, undefined, undefined).state;
}

/**
 * A held poll re-reads the mailbox on a fraction of its own window, clamped so
 * a long production hold does not busy-loop and a short test hold still gets
 * several reads instead of exactly one.
 */
function longPollInterval(holdMs: number): number {
  const derived = Math.floor(holdMs / LONG_POLL_READS_PER_HOLD);
  return Math.max(MIN_LONG_POLL_INTERVAL_MS, Math.min(MAX_LONG_POLL_INTERVAL_MS, derived));
}
