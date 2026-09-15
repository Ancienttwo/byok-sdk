import type { AgentRef, InputPreparationOfferBinding, PermissionMode } from '@byok-sdk/protocol';
import {
  inputPreparationDigest,
  inputPreparationRuntimeIdentityString,
  preparedToolBindingDigest,
  type InputPreparationRuntimeIdentityV1,
} from '../input-preparation';
import type { McpLaunchBinding, RuntimePreparedLaunchV1 } from '../types';
import type { McpToolsetServerObservation } from '../mcp/observation';
import { fingerprintPreparedToolSurface } from './prepared-tool-surface';
import { mcpLaunchAttestation } from './trusted-launch-cwd';
import type { ToolImplementationIdentityV1 } from './tool-implementation-identity';
import type { InputPreparationRecord } from './input-preparation-store';
import { inputPreparationReadinessReasons } from './input-preparation-service';

/**
 * The item-by-item comparison one `task.offer_prepared` must survive before a
 * single byte is claimed or dispatched.
 *
 * WHY item by item, rather than one digest over everything: a prepared
 * Execution that is refused has to say WHAT differed. "the observation digest
 * differs" is true of a rotated policy revision, a re-published toolset, a
 * replaced server binary and a schema change alike, and an operator holding
 * that sentence has learned nothing they can act on. So every fact that has its
 * own durable counterpart is compared as itself, in order from most specific to
 * least, and each difference carries its own reason.
 *
 * WHAT the durable record can and cannot answer, stated plainly because it
 * decides the shape of this file:
 *
 * - The binding answers device, Agent, profile revision, policy revision,
 *   permission mode, runtime identity and request digest DIRECTLY. Those are
 *   compared as values.
 * - The artifact summary answers the envelope digest, the tool implementation
 *   kinds (which are keyed by model-visible tool NAME, so they also answer the
 *   counted tool SET), and the two surface digests.
 * - Nothing durable carries the launch attestation, the toolset definition
 *   revisions or the observed schemas as values — they exist only inside
 *   `toolBindingDigest` and `observationDigest`. So the launcher half of the
 *   attestation is compared structurally (a preparation is counted under the
 *   direct-cwd boundary the pi lane uses and never attests a launcher, so a
 *   launcher-wrapped task can never match one), the launch directory and the
 *   definition revisions are compared through `toolBindingDigest`, and the
 *   schemas through `observationDigest`.
 *
 * WHERE the live values come from: this daemon's OWN admission of this offer —
 * the merged policy, the one trusted launch binding it resolved, the one
 * implementation identity per server it resolved, and the `tools/list`
 * observation its admission probe took. Nothing is re-resolved here. A second
 * resolution would be a second opinion about the same install, and the two
 * could disagree without anything noticing.
 *
 * The live surface digests are produced by
 * {@link fingerprintPreparedToolSurface} and {@link preparedToolBindingDigest} —
 * the SAME functions the preparation path computed the recorded ones with. A
 * launch-side reimplementation would be a second definition of the counted
 * manifest, and the two could drift for a whole release without anything
 * noticing, which is precisely what these digests exist to catch.
 */

/**
 * Every way a prepared offer is refused. All of them are terminal for this
 * offer: re-offering the same reference against the same device state reaches
 * the same answer, and a prepared failure never permits sending a DIFFERENT
 * input under the same accounting.
 */
export type PreparedOfferDeclineReason =
  /** This daemon has no input-preparation lane at all, so it can consume none. */
  | 'preparation_lane_unconfigured'
  /** No record under this reference in this daemon's durable store. */
  | 'preparation_not_found'
  /** The record exists but is not ready to admit an Execution; the detail names every reason. */
  | 'preparation_not_ready'
  /** The record was counted on a different device row. */
  | 'preparation_device_mismatch'
  /** The record was counted for a different Agent. */
  | 'preparation_agent_mismatch'
  /** The offer's Agent presents a different profile revision than the record was counted under. */
  | 'preparation_profile_revision_mismatch'
  /** The operator's limits-policy revision moved since the record was counted. */
  | 'preparation_policy_revision_mismatch'
  /** The Host re-presented a request digest the record does not carry. */
  | 'preparation_request_digest_mismatch'
  /** The Host re-presented an envelope digest the record's artifact does not carry. */
  | 'preparation_artifact_digest_mismatch'
  /** This offer was ADMITTED under a mode the manifest was not filtered for. */
  | 'preparation_permission_mode_mismatch'
  /** The installed native closure is not the one that compiled the artifact. */
  | 'preparation_runtime_identity_mismatch'
  /** No trusted launch boundary, or one a preparation can never have attested. */
  | 'preparation_launch_attestation_mismatch'
  /** The live tool set is not the set of model-visible names that were counted. */
  | 'preparation_tool_set_mismatch'
  /** The same tool names, but a different implementation-identity kind behind one of them. */
  | 'preparation_tool_implementation_kinds_mismatch'
  /** The live launch directory, definition revisions, argv or identities differ from the counted ones. */
  | 'preparation_tool_binding_digest_mismatch'
  /** Same names and same kinds, but a different observed schema surface. */
  | 'preparation_observation_digest_mismatch'
  /** The live observation could not be projected or fingerprinted at all. */
  | 'preparation_tool_surface_unfingerprintable'
  /** Another Execution already consumed this record. The loser claims nothing. */
  | 'preparation_already_pinned';

export interface PreparedOfferDecline {
  readonly ok: false;
  readonly reason: PreparedOfferDeclineReason;
  /** A stable, operator-actionable sentence naming the item that differed. */
  readonly detail: string;
}

export interface PreparedOfferAdmission {
  readonly ok: true;
  /**
   * Everything the prepared start variant needs, assembled from the record's
   * own binding and artifact summary. It is NOT produced here as a commitment:
   * the caller seals, pins and claims first, and only then hands this to the
   * adapter.
   */
  readonly launch: RuntimePreparedLaunchV1;
}

export type PreparedOfferAdmissionResult = PreparedOfferAdmission | PreparedOfferDecline;

/** One projected MCP toolset server, exactly as this task resolved it. */
export interface PreparedOfferServerProjection {
  readonly serverName: string;
  readonly toolsetId: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface PreparedOfferAdmissionInput {
  /** The durable record this offer names, already looked up by reference. */
  readonly record: InputPreparationRecord;
  /** The absolute path of the record's retained artifact (`InputPreparationStore.artifactPathOf`). */
  readonly artifactPath: string;
  /** What the Host re-presented on the wire. Never authority; only ever compared. */
  readonly offered: InputPreparationOfferBinding;
  readonly agentRef: AgentRef;
  readonly deviceId: string;
  /** The operator's limits-policy revision in force on this daemon right now. */
  readonly policyRevision: string;
  /** The VERIFIED installed runtime/compiler identity this daemon would compile with today. */
  readonly runtime: InputPreparationRuntimeIdentityV1;
  /** The mode this offer was ADMITTED under — the merged policy's, not the offer's request. */
  readonly admittedMode: PermissionMode;
  /** The one launch boundary this task resolved for every MCP child it will start. */
  readonly launch: McpLaunchBinding | undefined;
  /** The live `tools/list` answer this task's own admission probe took. */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>> | undefined;
  /** The one implementation identity per projected server this task resolved. */
  readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>> | undefined;
  /** The projected servers, as this task resolved them from its registry. */
  readonly servers: readonly PreparedOfferServerProjection[];
  /** `toolsetId` -> definition revision, from the same registry read. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  readonly nowMs: number;
}

function decline(reason: PreparedOfferDeclineReason, detail: string): PreparedOfferDecline {
  return Object.freeze({ ok: false as const, reason, detail });
}

/** Byte order, so a name comparison does not depend on the host locale. */
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

/**
 * Compare one already-counted preparation record against the Execution this
 * device is about to admit, item by item.
 *
 * Returns the prepared launch on equality. It does NOT seal, pin, claim or
 * start: this function decides whether those are allowed to happen, and keeping
 * it side-effect-free is what lets a losing runner in a race call it and then
 * dispatch nothing.
 */
export async function admitPreparedOffer(
  input: PreparedOfferAdmissionInput,
): Promise<PreparedOfferAdmissionResult> {
  const { record } = input;

  // --- readiness --------------------------------------------------------
  // Asked first, and through the SAME derivation a receipt answers with: a
  // record that is not ready is not ready for an Execution either, and a second
  // opinion about readiness here is how a device comes to admit something its
  // own receipt called unready.
  const reasons = inputPreparationReadinessReasons(record, input.nowMs);
  if (reasons.length > 0) {
    return decline(
      'preparation_not_ready',
      `the named preparation is not ready to admit an Execution: ${reasons.join(', ')}`,
    );
  }
  const summary = record.artifact;
  if (summary === undefined) {
    // Unreachable while `inputPreparationReadinessReasons` reports `not_counted`
    // for a record with no artifact; kept because the launch below dereferences
    // it, and a fail-closed branch is cheaper than a future refactor's crash.
    return decline('preparation_not_ready', 'the named preparation retains no artifact summary');
  }

  // --- identity, as values the binding carries directly -----------------
  const binding = record.binding;
  if (binding.deviceId !== input.deviceId) {
    return decline(
      'preparation_device_mismatch',
      `the named preparation was counted for device ${JSON.stringify(binding.deviceId)}, not this one`,
    );
  }
  if (binding.agentRef !== input.agentRef.agentId) {
    return decline(
      'preparation_agent_mismatch',
      `the named preparation was counted for Agent ${JSON.stringify(binding.agentRef)},`
      + ` and this offer is for ${JSON.stringify(input.agentRef.agentId)}`,
    );
  }
  if (binding.profileRevision !== input.agentRef.profileRevision) {
    return decline(
      'preparation_profile_revision_mismatch',
      `the named preparation was counted under profile revision ${JSON.stringify(binding.profileRevision)},`
      + ` and this offer presents ${JSON.stringify(input.agentRef.profileRevision)}`,
    );
  }
  if (binding.policyRevision !== input.policyRevision) {
    return decline(
      'preparation_policy_revision_mismatch',
      `the named preparation was counted under limits-policy revision ${JSON.stringify(binding.policyRevision)},`
      + ` and ${JSON.stringify(input.policyRevision)} is in force on this device`,
    );
  }
  if (binding.requestDigest !== input.offered.requestDigest || record.requestDigest !== input.offered.requestDigest) {
    return decline(
      'preparation_request_digest_mismatch',
      'this offer re-presents a request digest the named preparation does not carry',
    );
  }
  if (input.offered.artifactDigest !== undefined && summary.envelopeDigest !== input.offered.artifactDigest) {
    return decline(
      'preparation_artifact_digest_mismatch',
      'this offer re-presents an envelope digest the named preparation does not carry',
    );
  }
  if (binding.permissionMode !== input.admittedMode) {
    return decline(
      'preparation_permission_mode_mismatch',
      `the named preparation counted a manifest filtered for mode ${JSON.stringify(binding.permissionMode)},`
      + ` and this offer was admitted under ${JSON.stringify(input.admittedMode)}`,
    );
  }
  const runtimeIdentity = inputPreparationRuntimeIdentityString(input.runtime);
  if (inputPreparationDigest(binding.runtime) !== inputPreparationDigest(input.runtime)) {
    return decline(
      'preparation_runtime_identity_mismatch',
      `the named preparation was compiled against ${JSON.stringify(inputPreparationRuntimeIdentityString(binding.runtime))},`
      + ` and this device has ${JSON.stringify(runtimeIdentity)} installed`,
    );
  }

  // --- the launch boundary ----------------------------------------------
  // The directory itself has no durable counterpart and is compared through
  // `toolBindingDigest` below. The LAUNCHER half does have one, structurally: a
  // preparation resolves the direct-cwd boundary the pi lane uses and never
  // attests a launcher (`prepared-tool-surface.ts`'s `resolveLaunch`), so a
  // task that resolved a launcher-wrapped boundary is running a different
  // launch mechanism than the one that was counted — and saying so by name
  // beats reporting it as an opaque digest difference.
  if (input.launch === undefined) {
    return decline(
      'preparation_launch_attestation_mismatch',
      'this task proved no trusted MCP launch boundary, and a preparation is counted under one',
    );
  }
  if (input.launch.launcher !== undefined) {
    return decline(
      'preparation_launch_attestation_mismatch',
      'this task resolved a launcher-wrapped MCP launch boundary, and a preparation attests the direct'
      + ' boundary the prepared runtime launches its servers in',
    );
  }
  const launch = mcpLaunchAttestation(input.launch);

  if (input.observation === undefined || input.implementations === undefined || input.servers.length === 0) {
    return decline(
      'preparation_tool_set_mismatch',
      'this task projected no observed MCP toolset servers, and the named preparation counted a manifest of them',
    );
  }

  // --- the concrete tool set --------------------------------------------
  const fingerprinted = await fingerprintPreparedToolSurface({
    observation: input.observation,
    permissionMode: input.admittedMode,
    runtimeIdentity,
    launch,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    implementations: input.implementations,
  });
  if (!fingerprinted.ok) {
    return decline(
      'preparation_tool_surface_unfingerprintable',
      `this task's own tool surface could not be fingerprinted (${fingerprinted.detail}): ${fingerprinted.message}`,
    );
  }
  const live = fingerprinted.fingerprint;

  // Names first, by name, because a decline can then say WHICH tool appeared or
  // vanished. `toolImplementationKinds` is keyed by model-visible tool name, so
  // it is the counted set's own durable spelling — no second list is needed.
  const countedNames = Object.keys(summary.toolImplementationKinds).sort(compareNames);
  const liveNames = live.tools.map((tool) => tool.name).sort(compareNames);
  if (countedNames.length !== liveNames.length || countedNames.some((name, index) => name !== liveNames[index])) {
    const added = liveNames.filter((name) => !countedNames.includes(name));
    const missing = countedNames.filter((name) => !liveNames.includes(name));
    return decline(
      'preparation_tool_set_mismatch',
      'this task registers a different model-visible tool set than the named preparation counted'
      + `${added.length === 0 ? '' : `; not counted: ${quoted(added)}`}`
      + `${missing.length === 0 ? '' : `; counted but absent: ${quoted(missing)}`}`,
    );
  }

  // Same names, so the kinds are comparable per name: a tool whose
  // implementation was attested when it was counted and is unattested now is a
  // weaker manifest than the one these tokens paid for.
  const driftedKinds = countedNames.filter(
    (name) => summary.toolImplementationKinds[name] !== live.toolImplementationKinds[name],
  );
  if (driftedKinds.length > 0) {
    return decline(
      'preparation_tool_implementation_kinds_mismatch',
      'the implementation identity behind a counted tool is not the kind it was counted with:'
      + ` ${quoted(driftedKinds)}`,
    );
  }

  // The launch directory, the toolset definition revisions, the argv and the
  // per-server identities — the facts that need no spawn, in the digest that
  // was frozen over them.
  const liveToolBindingDigest = preparedToolBindingDigest({
    launch,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    servers: [...input.servers]
      .sort((left, right) => compareNames(left.serverName, right.serverName))
      .map((entry) => ({
        serverName: entry.serverName,
        toolsetId: entry.toolsetId,
        command: entry.command,
        args: [...entry.args],
        implementation: input.implementations![entry.serverName]!,
      })),
  });
  if (liveToolBindingDigest !== summary.toolBindingDigest) {
    return decline(
      'preparation_tool_binding_digest_mismatch',
      'the launch directory, toolset definition revisions, server argv or implementation identities this task'
      + ' resolved are not the ones the named preparation bound',
    );
  }

  // Everything that took a spawn to learn: the schemas the servers published
  // and the executor fingerprints over them.
  if (live.observationDigest !== summary.observationDigest) {
    return decline(
      'preparation_observation_digest_mismatch',
      'the schemas this task observed are not the ones the named preparation counted',
    );
  }

  return Object.freeze({
    ok: true as const,
    launch: Object.freeze({
      reference: Object.freeze({
        scopeId: record.key.scopeId,
        agentRef: record.key.agentRef,
        requestId: record.key.requestId,
        recordId: record.recordId,
      }),
      artifactPath: input.artifactPath,
      expected: Object.freeze({
        envelopeDigest: summary.envelopeDigest,
        toolManifestDigest: summary.toolManifestDigest,
        // From the durable record, never from the envelope on disk: the native
        // contract is explicit that a value read out of the envelope can never
        // serve as its own expectation.
        model: record.model,
        binding: Object.freeze({
          inputIdentity: `${binding.source.revision}:${binding.source.digest}`,
          runtimeIdentity: inputPreparationRuntimeIdentityString(binding.runtime),
          policyIdentity: binding.policyRevision,
          profileRevision: binding.profileRevision,
        }),
      }),
      permissionMode: binding.permissionMode,
      toolBindingDigest: summary.toolBindingDigest,
      observationDigest: summary.observationDigest,
      launch: input.launch,
      toolImplementations: input.implementations,
      toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    }),
  });
}
