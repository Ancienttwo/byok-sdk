import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
// This import reaches across the workspace by RELATIVE PATH on purpose.
//
// `@byok-sdk/client` must not gain a package dependency on the hosted surface —
// not even a dev one. The whole claim this fixture exists to prove is that the
// daemon transport is unchanged and unaware of which server implementation is on the
// other end; a `client -> cloud` edge in `package.json` would be the first
// thing to read as evidence against that, and it would invert the intended
// dependency direction (`cloud -> core + protocol`, and nothing depends on
// cloud). A test file importing a sibling package's source has neither effect:
// nothing that ships is touched. S6-c adds the intended `client -> core` edge
// for canonical device-proof bytes and truth selector contracts; it still does
// not make the daemon depend on the hosted implementation.
import type { PresenceHint } from '@byok-sdk/core';
import type { TaskOfferWithToolsetsPayload } from '@byok-sdk/protocol';
import {
  createInMemoryByokCloud,
  fullCapabilityDeclaration,
  tenantId,
  type ByokCloud,
  type ActivityTail,
  type EnqueuedOffer,
  type PairingCodeInfo,
  type TaskAttempt,
  type TenantId,
} from '../../../../cloud/src/index';

/**
 * Boots the REAL `@byok-sdk/cloud` in-memory composition on an ephemeral loopback
 * port, for the end-to-end test that drives the unchanged daemon against it.
 *
 * There is no WebSocket half at all — cloud is a stateless HTTP surface by
 * construction — so a daemon pointed here fails its WS attempts for real (Node
 * destroys the socket on an unhandled `upgrade`) and drops into long-poll
 * through its ordinary `wsFailureThreshold` path, exactly as it would against
 * a real hosted deployment.
 */

/**
 * The one address these fixtures both bind and dial — same reasoning as
 * `real-server.ts`: binding the wildcard would let a stranger already holding
 * `127.0.0.1:<port>` answer the drawn ephemeral port instead of byok.
 */
const LOOPBACK = '127.0.0.1';

/** The tenant every device paired through this fixture lands in. */
export const CLOUD_TEST_TENANT = 'tenant-cloud-test';

export interface RealCloudHandle {
  readonly cloud: ByokCloud;
  readonly httpServer: HttpServer;
  readonly url: string;
  readonly tenant: TenantId;
  /** Mint a pairing code carrying this fixture's tenant and the product the handle was started with. */
  createPairingCode(): Promise<PairingCodeInfo>;
  /** The hosted control-plane input: hand a device a frozen-v1 `task.offer`. No `TaskHandle` exists on this surface. */
  enqueueOffer(deviceId: string, instruction: string): Promise<EnqueuedOffer>;
  /** Additive hosted offer whose logical toolset ids must resolve on the target device before claim. */
  enqueueToolsetOffer(deviceId: string, payload: TaskOfferWithToolsetsPayload): Promise<EnqueuedOffer>;
  readTaskAttempt(taskId: string): Promise<TaskAttempt | undefined>;
  /** The recorded terminal envelope for a task, re-encoded canonically under the frozen v1 codec (see `recordTerminal`, `cloud/src/inbound.ts`). */
  readTerminalBody(taskId: string): Promise<string | undefined>;
  /** Lossy hosted activity projection for assertions about non-terminal runtime events. */
  readActivity(taskId: string): Promise<ActivityTail | undefined>;
  /** Unexpired presence hints only — an expired hint is indistinguishable from one never written (§12.3). */
  listPresence(): Promise<readonly PresenceHint[]>;
  close(): Promise<void>;
}

export interface StartRealCloudOptions {
  readonly productId: string;
  /** Keep this short in tests: the production default holds each empty poll ~50s. */
  readonly longPollHoldMs?: number;
  readonly longPollIntervalMs?: number;
  /**
   * Capability names to strip from this deployment's declaration (ADR-010).
   * A cloud that does not declare a capability does not mount its routes at
   * all, which is exactly the deployment a capability-gated client must be
   * proven against.
   */
  readonly omitCapabilities?: readonly string[];
  /** Hosted presence hint lifetime. Keep this short in tests that watch a hint expire. */
  readonly presenceTtlMs?: number;
  /** Hosted throttle between accepted publications. `0` disables it, for tests that beat faster than a deployment would. */
  readonly presenceMinimumIntervalMs?: number;
}

/**
 * `Server.close()` alone waits for every still-open connection to end,
 * including a `GET /byok/events` the cloud is holding open. `closeAllConnections()`
 * forcibly ends those so teardown does not wait out the remainder of a hold.
 */
function closeServer(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections?.();
  });
}

export async function startRealCloud(opts: StartRealCloudOptions): Promise<RealCloudHandle> {
  const tenant = tenantId(CLOUD_TEST_TENANT);
  const declaration = fullCapabilityDeclaration();
  const { cloud, core } = createInMemoryByokCloud({
    longPollHoldMs: opts.longPollHoldMs ?? 200,
    longPollIntervalMs: opts.longPollIntervalMs ?? 20,
    ...(opts.omitCapabilities === undefined
      ? {}
      : {
          capabilities: {
            ...declaration,
            capabilities: declaration.capabilities.filter((name) => !opts.omitCapabilities?.includes(name)),
          },
        }),
    ...(opts.presenceTtlMs === undefined ? {} : { presenceTtlMs: opts.presenceTtlMs }),
    ...(opts.presenceMinimumIntervalMs === undefined
      ? {}
      : { presenceMinimumIntervalMs: opts.presenceMinimumIntervalMs }),
  });
  await core.quota.writeEntitlement(tenant, {
    version: 1n,
    hardLimitBytes: 1_000_000_000n,
    maxObjectBytes: 100_000_000n,
    maxInlineBytes: 1_000_000n,
    mailboxLimitBytes: 100_000_000n,
    retentionPolicyId: 'test',
  });

  return new Promise((resolve) => {
    const httpServer = serve({ fetch: (request: Request) => cloud.fetch(request), port: 0, hostname: LOOPBACK }, (info) => {
      resolve({
        cloud,
        httpServer: httpServer as unknown as HttpServer,
        url: `http://${LOOPBACK}:${info.port}`,
        tenant,
        createPairingCode: () => cloud.createPairingCode(tenant, { productId: opts.productId }),
        enqueueOffer: (deviceId, instruction) =>
          cloud.enqueueOffer(tenant, deviceId, { payload: { instruction, policy: { mode: 'auto' } } }),
        enqueueToolsetOffer: (deviceId, payload) =>
          cloud.enqueueToolsetOffer(tenant, deviceId, { payload }),
        readTaskAttempt: (taskId) => cloud.readTaskAttempt(tenant, taskId),
        readTerminalBody: async (taskId) => (await cloud.readTerminalReceipt(tenant, taskId))?.body,
        readActivity: (taskId) => cloud.readActivity(tenant, taskId),
        listPresence: () => cloud.listPresence(tenant),
        close: () => closeServer(httpServer as unknown as HttpServer),
      });
    });
  });
}
