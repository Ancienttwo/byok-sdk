import { createInProcessMailboxWake } from '../../../../cloud/src/index';
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
import { AGENT_EGRESS_FRESH_SESSION_CAPABILITY, type AgentRef, type RuntimeId } from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import { freshTestAgentRef } from './test-agent';
import {
  AgentExecutionInputSchema,
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
 * Cloud is a stateless HTTP surface by construction, so a daemon pointed here
 * uses long-poll exactly as it would against a hosted deployment.
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
  /**
   * Fresh Agent execution through its one hosted entry, `submitAgentExecution` (#470/#484). No
   * `TaskHandle` exists on this surface. Waits until the device's authenticated capability snapshot
   * durably carries the Agent egress capabilities, then submits with the default egress policy and
   * `terminalProjection: none`. Targets `harnessId` when given, else `runtime` (default `pi`, the
   * stub adapter's id); `agentRef` defaults to a new Agent per call.
   */
  submitFreshAgent(deviceId: string, input: {
    readonly instruction: string;
    readonly agentRef?: AgentRef;
    readonly runtime?: RuntimeId;
    readonly harnessId?: string;
    readonly requiredToolsets?: readonly string[];
    readonly taskId?: string;
  }): Promise<EnqueuedOffer>;
  /** Accept a host cancellation and durably enqueue the frozen-v1 `task.cancel` message. */
  cancelTask(taskId: string, reason?: string): ReturnType<ByokCloud['cancelTask']>;
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
  readonly eventsPageLimit?: number;
  readonly productId: string;
  /** Keep this short in tests: the production default holds each empty poll ~50s. */
  readonly longPollHoldMs?: number;
  readonly mailboxFallbackMs?: number;
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

/** The daemon publishes its capabilities on its first long-poll `conn.hello`; admission reads them from the durable device row. */
async function waitForAgentEgressCapabilities(cloud: ByokCloud, tenant: TenantId, deviceId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const device = (await cloud.listDevices(tenant)).find((candidate) => candidate.deviceId === deviceId);
    if (device?.capabilities?.includes(AGENT_EGRESS_FRESH_SESSION_CAPABILITY)) return;
    if (Date.now() >= deadline) {
      throw new Error(`device ${deviceId} never advertised ${AGENT_EGRESS_FRESH_SESSION_CAPABILITY}; configure the daemon with agentHome and agentEgress`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
    ...(opts.eventsPageLimit === undefined ? {} : { eventsPageLimit: opts.eventsPageLimit }),
    longPollHoldMs: opts.longPollHoldMs ?? 200,
    mailboxWake: createInProcessMailboxWake({ fallbackMs: opts.mailboxFallbackMs ?? 20 }),
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
        submitFreshAgent: async (deviceId, { taskId, agentRef, runtime, harnessId, ...fields }) => {
          await waitForAgentEgressCapabilities(cloud, tenant, deviceId);
          return cloud.submitAgentExecution(tenant, AgentExecutionInputSchema.parse({
            taskId: taskId ?? globalThis.crypto.randomUUID(),
            deviceId,
            payload: {
              ...fields,
              ...(harnessId === undefined ? { runtime: runtime ?? 'pi' } : { harnessId, ...(runtime === undefined ? {} : { runtime }) }),
              agentRef: agentRef ?? freshTestAgentRef(),
              session: { mode: 'fresh' },
              egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
              terminalProjection: { mode: 'none' },
            },
          }));
        },
        cancelTask: (taskId, reason) => cloud.cancelTask(tenant, taskId, reason),
        readTaskAttempt: (taskId) => cloud.readTaskAttempt(tenant, taskId),
        readTerminalBody: async (taskId) => (await cloud.readTerminalReceipt(tenant, taskId))?.body,
        readActivity: (taskId) => cloud.readActivity(tenant, taskId),
        listPresence: () => cloud.listPresence(tenant),
        close: () => closeServer(httpServer as unknown as HttpServer),
      });
    });
  });
}
