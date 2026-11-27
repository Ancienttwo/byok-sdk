import type { Envelope, CapabilityFlag, AgentEgressPolicy, ContentReadPolicy, RuntimeUnavailableEntry } from '@byok-sdk/protocol';
import { type JournalIdentity, type ReceivedEnvelopeRecord, journalHash } from '../journal/journal.js';
import { encodeEnvelope, AGENT_HOME_READERS_CAPABILITY, AGENT_MEMORY_SELECTION_CAPABILITY, AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY, AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY, AGENT_HOME_PROJECTION_CAPABILITY, AGENT_HOME_PROJECTION_HOST_REVISION_CAPABILITY, AGENT_INPUT_PREPARATION_CAPABILITY, PROVIDER_PROVISIONING_CAPABILITY, AGENT_MEMORY_INTENT_CAPABILITY, AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY, AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, AGENT_EGRESS_FRESH_SESSION_CAPABILITY, AGENT_MESSAGE_EGRESS_CAPABILITY } from '@byok-sdk/protocol';
import type { RuntimeAdapter } from '../../types.js';
import type { DaemonConfigIssue } from '../config-schema/validate.js';
import { type HarnessInfo, HarnessIdSchema } from '@byok-sdk/protocol';
import { type RuntimeObservation, detectedRuntimeCapabilities, observeRuntimeDetection } from '../../runtime-detection.js';
import { projectRuntimeObservationWithUpgrade } from '../../runtime/runtime-releases.js';
import { runtimeUnavailableForDetection, runtimeUnavailableRetryable } from '../../runtime-unavailable.js';
import { runtimeVersionPolicyProjection } from '../../runtime-version-policy.js';
import { toRuntimeInfoCapabilities } from '../runtime-capabilities.js';
import { type AgentContentReadSurface, type AgentContentReadPolicySelection, AGENT_CONTENT_READ_CAPABILITIES, createAgentContentReadPolicy, type AgentContentReadPolicy } from '../agent-content-read.js';
import { DEVICE_ASSERTION_AUDIENCE_MAX_BYTES, DEVICE_ASSERTION_DEFAULT_TTL_MS, DEVICE_ASSERTION_MAX_TTL_MS } from '@byok-sdk/core';
import type { AgentContentReadConfig, DaemonConfig, DeviceAssertionConfig } from '../create-daemon.js';
import { agySessionStoreOf } from '../../util/agy-session-retention.js';
import { LocalStorageConfigError, type ResolvedStorageConfig } from '../retention/config.js';

/**
 * Module-scope helpers of the daemon composition (#926): constants, adapter
 * construction, runtime detection and capability computation that
 * `buildDaemonWithAdapters` and its stages share. None is part of the public
 * surface; `create-daemon.ts` keeps every exported declaration.
 */

/**
 * M4 Phase 2 (originally control-socket-only). M5 batch-3 (workstream 2):
 * now the shared DEFAULT for every graceful-shutdown path via
 * `runShutdownSequence` — overridable per-daemon via
 * `DaemonConfig.shutdownGraceMs`. Bound on how long the graceful-shutdown
 * sequence waits for `TaskRunner.shutdownActiveTasks` before proceeding to
 * the rest of teardown regardless — an active task's `session.interrupt()`
 * hanging (a misbehaving runtime adapter) must never block the daemon from
 * actually stopping.
 */
export const SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS = 10_000;

/** Finding F5(b): default bound on how long `performControlShutdown` waits for the outbox to actually drain before closing the connection — see `ConnectionManager.stop`'s own doc comment. Overridable via `DaemonOverrides.shutdown.outboxDrainTimeoutMs`. */
export const DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS = 5_000;

/** The pairing is saved, but a member step after it failed: the device is paired without E2EE. */
export class PairedWithoutMemberError extends Error {
  constructor(deviceId: string, what: string, cause: unknown) {
    super(`device ${deviceId} is paired, but ${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PairedWithoutMemberError';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The outbound envelope types that carry a task's terminal, matching the set
 * the cloud records a terminal receipt for (`cloud/src/inbound.ts`'s
 * `applyLifecycle`). `task.decline` is deliberately NOT here: declining is
 * refusing to take a task, not producing a result for one.
 *
 * `task.complete`/`task.fail`/`task.cancelled` -> the terminal kind recorded
 * locally, whether the payload is plaintext or sealed.
 */
export function terminalKindOf(type: string): 'complete' | 'failed' | 'cancelled' | 'declined' | undefined {
  if (type === 'task.decline') return 'declined';
  if (type === 'task.complete') return 'complete';
  if (type === 'task.fail') return 'failed';
  if (type === 'task.cancelled') return 'cancelled';
  return undefined;
}

/**
 * One inbound envelope, as the journal wants it.
 *
 * `bytes` is the CANONICAL v1 encoding of the envelope this daemon parsed, not
 * the socket's original byte sequence — the frozen codec's round-trip
 * guarantee is what makes that a faithful record, and it is the same choice
 * the cloud's own terminal receipt makes.
 *
 * The protocol owns the task-opening family. Project that classification
 * here so neither the daemon nor the storage journal maintains a second list.
 */
export function toJournalEnvelopeRecord(envelope: Envelope, identity: JournalIdentity): ReceivedEnvelopeRecord {
  const bytes = encodeEnvelope(envelope);
  return {
    identity,
    envelopeId: envelope.id,
    ...(envelope.task_id === undefined ? {} : { taskId: envelope.task_id }),
    seq: envelope.seq ?? 0,
    bytes,
    bytesHash: journalHash(bytes),
    receivedAt: new Date().toISOString(),
    opensTask: envelope.type === 'task.offer',
  };
}

const RUNTIME_PROBE_CONCURRENCY = 8;

/** Scan the configured adapters for executor inventory and local diagnostics. */
export async function detectRuntimes(adapters: RuntimeAdapter[], allowlist?: readonly string[], signal?: AbortSignal): Promise<{
  harnesses: HarnessInfo[];
  observations: RuntimeObservation[];
  runtimeUnavailable: RuntimeUnavailableEntry[];
}> {
  const pending = adapters.entries();
  const detections: Awaited<ReturnType<typeof observeRuntimeDetection>>[] = [];
  let failed = false;
  async function probe(): Promise<void> {
    try {
      for (const [index, adapter] of pending) {
        if (failed) return;
        signal?.throwIfAborted();
        detections[index] = await observeRuntimeDetection(adapter, signal);
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  await Promise.all(Array.from({ length: Math.min(adapters.length, RUNTIME_PROBE_CONCURRENCY) }, probe));
  const harnesses: HarnessInfo[] = [];
  const observations: RuntimeObservation[] = [];
  const unavailable = new Map<string, RuntimeUnavailableEntry>();
  for (const [index, adapter] of adapters.entries()) {
    const detected = detections[index]!;
    const observation = projectRuntimeObservationWithUpgrade(adapter.descriptor, detected);
    observations.push(observation);
    const selectable = adapter.descriptor.selectionModes.length > 0;
    if (detected.kind !== 'available' || detected.versionVerdict?.state === 'block' || !selectable) {
      // One typed cause per failure, with the same retryable default the
      // decline path reports. Never a guessed cause from display text.
      const cause = detected.kind !== 'available' ? runtimeUnavailableForDetection(detected).cause
        : detected.versionVerdict?.state === 'block' ? 'version_blocked' : 'runtime_not_configured';
      if (!unavailable.has(adapter.descriptor.id)) {
        unavailable.set(adapter.descriptor.id, {
          id: adapter.descriptor.id,
          cause,
          retryable: runtimeUnavailableRetryable(cause),
        });
      }
      continue;
    }
    if (signal === undefined && detected.versionVerdict?.state === 'warn') {
      console.warn(`[byok/client] ${adapter.descriptor.id} ${detected.version ?? '(unknown version)'} is not the qualified ${detected.versionVerdict.qualifiedVersion}; continuing`);
    }
    // Absence of a verdict means the adapter declares no policy: omit the
    // field rather than inventing `allow` (#1103 D8/D9).
    const versionPolicy = runtimeVersionPolicyProjection(detected.versionVerdict);
    const capabilities = toRuntimeInfoCapabilities(detectedRuntimeCapabilities(adapter.descriptor, detected));
    if (allowlist !== undefined && !allowlist.includes(adapter.descriptor.id)) continue;
    harnesses.push({
      id: HarnessIdSchema.parse(adapter.descriptor.id),
      ...(observation.version === undefined || observation.version.length === 0 ? {} : { version: observation.version.slice(0, 128) }),
      ...(detected.authPresent === undefined ? {} : { authPresent: detected.authPresent }),
      capabilities: {
        ...capabilities,
        selectionModes: [...adapter.descriptor.selectionModes],
        ...(adapter.descriptor.defaultModelModes === undefined ? {} : { defaultModelModes: [...adapter.descriptor.defaultModelModes] }),
        effort: adapter.descriptor.supportsEffort === true,
        ...(adapter.descriptor.supportsServiceTier === true ? { serviceTier: true } : {}),
        ...(adapter.descriptor.supportsServiceTierFallback === true ? { serviceTierFallback: true } : {}),
        ...(adapter.descriptor.byokProviderId === undefined ? {} : { byokProviderId: adapter.descriptor.byokProviderId }),
      },
      ...(versionPolicy === undefined ? {} : { versionPolicy }),
    });
  }
  return { harnesses, observations, runtimeUnavailable: [...unavailable.values()] };
}

/**
 * M0 gatekeeper finding ②: advertise only what this device can actually do,
 * not a static spread of every known flag.
 */
export function computeCapabilities(
  adapters: RuntimeAdapter[],
  agentHomeConfigured = false,
  agentHomeProjectionConfigured = false,
  agentEgressConfigured = false,
  contentReadPolicies?: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>,
  inputPreparationConfigured = false,
  providerProvisioningConfigured = false,
  agentMemoryIntentsProven = false,
  agentMemoryBackendProven = false,
  nativeSessions?: { enabled?: boolean; platform?: NodeJS.Platform; sessionDir?: string },
): CapabilityFlag[] {
  const flags: CapabilityFlag[] = [];
  if (nativeSessions?.enabled === true
    && ['darwin', 'linux'].includes(nativeSessions.platform ?? process.platform)
    && nativeSessions.sessionDir !== undefined
    && adapters.some(adapter => adapter.descriptor.id === 'pi' && adapter.descriptor.memoryLane !== undefined)) flags.push('native-sessions');
  if (adapters.some((adapter) => adapter.descriptor.capabilities.mcpToolsets === true)) {
    flags.push('toolset-selection');
  }
  // Every Agent-home daemon reads the per-task memory selection, whatever its
  // memory admission: `none` and the two `*-if-admitted` values always run,
  // and an unadmitted `read` or `read-write` declines.
  if (agentHomeConfigured) {
    flags.push(
      'agent-home-contract', AGENT_HOME_READERS_CAPABILITY, AGENT_MEMORY_SELECTION_CAPABILITY,
      AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY, AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
    );
  }
  if (agentHomeProjectionConfigured) flags.push(AGENT_HOME_PROJECTION_CAPABILITY, AGENT_HOME_PROJECTION_HOST_REVISION_CAPABILITY);
  // Advertised only by a daemon whose `inputPreparation` section is present
  // AND whose native closure verified, because that pair is exactly what makes
  // the remote lane servable. The cloud reads this durable flag before it
  // allocates a receipt, so an unconfigured device is refused at the Host
  // rather than handed a row it can only answer with a rejection.
  if (inputPreparationConfigured) flags.push(AGENT_INPUT_PREPARATION_CAPABILITY);
  // Advertised only while the Host injected a handler: the Host's enqueue
  // gate reads this flag, so an unconfigured device is never sent a notice.
  if (providerProvisioningConfigured) flags.push(PROVIDER_PROVISIONING_CAPABILITY);
  // Advertised only with a Host transport, an Agent home, a secure memory
  // filesystem, and a backend whose ledger write is a proven durable barrier.
  if (agentMemoryIntentsProven) flags.push(AGENT_MEMORY_INTENT_CAPABILITY);
  // The same proof without the transport: a restore and a crash recovery write
  // through the same durable barrier.
  if (agentMemoryBackendProven) flags.push(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
  if (agentEgressConfigured) {
    flags.push(
      AGENT_EGRESS_POLICY_CAPABILITY,
      AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
      AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
    );
    if (agentHomeConfigured && adapters.some((adapter) => adapter.descriptor.capabilities.mcpToolsets === true)) {
      flags.push(AGENT_MESSAGE_EGRESS_CAPABILITY);
    }
  }
  if (contentReadPolicies !== undefined) {
    for (const surface of Object.keys(AGENT_CONTENT_READ_CAPABILITIES) as AgentContentReadSurface[]) {
      const policy = contentReadPolicies[surface];
      if (policy !== 'disabled') flags.push(policy.capability as CapabilityFlag);
    }
  }
  return flags;
}

export function resolveContentReadPolicies(
  egressPolicy: AgentEgressPolicy,
  config: AgentContentReadConfig | undefined,
): Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>> {
  const policies: Partial<Record<AgentContentReadSurface, AgentContentReadPolicySelection>> = {};
  for (const surface of Object.keys(AGENT_CONTENT_READ_CAPABILITIES) as AgentContentReadSurface[]) {
    const remote = egressPolicy.transfers[surface];
    const local = config?.[surface];
    if (remote === 'disabled' || local === undefined) {
      policies[surface] = 'disabled';
      continue;
    }
    policies[surface] = createAgentContentReadPolicy({
      enabled: true,
      capability: AGENT_CONTENT_READ_CAPABILITIES[surface],
      root: local.root,
      policyRevision: egressPolicy.policyRevision,
      maxBytes: remote.maxBytes,
      maxTextBytes: local.maxTextBytes,
      allowedMimeTypes: remote.allowedMimeTypes,
      textMimeTypes: local.textMimeTypes,
      ...(local.sensitiveNames === undefined ? {} : { sensitiveNames: local.sensitiveNames }),
    });
  }
  return Object.freeze({
    workspace: policies.workspace ?? 'disabled',
    transcript: policies.transcript ?? 'disabled',
    artifact: policies.artifact ?? 'disabled',
  });
}

export function hasExactContentReadTransfer(expected: ContentReadPolicy | 'disabled', actual: ContentReadPolicy): boolean {
  return (
    expected !== 'disabled' &&
    expected.maxBytes === actual.maxBytes &&
    expected.allowedMimeTypes.length === actual.allowedMimeTypes.length &&
    expected.allowedMimeTypes.every((mimeType, index) => mimeType === actual.allowedMimeTypes[index])
  );
}

/** Keep the received policy revision in the audit receipt while refusing any non-exact wire policy. */
export function policyRevisionMismatchPolicies(
  policies: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>,
  surface: AgentContentReadSurface,
): Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>> {
  const selected = policies[surface];
  if (selected === 'disabled') return policies;
  const mismatch: AgentContentReadPolicy = Object.freeze({
    ...selected,
    policyRevision: `${selected.policyRevision}:wire-policy-mismatch`,
  });
  return Object.freeze({ ...policies, [surface]: mismatch });
}

/**
 * `DaemonConfig` keys that configure the adapters `createDaemon` builds.
 * `createDaemonWithAdapters` rejects each one, even when undefined, and
 * `checkDaemonConfig` reports the same keys for injected adapters.
 */
const CREATE_DAEMON_ONLY_KEYS = [
  ['codexSandbox', 'configure the injected Codex adapter directly'],
  ['runtimeEnvironment', 'pass runtimeEnvironment to each injected adapter'],
  ['runtimeInstallRoot', 'pass runtimeInstallRoot to each injected adapter'],
  ['runtimes', 'pass the isolation options to each injected adapter'],
] as const;

/** The createDaemon-only keys `config` sets, in check order, with the message `createDaemonWithAdapters` throws. */
export function injectedAdapterConfigConflicts(config: Pick<DaemonConfig, (typeof CREATE_DAEMON_ONLY_KEYS)[number][0]>): { readonly key: string; readonly message: string }[] {
  return CREATE_DAEMON_ONLY_KEYS
    .filter(([key]) => Object.hasOwn(config, key))
    .map(([key, remedy]) => ({ key, message: `DaemonConfig.${key} is only supported by createDaemon; ${remedy}` }));
}

/** The first repeated adapter ID, shared by construction and configuration preflight. */
export function duplicateAdapterIdIssues(adapters: readonly RuntimeAdapter[]): DaemonConfigIssue[] {
  const ids = new Set<string>();
  for (const [index, adapter] of adapters.entries()) {
    const id = adapter.descriptor.id;
    if (ids.has(id)) return [{
      code: 'invalid_value', path: `adapters[${index}].descriptor.id`,
      message: `duplicate adapter descriptor.id: ${id}`,
    }];
    ids.add(id);
  }
  return [];
}

/** A live session ledger may name an agy session to resume, but only a daemon with an agy session store has one. */
export function assertAgySessionStoreTtl(ttlMs: ResolvedStorageConfig['ttlMs'], adapters: readonly object[]): void {
  if (adapters.every(adapter => agySessionStoreOf(adapter) === undefined)) return;
  if (ttlMs['agy-session-store'] < ttlMs['session-ledger'] + 86_400_000) throw new LocalStorageConfigError('retention.ttlMs.agy-session-store', "must be at least retention.ttlMs['session-ledger'] plus one day");
}

/**
 * Plan `device-assertion-broker`: validates `DaemonConfig.deviceAssertion
 * .audiences` and resolves it to the exact-match `Set` the `assertion.issue`
 * gate consults.
 *
 * `undefined` means the feature is OFF — returned for an absent section AND
 * for a present one with an empty list, which are the same statement. Every
 * other malformed shape throws: this is an allowlist for a local
 * authentication surface, and an operator who wrote one that does not parse
 * must not end up with a daemon that quietly allows nothing (indistinguishable
 * from "off") or, worse, one that allows something they did not write.
 */
export function resolveDeviceAssertionAudiences(config: DeviceAssertionConfig | undefined): Set<string> | undefined {
  if (config === undefined) return undefined;
  if (!Array.isArray(config.audiences)) {
    throw new Error(
      `DaemonConfig.deviceAssertion.audiences must be an array of exact audience strings — got ${JSON.stringify(config.audiences)}. Omit the deviceAssertion section (or pass an empty array) to leave the assertion broker disabled.`,
    );
  }
  if (config.audiences.length === 0) return undefined;
  const audiences = new Set<string>();
  for (const audience of config.audiences) {
    if (typeof audience !== 'string' || audience.length === 0) {
      throw new Error(
        `DaemonConfig.deviceAssertion.audiences entries must be non-empty strings — got ${JSON.stringify(audience)}`,
      );
    }
    if (Buffer.byteLength(audience, 'utf8') > DEVICE_ASSERTION_AUDIENCE_MAX_BYTES) {
      throw new Error(
        `DaemonConfig.deviceAssertion.audiences entry ${JSON.stringify(audience)} exceeds ${DEVICE_ASSERTION_AUDIENCE_MAX_BYTES} UTF-8 bytes`,
      );
    }
    if (audiences.has(audience)) {
      throw new Error(
        `DaemonConfig.deviceAssertion.audiences contains ${JSON.stringify(audience)} twice — rejected rather than de-duplicated, because a duplicate is usually a copy-paste that hid a typo in the entry that was meant to be different`,
      );
    }
    audiences.add(audience);
  }
  return audiences;
}

/** Plan `device-assertion-broker`: see `DeviceAssertionConfig.ttlMs`. Out of range is a construction error, never a clamp — silently shortening (or lengthening) an operator's configured credential lifetime is worse than refusing to start. */
export function resolveDeviceAssertionTtlMs(config: DeviceAssertionConfig | undefined): number {
  const ttlMs = config?.ttlMs ?? DEVICE_ASSERTION_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEVICE_ASSERTION_MAX_TTL_MS) {
    throw new Error(
      `DaemonConfig.deviceAssertion.ttlMs must be a positive integer no greater than ${DEVICE_ASSERTION_MAX_TTL_MS} ms — got ${JSON.stringify(config?.ttlMs)}`,
    );
  }
  return ttlMs;
}
