/**
 * B-P2 local primitive — public types for the task-free runtime input
 * preparation surface (`docs/researches/runtime-input-preparation-contract.md`
 * §10.3).
 *
 * This module is the ONE authority for the wire/receipt shapes the daemon's
 * `input_preparation.*` control methods speak. It deliberately imports nothing
 * from the native coding-agent package: the native envelope
 * (`PreparedSessionInputV1`) is an implementation fact owned by
 * `adapters/pi/input-preparation.ts`, and the only native-derived values that
 * ever cross this boundary are opaque digests, byte counts and the coverage
 * label. A host integrating against this surface therefore never has to
 * resolve, or pin, the native runtime's own type closure.
 *
 * What this surface is NOT, and must never quietly become:
 *
 * - It creates no task, claim, Execution, nonce or tool grant. Preparation is
 *   evidence about an input, not permission to run one (§10.3.1).
 * - A receipt reference and a digest prove CONTENT IDENTITY only. Neither is a
 *   bearer token: lookup and cancel are authorized by the same authenticated
 *   local scope that created the record, re-resolved on every call (§10.3.4).
 * - Pinning an artifact to a committed Execution is G3b. {@link
 *   InputPreparationPinV1} exists here only so that later binding is a field
 *   that was always reserved rather than a schema break; nothing in this
 *   package ever writes it.
 * - Coverage is whatever the native compiler proved, and it currently proves
 *   `"unknown"`. A receipt therefore cannot be `ready` today, and a fixture
 *   counter can never make one ready (§10.2's G4 stays closed).
 */

import { createHash } from 'node:crypto';
import type { PermissionMode } from '@byok-sdk/protocol';

// ---------------------------------------------------------------------------
// Format identifiers
// ---------------------------------------------------------------------------

/** Wire format tag for a preparation request. One strict shape, one version. */
export const INPUT_PREPARATION_REQUEST_FORMAT = 'byok.input-preparation.request';
/** Wire format tag for a preparation receipt. */
export const INPUT_PREPARATION_RECEIPT_FORMAT = 'byok.input-preparation.receipt';
/** Durable record format tag — see `daemon/input-preparation-store.ts`. */
export const INPUT_PREPARATION_RECORD_FORMAT = 'byok.input-preparation.record';
/** Durable artifact format tag — see `daemon/input-preparation-store.ts`. */
export const INPUT_PREPARATION_ARTIFACT_FORMAT = 'byok.input-preparation.artifact';
/**
 * The single supported version of every shape in this module.
 *
 * Bumped to 2 by the phase-2 executor-identity slice, which REMOVED
 * caller-supplied `toolExecutors` and `snapshot.tools` from the request and
 * added `requiredToolsets` + `permissionMode`. The request, the receipt, the
 * durable record and the retained artifact all carry this number, so a record
 * written under version 1 is refused on replay rather than read through a
 * compatibility branch: its artifact was frozen over a tool manifest a caller
 * stated, and this version's rule is that no caller may state one.
 */
export const INPUT_PREPARATION_VERSION = 2;

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Key-sorted JSON, so two structurally equal values always produce the same
 * bytes and therefore the same digest. Field ORDER must never be able to turn
 * one request into two idempotency keys, or one observed tool surface into two
 * observation digests.
 *
 * It lives beside the shapes it serializes rather than beside either of its
 * callers: `daemon/input-preparation-service.ts` digests the request with it
 * and `daemon/prepared-tool-surface.ts` digests the observed surface with it,
 * and two copies of a canonicalization are two canonicalizations.
 */
export function canonicalInputPreparationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalInputPreparationJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalInputPreparationJson(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/** sha256 hex of one canonicalized value. The one digest spelling this surface uses. */
export function inputPreparationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalInputPreparationJson(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Scope, source and selection
// ---------------------------------------------------------------------------

/**
 * The scope values a caller CLAIMS. Every one of them is validated against the
 * configured {@link InputPreparationAuthorityResolver}'s trusted local records
 * before anything is compiled, stored or counted — HMAC possession proves only
 * that the caller is a local device operator, never that it owns this device
 * row, this Agent or this profile (§10.1's P1).
 */
export interface InputPreparationScopeClaimV1 {
  readonly deviceId: string;
  readonly agentRef: string;
  readonly profileId: string;
  readonly profileRevision: string;
}

/**
 * The canonical source snapshot this input was assembled from. The SDK does not
 * interpret either value: they are Host authority, carried so the receipt binds
 * the exact revision/digest a later consumer must re-present.
 */
export interface InputPreparationSourceV1 {
  readonly revision: string;
  readonly digest: string;
}

/** The exact model identity the request is compiled for. */
export interface InputPreparationModelV1 {
  readonly id: string;
  readonly name: string;
  /** The only API this first support set compiles. Anything else rejects. */
  readonly api: 'openai-completions';
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ('text' | 'image')[];
  readonly cost: InputPreparationModelCostV1;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface InputPreparationModelCostV1 {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Body-affecting options, frozen into D. Transport options are not on this wire. */
export interface InputPreparationOptionsV1 {
  readonly cacheRetention: 'none' | 'short' | 'long';
  readonly maxTokens: number;
  readonly temperature?: number;
  /** Only the three plain string forms; an object tool choice is unsupported. */
  readonly toolChoice?: 'auto' | 'none' | 'required';
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface InputPreparationSelectionV1 {
  readonly model: InputPreparationModelV1;
  readonly options: InputPreparationOptionsV1;
}

// ---------------------------------------------------------------------------
// Authorized input snapshot
// ---------------------------------------------------------------------------

/** One authorized context file, exactly as the caller resolved it. Never read from disk here. */
export interface InputPreparationContextFileV1 {
  readonly path: string;
  readonly content: string;
}

export interface InputPreparationDocsPathsV1 {
  readonly readmePath: string;
  readonly docsPath: string;
  readonly examplesPath: string;
}

/** Explicit, already-authorized inputs for the native system prompt renderer. */
export interface InputPreparationPromptSnapshotV1 {
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly cwd: string;
  readonly selectedTools: readonly string[];
  readonly toolSnippets: Readonly<Record<string, string>>;
  readonly promptGuidelines: readonly string[];
  readonly contextFiles: readonly InputPreparationContextFileV1[];
  /** Preformatted by the caller; empty means no skills. */
  readonly formattedSkills: string;
  readonly docsPaths: InputPreparationDocsPathsV1;
}

/**
 * One model-visible user message.
 *
 * The first support set is text-only user history plus the explicit current
 * user message. Multimodal content, assistant/tool-result history and custom
 * message kinds are NOT accepted and are NOT inferred: they reject as
 * `unsupported_input` (§10.3.2 — unknown input rejects rather than filling
 * gaps). Extending the set is a registration, not a parser relaxation.
 */
export interface InputPreparationUserMessageV1 {
  readonly role: 'user';
  readonly content: string;
  readonly timestamp: number;
}

/**
 * One complete model-visible tool schema. `parameters` is the full JSON schema
 * the model sees; a partial or elided schema is not accepted, because the whole
 * point of this surface is counting what the provider will actually be sent.
 */
export interface InputPreparationToolV1 {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * The authorized input snapshot a CALLER states: prompt text and user history,
 * and nothing else.
 *
 * `tools` is deliberately absent. The model-visible tool schemas are a LOCAL
 * observation — only this device can say which MCP toolset servers it has and
 * what they publish — so they are assembled by
 * `daemon/prepared-tool-surface.ts` from the request's `requiredToolsets` and
 * joined onto this snapshot inside the daemon. A caller that could state a
 * tool schema could have tokens counted for a tool no server offers.
 */
export interface InputPreparationSnapshotV1 {
  readonly prompt: InputPreparationPromptSnapshotV1;
  readonly messages: readonly InputPreparationUserMessageV1[];
}

/**
 * What the native compiler is actually handed: the caller's snapshot plus the
 * daemon-derived tool manifest. Produced only inside the daemon, never parsed
 * off a wire.
 */
export interface InputPreparationCompiledSnapshotV1 extends InputPreparationSnapshotV1 {
  readonly tools: readonly InputPreparationToolV1[];
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * One preparation request (§10.3.1).
 *
 * `requestId` is the caller's own preparation identity and is deliberately NOT
 * a task id: it namespaces idempotency together with the AUTHENTICATED scope
 * and Agent, so a caller cannot reach another scope's record by guessing one.
 *
 * `requiredToolsets` is the ONLY thing a caller says about tools: which of
 * this device's configured MCP toolsets the preparation needs, by id. The
 * daemon resolves them against its own registry, observes the servers itself,
 * and derives both the model-visible schemas and the executor fingerprints
 * from what those servers reported. There is no `toolExecutors` field and no
 * `snapshot.tools` field, and their absence is the contract: a caller that
 * could state either could have tokens counted against a manifest this device
 * never observed.
 *
 * `permissionMode` is DECLARED, never inferred. A preparation counts one
 * concrete manifest, and the manifest is the policy-filtered set for exactly
 * one mode (`mcp/projection.ts`'s `filterMcpObservationForPolicy`). The daemon
 * validates the value and pins it onto the binding; it grants nothing.
 *
 * There is no `runtimeIdentity`, `compilerVersion` or `policyIdentity` field:
 * those are derived from the verified installed artifact closure and the
 * daemon's own configured policy, never from caller text.
 */
export interface InputPreparationRequestV1 {
  readonly format: typeof INPUT_PREPARATION_REQUEST_FORMAT;
  readonly version: typeof INPUT_PREPARATION_VERSION;
  readonly requestId: string;
  /** Must equal the daemon's configured {@link InputPreparationLimitsPolicyV1.revision} exactly. */
  readonly policyRevision: string;
  readonly scope: InputPreparationScopeClaimV1;
  readonly source: InputPreparationSourceV1;
  readonly selection: InputPreparationSelectionV1;
  /** The mode the counted manifest is filtered for. */
  readonly permissionMode: PermissionMode;
  /** Configured MCP toolset ids. The locator is the toolset id; MCP only. */
  readonly requiredToolsets: readonly string[];
  readonly snapshot: InputPreparationSnapshotV1;
}

/**
 * The request keys this contract RETIRED in version 2, named so a daemon can
 * refuse them by name instead of answering a generic shape error.
 *
 * A caller still sending either is not sending a slightly wrong request — it
 * is asserting authority over the tool manifest that this version moved to the
 * device, so it is refused as `unsupported_input` and told which key.
 */
export const INPUT_PREPARATION_RETIRED_REQUEST_KEYS = ['toolExecutors'] as const;

/** The snapshot keys retired in version 2. Same rule, one level down. */
export const INPUT_PREPARATION_RETIRED_SNAPSHOT_KEYS = ['tools'] as const;

/** Params for `input_preparation.lookup` and `input_preparation.cancel`. */
export interface InputPreparationLookupParamsV1 {
  readonly requestId: string;
  readonly scope: InputPreparationScopeClaimV1;
}

/**
 * Cancel takes no free-text reason on purpose: the durable record answers with
 * a stable code, and an accepted-but-unused field is how a caller comes to
 * believe it can annotate authority-owned state.
 */
export interface InputPreparationCancelParamsV1 {
  readonly requestId: string;
  readonly scope: InputPreparationScopeClaimV1;
}

// ---------------------------------------------------------------------------
// Limits policy — required, with no defaults
// ---------------------------------------------------------------------------

/**
 * Required byte / call / deadline / retention policy (§10.3.6 and the
 * Owner-approved limits boundary of 2026-09-14).
 *
 * Every field is REQUIRED and this package supplies no default for any of them.
 * No numeric value here is an S0 value; a fixture number in a test is a fixture
 * number. A daemon with no `inputPreparation` section keeps the whole feature
 * disabled and answers `input_preparation_unconfigured`; a daemon configured
 * with an INVALID policy fails at construction rather than starting with an
 * allowance nobody validated.
 */
export interface InputPreparationLimitsPolicyV1 {
  /** Opaque operator-assigned revision. A request must present this exact string. */
  readonly revision: string;
  /** Maximum normalized request bytes accepted from one caller. */
  readonly maxRequestBytes: number;
  /** Maximum bytes of one retained artifact (D plus P(D) plus envelope). */
  readonly maxArtifactBytes: number;
  /** Maximum retained artifact bytes summed across one authenticated scope. */
  readonly maxScopeAggregateBytes: number;
  /** Maximum preparations in flight across the daemon at one instant. */
  readonly maxInFlight: number;
  /** Maximum counter invocations one authenticated scope may consume, ever, within retention. */
  readonly maxCounterCallsPerScope: number;
  /** Bound on one counter invocation. */
  readonly counterTimeoutMs: number;
  /** Bound on one whole preparation, counter included. */
  readonly preparationDeadlineMs: number;
  /** How long a prepared artifact stays readable. */
  readonly retentionMs: number;
  /** How long the record tombstone outlives its artifact, so an expired key never reads as fresh. */
  readonly retryHorizonMs: number;
}

/** Thrown by {@link validateInputPreparationLimits} — a configuration fault, never a request fault. */
export class InputPreparationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputPreparationPolicyError';
  }
}

const POSITIVE_INTEGER_FIELDS = [
  'maxRequestBytes',
  'maxArtifactBytes',
  'maxScopeAggregateBytes',
  'maxInFlight',
  'maxCounterCallsPerScope',
  'counterTimeoutMs',
  'preparationDeadlineMs',
  'retentionMs',
  'retryHorizonMs',
] as const satisfies readonly (keyof InputPreparationLimitsPolicyV1)[];

/**
 * Validate a limits policy and return a frozen private copy.
 *
 * Fails closed on anything that is not a finite positive safe integer, on a
 * missing or empty revision, on an unknown field, and on the three relations
 * that would otherwise let one bound silently defeat another:
 *
 * - `counterTimeoutMs <= preparationDeadlineMs` — a counter bound larger than
 *   the whole preparation's bound is not a bound.
 * - `preparationDeadlineMs <= retentionMs` — an artifact that expires before
 *   its own preparation can finish is a guaranteed false negative.
 * - `maxArtifactBytes <= maxScopeAggregateBytes` — a per-artifact allowance
 *   above the per-scope total makes the aggregate unreachable.
 */
export function validateInputPreparationLimits(value: unknown): InputPreparationLimitsPolicyV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputPreparationPolicyError('DaemonConfig.inputPreparation.limits must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(['revision', ...POSITIVE_INTEGER_FIELDS]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new InputPreparationPolicyError(
        `DaemonConfig.inputPreparation.limits has unknown field ${JSON.stringify(key)}; this policy has no defaults and no optional fields`,
      );
    }
  }
  if (typeof record.revision !== 'string' || record.revision.length === 0) {
    throw new InputPreparationPolicyError('DaemonConfig.inputPreparation.limits.revision must be a non-empty string');
  }
  const numbers: Record<string, number> = {};
  for (const field of POSITIVE_INTEGER_FIELDS) {
    const raw = record[field];
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      throw new InputPreparationPolicyError(
        `DaemonConfig.inputPreparation.limits.${field} must be a positive safe integer — got ${JSON.stringify(raw)}`,
      );
    }
    numbers[field] = raw as number;
  }
  const limits: InputPreparationLimitsPolicyV1 = {
    revision: record.revision,
    maxRequestBytes: numbers.maxRequestBytes as number,
    maxArtifactBytes: numbers.maxArtifactBytes as number,
    maxScopeAggregateBytes: numbers.maxScopeAggregateBytes as number,
    maxInFlight: numbers.maxInFlight as number,
    maxCounterCallsPerScope: numbers.maxCounterCallsPerScope as number,
    counterTimeoutMs: numbers.counterTimeoutMs as number,
    preparationDeadlineMs: numbers.preparationDeadlineMs as number,
    retentionMs: numbers.retentionMs as number,
    retryHorizonMs: numbers.retryHorizonMs as number,
  };
  if (limits.counterTimeoutMs > limits.preparationDeadlineMs) {
    throw new InputPreparationPolicyError(
      'DaemonConfig.inputPreparation.limits.counterTimeoutMs must not exceed preparationDeadlineMs',
    );
  }
  if (limits.preparationDeadlineMs > limits.retentionMs) {
    throw new InputPreparationPolicyError(
      'DaemonConfig.inputPreparation.limits.preparationDeadlineMs must not exceed retentionMs',
    );
  }
  if (limits.maxArtifactBytes > limits.maxScopeAggregateBytes) {
    throw new InputPreparationPolicyError(
      'DaemonConfig.inputPreparation.limits.maxArtifactBytes must not exceed maxScopeAggregateBytes',
    );
  }
  return Object.freeze(limits);
}

// ---------------------------------------------------------------------------
// Authority resolution
// ---------------------------------------------------------------------------

/** Why a resolver refused. Never echoed back with the trusted values it compared against. */
export type InputPreparationDenialReasonV1 =
  | 'unknown_device'
  | 'unknown_agent'
  | 'unknown_profile'
  | 'profile_revision_drift'
  | 'disclosure_denied';

/** The trusted local record a resolver answers with. */
export interface InputPreparationAuthorityGrantV1 {
  /**
   * Stable identifier for the authenticated local scope this grant belongs to.
   * It is the first component of the durable idempotency namespace, so two
   * different scopes can never collide on one `requestId`.
   */
  readonly scopeId: string;
  readonly deviceId: string;
  readonly agentRef: string;
  readonly profileId: string;
  readonly profileRevision: string;
}

export type InputPreparationAuthorityOutcomeV1 =
  | { readonly authorized: true; readonly grant: InputPreparationAuthorityGrantV1 }
  | { readonly authorized: false; readonly reason: InputPreparationDenialReasonV1 };

/**
 * The configured local authority. It owns the device/Agent/Profile records this
 * daemon trusts and decides whether the claimed scope may be disclosed at all.
 *
 * A REJECTED promise means the authority is unavailable, which is a refusal —
 * never a reason to proceed on the caller's claim (§10.3.1). The service also
 * re-checks that the returned grant actually matches the claim, so a resolver
 * that answers with a different device/Agent/profile than the one asked about
 * cannot launder an identity through this seam.
 */
export interface InputPreparationAuthorityResolver {
  resolveScope(claim: InputPreparationScopeClaimV1): Promise<InputPreparationAuthorityOutcomeV1>;
}

// ---------------------------------------------------------------------------
// Counter boundary
// ---------------------------------------------------------------------------

/** The exact endpoint and model one counter call is bound to. */
export interface InputPreparationCounterTargetV1 {
  readonly endpoint: string;
  readonly modelId: string;
}

/**
 * Everything a counter adapter is given, and nothing else: the bound counted
 * projection P(D), the exact target, and an explicit call policy. No D, no
 * credentials, no scope identity, no request body, no filesystem handle.
 */
export interface InputPreparationCounterRequestV1 {
  readonly counterProjection: string;
  readonly target: InputPreparationCounterTargetV1;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Whether the counted projection covered the whole request.
 *
 * `covered: false` with a `reason` is a legitimate, useful answer — it is what
 * keeps a receipt honestly not-ready instead of admitting an Execution on a
 * partial count.
 */
export interface InputPreparationCoverageProofV1 {
  readonly covered: boolean;
  readonly reason?: string;
}

/**
 * The authority behind a count.
 *
 * `test_fixture` is a first-class value, not a debug flag: a fixture result can
 * never produce a `ready` receipt, which is what stops an offline suite from
 * ever looking like production accounting evidence (§10.3.3).
 */
export type InputPreparationCounterAuthorityV1 = 'provider' | 'test_fixture';

export interface InputPreparationCounterResultV1 {
  /** Counting method identity, e.g. the provider tokenizer route. */
  readonly method: string;
  readonly methodVersion: string;
  readonly authority: InputPreparationCounterAuthorityV1;
  /** `count` is authoritative; `bound` is a proved upper bound. Nothing else is accepted. */
  readonly kind: 'count' | 'bound';
  readonly value: number;
  readonly coverage: InputPreparationCoverageProofV1;
}

/**
 * The separately authorized counter. Exactly one method, and it performs no
 * live call in B-P2 tests.
 *
 * There is deliberately no fallback implementation anywhere in this package: no
 * `chars/4`, no heuristic padding, no reuse of a count taken from a different
 * projection. A daemon with no counter has no `inputPreparation` section and
 * the feature is off.
 */
export interface InputPreparationCounterAdapter {
  count(request: InputPreparationCounterRequestV1): Promise<InputPreparationCounterResultV1>;
}

/** Persisted counter evidence, exactly as the adapter reported it. */
export interface InputPreparationCounterEvidenceV1 extends InputPreparationCounterResultV1 {
  readonly target: InputPreparationCounterTargetV1;
  readonly calledAt: string;
  readonly completedAt: string;
}

// ---------------------------------------------------------------------------
// Artifact / receipt
// ---------------------------------------------------------------------------

/**
 * The runtime and compiler identity behind one artifact, derived from the
 * VERIFIED installed package closure — the manifest name/version actually on
 * disk plus the fork provenance it records — and never from a caller-supplied
 * label (§10.3.1).
 */
export interface InputPreparationRuntimeIdentityV1 {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly upstreamBase: string;
  readonly upstreamCommit: string;
  readonly forkBuild: number;
  /** The native envelope format tag this compiler produced. */
  readonly envelopeFormat: string;
  /** The native provider-request format tag this compiler produced. */
  readonly requestFormat: string;
  readonly compilerVersion: number;
}

/**
 * Everything a receipt discloses about the stored artifact: identities, sizes
 * and coverage. Never D itself, never P(D), never the snapshot — a scoped
 * reference plus a digest is content identity, not a disclosure channel.
 */
export interface InputPreparationArtifactSummaryV1 {
  /** Digest of the low-level provider request D. */
  readonly requestDigest: string;
  /** Digest of the whole native envelope (snapshot, context, request, manifest). */
  readonly envelopeDigest: string;
  readonly toolManifestDigest: string;
  readonly requestBytes: number;
  readonly projectionBytes: number;
  /** Whatever the native compiler proved. It currently proves `"unknown"`. */
  readonly coverage: string;
  /**
   * Digest of everything the device OBSERVED for this preparation — the
   * projected tools, their executor fingerprints, the launch attestation and
   * the implementation identities. A later consumer re-observes and compares
   * this one value rather than re-deriving a manifest.
   */
  readonly observationDigest: string;
  /**
   * Digest of the subset of those facts that can be re-derived WITHOUT
   * spawning a server: the launch attestation, the toolset definition
   * revisions, the configured argv and the implementation identities. This is
   * what a replay of an already-recorded `requestId` compares against, because
   * re-probing to detect drift would create the second executor fact the
   * idempotency key exists to prevent.
   */
  readonly toolBindingDigest: string;
  /**
   * Per model-visible tool name: `attested`, or `unavailable:<reason>`. The
   * evidence behind `executor_identity_unproven`, so a reader is not asked to
   * take that readiness reason on trust.
   */
  readonly toolImplementationKinds: Readonly<Record<string, string>>;
}

/** The immutable binding a receipt carries and a later consumer must re-present. */
export interface InputPreparationBindingV1 {
  readonly scopeId: string;
  readonly deviceId: string;
  readonly agentRef: string;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly source: InputPreparationSourceV1;
  readonly target: InputPreparationCounterTargetV1;
  readonly policyRevision: string;
  /**
   * The mode the counted manifest was filtered for, recorded so a consumer can
   * COMPARE it without re-deriving the request digest: an Execution offered
   * under a different mode registers a different tool set than the one these
   * tokens were counted for.
   */
  readonly permissionMode: PermissionMode;
  readonly runtime: InputPreparationRuntimeIdentityV1;
  /** Digest over the whole normalized request, scope and runtime identity. */
  readonly requestDigest: string;
}

/**
 * G3b placeholder. Reserved so a committed Execution can later bind
 * `(taskId, attempt, source identity)` onto an existing receipt without a
 * schema break. Nothing in this package ever writes it, and a control client
 * cannot set it: only an independently validated committed Execution may pin
 * (§10.3.7).
 */
export interface InputPreparationPinV1 {
  readonly taskId: string;
  readonly attempt: number;
  readonly sourceIdentity: string;
  readonly pinnedAt: string;
}

/**
 * Durable lifecycle state of one preparation record.
 *
 * - `reserved` — reserved durably; nothing compiled or counted yet.
 * - `counting` — artifact persisted, and a counter call was durably reserved
 *   and dispatched.
 * - `counted` — the counter answered; the receipt carries its evidence.
 * - `cancelled` — explicitly cancelled, or its deadline elapsed, with the call
 *   provably never placed. Terminal.
 * - `failed` — compilation, a policy bound or a durable write refused it.
 *   Terminal.
 * - `counter_interrupted` — the counter call started and its outcome is
 *   unknown (timeout, abort, or a thrown adapter). Terminal and OBSERVABLE: it
 *   is never automatically retried under the same request, because a repeat
 *   could be a second billed call against an outcome that may already have
 *   happened (§10.3.5).
 *
 * The last four are terminal and never transition again.
 */
export type InputPreparationStateV1 = 'reserved' | 'counting' | 'counted' | 'cancelled' | 'failed' | 'counter_interrupted';

/** Why a receipt is not ready. An empty list is the only thing that makes `ready` true. */
export type InputPreparationReadinessReasonV1 =
  | 'not_counted'
  | 'counter_interrupted'
  | 'cancelled'
  | 'failed'
  | 'artifact_expired'
  | 'counter_authority_not_production'
  | 'counter_coverage_incomplete'
  | 'compiler_coverage_unknown'
  | 'executor_identity_unproven';

/**
 * The scoped reference plus readiness evidence one preparation answers with.
 *
 * `reference` identifies the record inside the authenticated scope that created
 * it. It is not a capability: `lookup`/`cancel` re-resolve authority on every
 * call and derive the record key from the TRUSTED grant, so presenting another
 * scope's reference finds nothing.
 */
export interface InputPreparationReceiptV1 {
  readonly format: typeof INPUT_PREPARATION_RECEIPT_FORMAT;
  readonly version: typeof INPUT_PREPARATION_VERSION;
  readonly reference: string;
  readonly requestId: string;
  readonly state: InputPreparationStateV1;
  readonly binding: InputPreparationBindingV1;
  readonly artifact?: InputPreparationArtifactSummaryV1;
  readonly counter?: InputPreparationCounterEvidenceV1;
  /** True only when {@link readinessReasons} is empty. */
  readonly ready: boolean;
  readonly readinessReasons: readonly InputPreparationReadinessReasonV1[];
  /** Present on `failed`/`cancelled`/`counter_interrupted`; a stable code, not provider text. */
  readonly detail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly artifactExpiresAt: string;
  readonly recordExpiresAt: string;
  /** Always absent in B-P2. See {@link InputPreparationPinV1}. */
  readonly pin?: InputPreparationPinV1;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Every typed rejection the three control methods can answer with. Each is a
 * distinct fact; none of them ever returns a partial or synthesized result.
 *
 * - `input_preparation_unconfigured` — this daemon has no `inputPreparation`
 *   section, so the whole surface is off. Checked first, before params are
 *   parsed, so a disabled daemon reveals nothing about request shapes.
 * - `bad_request` — the params are not the one strict shape (unknown field,
 *   wrong type, wrong version/format tag).
 * - `authority_unavailable` — the configured resolver could not answer. A
 *   refusal, never a reason to trust the claim.
 * - `scope_denied` — the resolver refused the claim, or answered with a grant
 *   that does not match what was asked about.
 * - `policy_revision_mismatch` — the request's `policyRevision` is not this
 *   daemon's configured revision.
 * - `runtime_identity_unavailable` — the installed native closure could not be
 *   verified, so no artifact can carry a runtime identity.
 * - `unsupported_input` — the input is outside the declared first support set,
 *   or the native compiler refused it. Nothing is filled in.
 * - `limit_exceeded` — a configured byte / in-flight / counter-call bound.
 * - `request_conflict` — the same `(scope, Agent, requestId)` key already exists
 *   bound to a DIFFERENT normalized request digest.
 * - `not_found` — no record for this key in this scope.
 * - `counter_unavailable` — the counter adapter refused before doing work.
 * - `counter_interrupted` — the counter's outcome is unknown; the record says so
 *   and is not retried.
 * - `durable_write_failed` — a durable write was uncertain. The record is
 *   quarantined and revalidated before anything else is written.
 * - `cancelled` — the record was cancelled, or its deadline elapsed.
 *
 * These are the codes this surface OWNS, not every code its three verbs can
 * answer with. The control frame layer refuses first where it must, and the
 * shared `shutting_down` (`daemon/control-protocol.ts`) is the one that reaches
 * a well-formed, authorized call: a daemon that has begun shutting down answers
 * it before the service is consulted at all.
 */
export const INPUT_PREPARATION_ERROR_CODES = [
  'input_preparation_unconfigured',
  'bad_request',
  'authority_unavailable',
  'scope_denied',
  'policy_revision_mismatch',
  'runtime_identity_unavailable',
  'unsupported_input',
  'limit_exceeded',
  'request_conflict',
  'not_found',
  'counter_unavailable',
  'counter_interrupted',
  'durable_write_failed',
  'cancelled',
  /**
   * A required MCP toolset server could not be observed on this device. A
   * partial tool set is not a smaller preparation, it is a different one.
   */
  'toolsets_unobservable',
  /**
   * No non-writable launch directory (or no trusted launcher) could be proven
   * for this preparation's servers, so nothing was spawned. The specific
   * `TrustedLaunchCwdUnavailableReason` travels in the record's `detail`.
   */
  'launch_boundary_unavailable',
  /**
   * A repeat of an already-recorded `requestId` arrived after the facts its
   * executor fingerprints were frozen against changed. The recorded receipt is
   * not re-derived and no server is re-probed.
   */
  'observation_drift',
] as const;

export type InputPreparationErrorCodeV1 = (typeof INPUT_PREPARATION_ERROR_CODES)[number];
