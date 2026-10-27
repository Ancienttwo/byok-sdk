import type { Envelope, RuntimeInfo, CapabilityFlag, RuntimeId, AgentEgressPolicy, ContentReadPolicy } from '@byok-sdk/protocol';
import { type JournalIdentity, type ReceivedEnvelopeRecord, journalHash } from '../journal/journal';
import { encodeEnvelope, isTaskOfferType, TERMINAL_PROJECTION_SELECTION_CAPABILITY, PROVIDER_PROFILE_BINDING_CAPABILITY, AGENT_HOME_READERS_CAPABILITY, AGENT_MEMORY_SELECTION_CAPABILITY, AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY, AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY, AGENT_HOME_PROJECTION_CAPABILITY, AGENT_INPUT_PREPARATION_CAPABILITY, PROVIDER_PROVISIONING_CAPABILITY, AGENT_MEMORY_INTENT_CAPABILITY, AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, AGENT_EGRESS_FRESH_SESSION_CAPABILITY, AGENT_MESSAGE_EGRESS_CAPABILITY } from '@byok-sdk/protocol';
import type { RuntimeAdapter } from '../../types';
import { type HarnessInfo, HarnessIdSchema } from '@byok-sdk/protocol';
import { type RuntimeObservation, observeRuntimeDetection, projectRuntimeObservation, isWireRuntimeId } from '../../runtime-detection';
import { toRuntimeInfoCapabilities } from '../runtime-capabilities';
import { type AgentContentReadSurface, type AgentContentReadPolicySelection, AGENT_CONTENT_READ_CAPABILITIES, createAgentContentReadPolicy, type AgentContentReadPolicy } from '../agent-content-read';
import { PiAdapter } from '../../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../../adapters/claude/claude-adapter';
import { CodexAdapter } from '../../adapters/codex/codex-adapter';
import { DEVICE_ASSERTION_AUDIENCE_MAX_BYTES, DEVICE_ASSERTION_DEFAULT_TTL_MS, DEVICE_ASSERTION_MAX_TTL_MS } from '@byok-sdk/core';
import type { AgentContentReadConfig, DaemonConfig, DeviceAssertionConfig } from '../create-daemon';

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
 * `task.complete`/`task.fail`/`task.cancelled` -> the terminal kind recorded locally.
 * A sealed terminal (`task.complete_sealed`, …) has the kind of its plaintext type.
 */
export function terminalKindOf(type: string): 'complete' | 'failed' | 'cancelled' | 'declined' | undefined {
  const plainType = type.endsWith('_sealed') ? type.slice(0, -'_sealed'.length) : type;
  if (plainType === 'task.decline') return 'declined';
  if (plainType === 'task.complete') return 'complete';
  if (plainType === 'task.fail') return 'failed';
  if (plainType === 'task.cancelled') return 'cancelled';
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
    opensTask: isTaskOfferType(envelope.type),
  };
}

/** Runtimes actually detected as present on this device, typed per protocol §10 gap #4 (`ConnHelloPayload.runtimes`). Computed once at `start()` — re-probing on every reconnect would mean re-spawning each runtime's `--version` check for no real benefit within one daemon lifetime. */
export async function detectRuntimes(adapters: RuntimeAdapter[]): Promise<{ runtimes: RuntimeInfo[]; harnesses: HarnessInfo[]; observations: RuntimeObservation[] }> {
  const detections = await Promise.all(adapters.map(async (adapter) => ({ adapter, detected: await observeRuntimeDetection(adapter) })));
  const runtimes: RuntimeInfo[] = [];
  const harnesses: HarnessInfo[] = [];
  const observations: RuntimeObservation[] = [];
  for (const { adapter, detected } of detections) {
    observations.push(projectRuntimeObservation(adapter.descriptor, detected));
    if (detected.kind !== 'available') continue;
    if (detected.advisory !== undefined) {
      console.warn(`[byok/client] ${adapter.descriptor.id} ${detected.version ?? '(unknown version)'} is not the qualified ${detected.advisory.qualifiedVersion}; continuing`);
    }
    if (!isWireRuntimeId(adapter.descriptor.id)) {
      harnesses.push({ id: HarnessIdSchema.parse(adapter.descriptor.id),
        ...(detected.version === undefined ? {} : { version: detected.version }),
        capabilities: toRuntimeInfoCapabilities(adapter.descriptor.capabilities) });
      continue;
    }
    const info: RuntimeInfo = { id: adapter.descriptor.id };
    if (detected.version !== undefined) info.version = detected.version;
    if (detected.authPresent !== undefined) info.authPresent = detected.authPresent;
    // Pre-freeze addition (`RuntimeInfo.capabilities`, `messages.ts`):
    // surfaces this same adapter descriptor's capabilities (already used above
    // by `computeCapabilities` for the connection-level `steer` flag) into
    // the per-runtime wire field — see `toRuntimeInfoCapabilities`'s doc
    // comment.
    info.capabilities = toRuntimeInfoCapabilities(adapter.descriptor.capabilities);
    runtimes.push(info);
  }
  return { runtimes, harnesses, observations };
}

/**
 * M0 gatekeeper finding ②: advertise only what this device can actually do,
 * not a static spread of every known flag. `steer` reflects whether any
 * configured adapter can express it; `blob-upload` is unconditional now
 * that the blob client (protocol §7) genuinely implements it.
 */
export function computeCapabilities(
  adapters: RuntimeAdapter[],
  agentHomeConfigured = false,
  agentHomeProjectionConfigured = false,
  agentEgressConfigured = false,
  contentReadPolicies?: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>,
  providerProfileBindingConfigured = false,
  inputPreparationConfigured = false,
  providerProvisioningConfigured = false,
  agentMemoryIntentsProven = false,
): CapabilityFlag[] {
  const flags: CapabilityFlag[] = [];
  if (adapters.some((adapter) => adapter.descriptor.capabilities.steer)) flags.push('steer');
  flags.push('blob-upload');
  flags.push(TERMINAL_PROJECTION_SELECTION_CAPABILITY);
  const selectionAdapters = adapters.filter((adapter) =>
    ALL_RUNTIME_IDS.includes(adapter.descriptor.id as RuntimeId),
  );
  if (
    selectionAdapters.length > 0 &&
    selectionAdapters.every((adapter) => adapter.descriptor.supportsDispatchSelection === true)
  ) {
    flags.push('dispatch-selection');
  }
  if (
    providerProfileBindingConfigured &&
    adapters.some((adapter) => adapter.descriptor.id === 'pi' && adapter.descriptor.supportsDispatchSelection)
  ) {
    flags.push(PROVIDER_PROFILE_BINDING_CAPABILITY);
  }
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
  if (agentHomeProjectionConfigured) flags.push(AGENT_HOME_PROJECTION_CAPABILITY);
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
 * Canonical construction/identity order for `createDaemon`'s bundled adapter
 * set (`buildDefaultAdapters` below) and for `conn.hello.runtimes`
 * reporting order (`detectRuntimes`) — this is NOT the auto-select priority
 * order.
 *
 * M5 batch-3 (workstream 1): auto-select priority now lives entirely in
 * `task-runner.ts`, as its own explicit order independent of this one — see
 * `DEFAULT_RUNTIME_PREFERENCE`/`TaskRunner.pickAdapter`, overridable
 * per-daemon via `DaemonConfig.runtimePreference` above. Before this change,
 * `pickAdapter`'s no-runtime branch walked `deps.adapters` directly (this
 * array's own construction order), so listing pi first here silently made
 * it the de-facto DEFAULT auto-selected runtime whenever present — the
 * opposite of the product decision that pi is the FALLBACK runtime (tried
 * only once nothing better is available/capable), not the default. That
 * conflation is why this constant's order and the auto-select order are now
 * two independent things: this one stays `['pi', 'claude', 'codex']`
 * (unchanged — still a perfectly fine construction/reporting order, and
 * changing it would needlessly reshuffle `conn.hello.runtimes` for no
 * reason), while `DEFAULT_RUNTIME_PREFERENCE` states the actual selection
 * priority explicitly (`['claude', 'codex', 'pi']`, pi last) instead of
 * leaving it as an implicit side effect of this list's order.
 */
export const ALL_RUNTIME_IDS: readonly RuntimeId[] = ['pi', 'claude', 'codex'];

export function buildAdapter(id: RuntimeId, config: DaemonConfig, piByokLauncher: DaemonConfig['piByokLauncher']): RuntimeAdapter {
  switch (id) {
    case 'pi':
      return new PiAdapter({ nativeAssetRoot: config.nativeAssetRoot, byokLauncher: piByokLauncher, ...(config.sdkHelperHost === undefined ? {} : { sdkHelperHost: config.sdkHelperHost }), ...(config.durablePi === true ? { durablePi: true } : {}) });
    case 'claude':
      return new ClaudeAdapter({ nativeAssetRoot: config.nativeAssetRoot });
    case 'codex':
      return new CodexAdapter({ nativeAssetRoot: config.nativeAssetRoot, ...(config.codexSandbox === undefined ? {} : { sandbox: config.codexSandbox }) });
  }
}

/**
 * Builds `createDaemon`'s bundled adapter set from `DaemonConfig.runtimeAllowlist`
 * — see that field's own doc comment for the unset-vs-set contract. Filters
 * `ALL_RUNTIME_IDS` (rather than mapping the allowlist directly) so an
 * allowlist entry that isn't a real runtime id is silently ignored — the same
 * "unknown id never gets an adapter" fail-closed shape `TaskRunner.pickAdapter`
 * already applies to an unknown *requested* runtime — and it de-duplicates
 * repeated entries for free.
 */
export function buildDefaultAdapters(config: DaemonConfig, piByokLauncher: DaemonConfig['piByokLauncher']): RuntimeAdapter[] {
  const ids = config.runtimeAllowlist
    ? ALL_RUNTIME_IDS.filter((id) => config.runtimeAllowlist?.includes(id))
    : ALL_RUNTIME_IDS;
  return ids.map((id) => buildAdapter(id, config, piByokLauncher));
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
