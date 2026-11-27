import {
  DEVICE_ASSERTION_AUDIENCE_MAX_BYTES,
  InMemoryDeviceAssertionReplayAuthority,
  parseTaskAssertionEnvelope,
  verifyTaskAssertion,
  type AuthenticatedTaskAssertion,
  type Clock,
  type DeviceAssertionReplayAuthority,
  type TaskAssertionEnvelopeV1,
  type TenantId,
} from '@byok-sdk/core';
import {
  authenticateHostedTaskAssertion,
  ByokCloudError,
  type ByokCloud,
  type CloudCrypto,
  type DeviceDirectory,
} from '@byok-sdk/cloud';
import { ToolsetIdSchema, type AgentRef, type ToolsetId } from '@byok-sdk/protocol';
import type { ByokServer } from './index.js';

/**
 * Opt-in configuration for the task-scoped host MCP tool-authority lane
 * (`byok-task-assertion-v1`, spec §8).
 *
 * Omit `CreateByokServerOptions.hostMcpTaskContext` to keep the lane off:
 * `host-mcp-task-context` is not declared and {@link verifyHostMcpTaskAssertion}
 * refuses every call with `task_context_disabled`.
 */
export interface HostMcpTaskContextOptions {
  /** Must be `true`; omit the option to keep the lane disabled. */
  readonly enabled: true;
  /**
   * Single-use JTI replay authority for `byok-task-assertion-v1`.
   *
   * When omitted, defaults to a process-local
   * {@link InMemoryDeviceAssertionReplayAuthority} paired with a server-start
   * `issuedAt` floor (`issuedAt <= startInstant` rejected with
   * `assertion_predates_server`). That default covers a single server instance
   * across restarts when the host clock is non-decreasing.
   *
   * Multi-instance deployments sharing a store must pass one shared atomic
   * replay authority; an explicit `replay` authority is used as given with no
   * server-start floor so rolling restarts keep valid unspent assertions.
   */
  readonly replay?: DeviceAssertionReplayAuthority;
}

/**
 * Required verification inputs for one host-toolset invocation.
 *
 * `issuer`, `audience`, and `toolset` are trusted host expectations matched
 * against the verified claims and the server's frozen offer; they are never
 * read from the assertion.
 */
export interface VerifyHostMcpTaskAssertionInput {
  /** The `byok-task-assertion-v1` envelope presented by the toolset call. */
  readonly assertion: unknown;
  /** Expected server origin (`new URL(serverUrl).origin`), matched verbatim. */
  readonly issuer: string;
  /** Expected single audience string, matched verbatim. */
  readonly audience: string;
  /** Expected logical toolset id, matched against both the assertion and the frozen offer. */
  readonly toolset: ToolsetId;
}

export type HostMcpTaskAssertionErrorCode =
  | 'task_context_disabled'
  | 'assertion_missing'
  | 'assertion_invalid'
  | 'assertion_audience_mismatch'
  | 'assertion_predates_server'
  | 'assertion_replayed'
  | 'replay_store_unavailable'
  | 'task_inactive'
  | 'toolset_not_offered';

/** Coded fail-closed error thrown by {@link verifyHostMcpTaskAssertion}. */
export class HostMcpTaskAssertionError extends Error {
  readonly code: HostMcpTaskAssertionErrorCode;

  constructor(code: HostMcpTaskAssertionErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'HostMcpTaskAssertionError';
    this.code = code;
  }
}

export interface ResolvedHostMcpTaskContext {
  readonly enabled: true;
  readonly replay: DeviceAssertionReplayAuthority;
  /** True only when the default process-local in-memory replay authority is in use. */
  readonly enforceStartFloor: boolean;
}

export interface HostMcpTaskContextBinding {
  readonly tenant: TenantId;
  readonly productId: string;
  readonly devices: DeviceDirectory;
  readonly crypto: CloudCrypto;
  readonly clock: Clock;
  readonly replay: DeviceAssertionReplayAuthority;
  /**
   * Composition-clock construction instant (ms since epoch) enforced as an
   * inclusive lower bound (`issuedAt <= serverStartedAtMs` rejected) when the
   * default process-local in-memory replay authority is in use. Omitted when
   * an explicit replay authority is supplied.
   */
  readonly serverStartedAtMs?: number;
  readonly cloud: ByokCloud;
  isClosed(): boolean;
  track<T>(operation: Promise<T>): Promise<T>;
}

const serverBindings = new WeakMap<ByokServer, HostMcpTaskContextBinding>();

function assertReplayAuthority(replay: unknown): DeviceAssertionReplayAuthority {
  if (
    replay === null ||
    typeof replay !== 'object' ||
    typeof (replay as DeviceAssertionReplayAuthority).consume !== 'function' ||
    typeof (replay as DeviceAssertionReplayAuthority).collectExpired !== 'function'
  ) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'hostMcpTaskContext.replay must implement DeviceAssertionReplayAuthority.',
    );
  }
  return replay as DeviceAssertionReplayAuthority;
}

/** Validate `CreateByokServerOptions.hostMcpTaskContext` before allocating stores. */
export function validateHostMcpTaskContextOption(option: HostMcpTaskContextOptions | undefined): void {
  if (option === undefined) return;
  if (option === null || typeof option !== 'object' || Array.isArray(option) || option.enabled !== true) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'hostMcpTaskContext must be omitted or { enabled: true, replay? }.',
    );
  }
  if (option.replay !== undefined) {
    assertReplayAuthority(option.replay);
  }
}

export function resolveHostMcpTaskContext(
  option: HostMcpTaskContextOptions | undefined,
  existingCloudReplay?: DeviceAssertionReplayAuthority,
): ResolvedHostMcpTaskContext | undefined {
  validateHostMcpTaskContextOption(option);
  if (option === undefined) return undefined;
  if (option.replay !== undefined) {
    return { enabled: true, replay: assertReplayAuthority(option.replay), enforceStartFloor: false };
  }
  if (existingCloudReplay !== undefined) {
    return { enabled: true, replay: assertReplayAuthority(existingCloudReplay), enforceStartFloor: false };
  }
  return {
    enabled: true,
    replay: new InMemoryDeviceAssertionReplayAuthority(),
    enforceStartFloor: true,
  };
}

export function registerHostMcpTaskContext(server: ByokServer, binding: HostMcpTaskContextBinding): void {
  serverBindings.set(server, binding);
}

const UTF8 = new TextEncoder();

function isNonEmptyExactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function sameAgentRef(expected: AgentRef, actual: AgentRef): boolean {
  return actual.agentId === expected.agentId && actual.profileRevision === expected.profileRevision;
}

/**
 * Failure-path-only classifier: distinguishes an otherwise authentic, current,
 * unexpired task assertion for this server/product whose only §8.2(2) mismatch
 * is `audience` from forged, expired, revoked, or wrong-server assertions.
 * Never returns a principal and never touches the replay store.
 */
async function isAudienceMismatchOnly(
  binding: HostMcpTaskContextBinding,
  input: VerifyHostMcpTaskAssertionInput,
  now: Date,
): Promise<boolean> {
  let parsed: TaskAssertionEnvelopeV1;
  try {
    parsed = parseTaskAssertionEnvelope(input.assertion);
  } catch {
    return false;
  }
  if (parsed.protected.audience === input.audience) return false;
  if (parsed.protected.issuer !== input.issuer || parsed.protected.productId !== binding.productId) {
    return false;
  }

  let matchedAuthority = false;
  const verified = await verifyTaskAssertion(input.assertion, {
    verifier: {
      verify: ({ publicKey, signingInput, signature }) =>
        binding.crypto.verifyEd25519(publicKey, signingInput, signature),
    },
    lookupDevice: async (deviceId) => {
      const row = await binding.devices.resolveByDeviceId(deviceId);
      if (
        row === undefined ||
        row.tenantId !== binding.tenant ||
        row.productId !== binding.productId ||
        row.deviceId !== deviceId
      ) {
        return undefined;
      }
      matchedAuthority = true;
      return { publicKeyJwkX: row.devicePublicKey, revoked: row.revoked };
    },
    now,
  });
  return verified !== undefined && matchedAuthority && verified.audience !== input.audience;
}

/**
 * Single verification entry for a host-toolset invocation on an embedded
 * {@link ByokServer}. Proves both spec §8.2(2) and §8.2(3) in one call and
 * fails closed with {@link HostMcpTaskAssertionError}:
 *
 * - §8.2(2): calls `authenticateHostedTaskAssertion` to verify the
 *   `byok-task-assertion-v1` envelope against the current non-revoked device
 *   row, time window/TTL, signature, exact `issuer`, server `productId`, and
 *   required `audience`, then atomically spends `jti` once. When the default
 *   process-local in-memory replay authority is used, an authentic assertion
 *   whose `issuedAt` is at or before this server instance's construction time
 *   is rejected with `assertion_predates_server`. Replay-store errors reject
 *   with `replay_store_unavailable` and never downgrade to signature-only
 *   acceptance.
 * - §8.2(3): verifies that the claimed `taskId`, owning device, and frozen
 *   `agentRef` belong to an active (`claimed` or `running`, non-cancelled)
 *   Execution on this server whose frozen `requiredToolsets` includes the
 *   required `toolset` and matches the assertion's `toolsetId`.
 */
export async function verifyHostMcpTaskAssertion(
  server: ByokServer,
  input: VerifyHostMcpTaskAssertionInput,
): Promise<AuthenticatedTaskAssertion> {
  const binding = typeof server === 'object' && server !== null ? serverBindings.get(server) : undefined;
  if (binding === undefined || binding.isClosed()) {
    throw new HostMcpTaskAssertionError(
      'task_context_disabled',
      'Host MCP task-context verification is not enabled on this server.',
    );
  }

  return binding.track(verifyAgainstBinding(binding, input));
}

async function verifyAgainstBinding(
  binding: HostMcpTaskContextBinding,
  input: VerifyHostMcpTaskAssertionInput,
): Promise<AuthenticatedTaskAssertion> {
  if (binding.isClosed()) {
    throw new HostMcpTaskAssertionError(
      'task_context_disabled',
      'Host MCP task-context verification is not enabled on this server.',
    );
  }
  if (
    input === null ||
    typeof input !== 'object' ||
    input.assertion === undefined ||
    input.assertion === null ||
    input.assertion === ''
  ) {
    throw new HostMcpTaskAssertionError('assertion_missing', 'Task assertion is missing.');
  }
  if (!isNonEmptyExactString(input.issuer)) {
    throw new HostMcpTaskAssertionError(
      'assertion_invalid',
      'Expected issuer must be a non-empty string without leading or trailing whitespace.',
    );
  }
  if (
    !isNonEmptyExactString(input.audience) ||
    UTF8.encode(input.audience).byteLength > DEVICE_ASSERTION_AUDIENCE_MAX_BYTES
  ) {
    throw new HostMcpTaskAssertionError(
      'assertion_invalid',
      'Expected audience must be a valid non-empty audience string.',
    );
  }
  if (!ToolsetIdSchema.safeParse(input.toolset).success) {
    throw new HostMcpTaskAssertionError(
      'toolset_not_offered',
      'Expected toolset must be a valid logical toolset identifier.',
    );
  }

  const now = binding.clock.now();
  const frozenClock: Clock = { now: () => now };

  let replayAttempted = false;
  let replayConsumed: boolean | undefined;
  let replayFailed = false;
  let replayError: unknown;
  const replay: DeviceAssertionReplayAuthority = {
    collectExpired: (tenant, collectInput) => binding.replay.collectExpired(tenant, collectInput),
    consume: async (consumeInput) => {
      replayAttempted = true;
      try {
        const consumed = await binding.replay.consume(consumeInput);
        if (typeof consumed !== 'boolean') {
          throw new Error('Replay authority returned a non-boolean result.');
        }
        replayConsumed = consumed;
        return consumed;
      } catch (error) {
        replayFailed = true;
        replayError = error;
        throw error;
      }
    },
  };

  let authenticated: AuthenticatedTaskAssertion | undefined;
  try {
    authenticated = await authenticateHostedTaskAssertion(input.assertion, {
      devices: binding.devices,
      crypto: binding.crypto,
      replay,
      clock: frozenClock,
      expected: {
        issuer: input.issuer,
        productId: binding.productId,
        audience: input.audience,
      },
    });
  } catch (error) {
    if (replayFailed) {
      throw new HostMcpTaskAssertionError(
        'replay_store_unavailable',
        'Task assertion replay store is unavailable.',
        { cause: replayError },
      );
    }
    throw error;
  }

  if (authenticated === undefined) {
    if (replayAttempted && replayConsumed === false) {
      throw new HostMcpTaskAssertionError(
        'assertion_replayed',
        'Task assertion JTI has already been consumed.',
      );
    }
    if (await isAudienceMismatchOnly(binding, input, now)) {
      throw new HostMcpTaskAssertionError(
        'assertion_audience_mismatch',
        'Task assertion audience does not match the required audience.',
      );
    }
    throw new HostMcpTaskAssertionError(
      'assertion_invalid',
      'Task assertion is invalid, expired, or not signed by an active device for this server.',
    );
  }

  if (replayConsumed !== true) {
    throw new HostMcpTaskAssertionError(
      'replay_store_unavailable',
      'Task assertion replay store did not confirm single-use consumption.',
    );
  }
  if (authenticated.device.tenantId !== binding.tenant) {
    throw new HostMcpTaskAssertionError(
      'assertion_invalid',
      'Task assertion tenant does not match this server.',
    );
  }

  // Default in-memory replay only observes JTIs spent since this server
  // instance was constructed; reject authentic assertions minted at or before
  // that instant so a server restart cannot replay a previously spent JTI.
  if (binding.serverStartedAtMs !== undefined) {
    const issuedAtMs = Date.parse(authenticated.issuedAt);
    if (
      !Number.isFinite(binding.serverStartedAtMs) ||
      !Number.isFinite(issuedAtMs) ||
      issuedAtMs <= binding.serverStartedAtMs
    ) {
      throw new HostMcpTaskAssertionError(
        'assertion_predates_server',
        'Task assertion was issued at or before this server instance started.',
      );
    }
  }

  // §8.2(3): confirm the claimed task, owning device, and frozen AgentRef
  // belong to an active Execution whose frozen offer still authorizes `toolset`.
  const attempt = await binding.cloud.readTaskAttempt(binding.tenant, authenticated.taskId);
  if (
    attempt === undefined ||
    attempt.tenantId !== binding.tenant ||
    attempt.deviceId !== authenticated.device.deviceId ||
    attempt.ownerDeviceId !== authenticated.device.deviceId ||
    attempt.cancellation !== undefined ||
    (attempt.status !== 'claimed' && attempt.status !== 'running') ||
    !sameAgentRef(attempt.agentRef, authenticated.agentRef)
  ) {
    throw new HostMcpTaskAssertionError(
      'task_inactive',
      `Task ${authenticated.taskId} is not an active execution for this device and Agent.`,
    );
  }

  const offer = await binding.cloud.readTaskOffer(binding.tenant, authenticated.taskId);
  if (
    offer === undefined ||
    offer.deviceId !== authenticated.device.deviceId ||
    !sameAgentRef(offer.payload.agentRef, authenticated.agentRef)
  ) {
    throw new HostMcpTaskAssertionError(
      'task_inactive',
      `Task ${authenticated.taskId} has no matching frozen execution offer.`,
    );
  }

  if (
    authenticated.toolsetId !== input.toolset ||
    offer.payload.requiredToolsets === undefined ||
    !offer.payload.requiredToolsets.includes(input.toolset)
  ) {
    throw new HostMcpTaskAssertionError(
      'toolset_not_offered',
      `Toolset ${input.toolset} is not authorized by the frozen offer for task ${authenticated.taskId}.`,
    );
  }

  return authenticated;
}
