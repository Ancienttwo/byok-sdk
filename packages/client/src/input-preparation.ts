/**
 * B-P2 local primitive — public types for the task-free runtime input
 * preparation surface (`docs/researches/runtime-input-preparation-contract.md`
 * §10.3).
 *
 * This module is the ONE authority for the wire/receipt shapes the daemon's
 * `input_preparation.*` control methods speak. It deliberately imports nothing
 * from the native coding-agent package: the native envelope
 * (`PreparedSessionInputV2`) is an implementation fact owned by
 * `adapters/pi/input-preparation.ts`, and the only native-derived values that
 * ever cross this boundary are opaque digests, byte counts and the native
 * compiler's own structural projection contract, copied verbatim. A host
 * integrating against this surface therefore never has to resolve, or pin, the
 * native runtime's own type closure.
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
 * - It states nothing of its own about token semantics. What P(D) covers is the
 *   native compiler's structural projection contract v2 — a {@link
 *   InputPreparationProjectionV1} and a classified {@link
 *   InputPreparationResidualKeyV1} list — copied verbatim off the envelope.
 *   Whether the residual keys are RULED is a Host accounting fact carried as
 *   {@link InputPreparationAccountingPolicyRefV1}; this package only checks
 *   applicability, never budget arithmetic.
 * - `ready` means "the preparation can be consumed": the artifact is intact and
 *   unexpired, its projection is content-complete, its residual keys are ruled
 *   by an applicable Host accounting policy, its counter evidence is present
 *   and bound to this exact projection, and every executor identity is
 *   attested. It is NOT Host budget admission, which stays on the Host side of
 *   the accounting policy this surface only names.
 */

import { createHash } from 'node:crypto';
import type { PermissionMode } from '@byok-sdk/protocol';
import type { McpLaunchAttestation } from './daemon/trusted-launch-cwd';
import type { ToolImplementationIdentityV1 } from './daemon/tool-implementation-identity';

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
 * Version 2 REMOVED caller-supplied `toolExecutors` and `snapshot.tools` from
 * the request and added `requiredToolsets` + `permissionMode`.
 *
 * Bumped to 3 by the projection-contract slice, which REMOVED the artifact
 * summary's `coverage` string — a single opaque label that said nothing
 * checkable about what P(D) covers — and replaced it with the native
 * compiler's structural projection contract v2: {@link
 * InputPreparationArtifactSummaryV1.projection} and {@link
 * InputPreparationArtifactSummaryV1.residual}. The request and binding gained
 * {@link InputPreparationAccountingPolicyRefV1}, and counter evidence gained
 * {@link InputPreparationCounterProviderEvidenceV1}.
 *
 * The request, the receipt, the durable record and the retained artifact all
 * carry this number, so a record written under an older version is refused on
 * replay rather than read through a compatibility branch: its artifact was
 * frozen under a claim this version cannot re-derive, and there is no honest
 * value to translate an opaque coverage label into.
 */
export const INPUT_PREPARATION_VERSION = 3;

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
// The native structural projection contract, carried verbatim
// ---------------------------------------------------------------------------

/**
 * What the native compiler proved about ONE top-level key of D that lies
 * outside P(D).
 *
 * These classes describe STRUCTURE and nothing else. No class states, implies
 * or denies that a key influences a provider's token count — that is an
 * external accounting fact the compiler cannot prove and never asserts, and it
 * is precisely why this SDK re-derives nothing from them and routes the
 * question to a Host-authored {@link InputPreparationAccountingPolicyRefV1}
 * instead.
 *
 * The set is the native compiler's, copied verbatim. Widening it is a
 * registration against a new fork, not a parser relaxation: a value outside
 * this set is refused rather than carried through as an unclassified key.
 */
export type InputPreparationResidualValueClassV1 =
  | 'constant'
  | 'boolean'
  | 'bounded_integer'
  | 'bounded_number'
  | 'finite_number'
  | 'closed_enum'
  | 'nonempty_string'
  | 'object_shape';

/** One residual key of D, with the only thing the native compiler proves about it: its shape. */
export interface InputPreparationResidualKeyV1 {
  readonly key: string;
  readonly valueClass: InputPreparationResidualValueClassV1;
}

/**
 * What the native compiler proves about P(D), copied verbatim off the envelope.
 *
 * `content_complete` — every context-derived byte of D is byte-identically
 * inside P(D), and every remaining top-level key of D was classified by the
 * compiler-owned table. `unknown` — D carries a key the table does not
 * classify, or a classified key whose value does not match its declared shape;
 * the compiler fails closed, claims nothing, and leaves `residual` empty.
 *
 * `digest` is SHA-256 over the exact `counterProjection` bytes. The SDK may
 * recompute it and refuse on mismatch; it never recomputes the KIND, because
 * the classification table belongs to the compiler and a second local copy of
 * it would be a shadow parser for the same semantic fact.
 */
export interface InputPreparationProjectionV1 {
  readonly version: 2;
  readonly kind: 'content_complete' | 'unknown';
  /** SHA-256 hex over the exact counted-projection bytes. */
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// Host accounting policy reference
// ---------------------------------------------------------------------------

/**
 * The Host's ruling about which residual keys its accounting already accounts
 * for, named on the request and recorded on the binding.
 *
 * It is HOST AUTHORITY, carried verbatim. This SDK performs exactly one check
 * against it — APPLICABILITY — and never any budget arithmetic:
 *
 * - every residual key the artifact carries must appear in `ruledResidualKeys`
 *   (otherwise {@link InputPreparationReadinessReasonV1} `residual_not_ruled`);
 * - `ruledRuntime` must equal this preparation's own runtime identity string,
 *   and `ruledTarget` must equal the counted target, or the ruling is about a
 *   different compiler or a different endpoint/model and does not apply here
 *   (`accounting_policy_inapplicable`).
 *
 * There is no default. A request that names none leaves the receipt carrying
 * `accounting_policy_missing`, because "nobody ruled on these keys" and "every
 * key is ruled" are different facts and only one of them is safe.
 */
export interface InputPreparationAccountingPolicyRefV1 {
  /** Opaque Host-assigned revision of the accounting ruling. Never interpreted here. */
  readonly revision: string;
  /** The runtime identity string this ruling was made for — {@link inputPreparationRuntimeIdentityString}. */
  readonly ruledRuntime: string;
  /** The endpoint/model this ruling was made for. */
  readonly ruledTarget: InputPreparationCounterTargetV1;
  /** Every residual key the Host's accounting already accounts for. */
  readonly ruledResidualKeys: readonly string[];
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

/**
 * Explicit, already-authorized inputs for the native system prompt renderer.
 *
 * `selectedTools` is deliberately NOT here. The native contract requires it to
 * equal the model-visible manifest exactly, and this version moved that
 * manifest onto the device — so a caller stating the list would be stating the
 * manifest through the prompt. The daemon fills it from the assembled surface
 * (see {@link InputPreparationCompiledPromptSnapshotV1}).
 *
 * `toolSnippets` stays caller-authored because it is prompt TEXT, but its keys
 * must name tools the assembled manifest actually contains; the native
 * compiler refuses a snippet for a tool that is not in the manifest, and
 * nothing here papers over that.
 */
export interface InputPreparationPromptSnapshotV1 {
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly cwd: string;
  readonly toolSnippets: Readonly<Record<string, string>>;
  readonly promptGuidelines: readonly string[];
  readonly contextFiles: readonly InputPreparationContextFileV1[];
  /** Preformatted by the caller; empty means no skills. */
  readonly formattedSkills: string;
  readonly docsPaths: InputPreparationDocsPathsV1;
}

/** The caller's prompt snapshot plus the tool-name list the daemon derived. */
export interface InputPreparationCompiledPromptSnapshotV1 extends InputPreparationPromptSnapshotV1 {
  /** Exactly the assembled manifest's tool names, in its canonical order. */
  readonly selectedTools: readonly string[];
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
export interface InputPreparationCompiledSnapshotV1 extends Omit<InputPreparationSnapshotV1, 'prompt'> {
  readonly prompt: InputPreparationCompiledPromptSnapshotV1;
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
  /**
   * The Host's accounting ruling for this preparation, carried verbatim onto
   * the binding. Optional on the wire and defaulted NOWHERE: a request that
   * omits it produces a receipt that says so.
   */
  readonly accountingPolicyRef?: InputPreparationAccountingPolicyRefV1;
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

/**
 * The prompt-snapshot keys retired in version 2. `selectedTools` must equal the
 * model-visible manifest exactly by native contract, so stating it is stating
 * the manifest through the prompt.
 */
export const INPUT_PREPARATION_RETIRED_PROMPT_KEYS = ['selectedTools'] as const;

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

/**
 * The exact INFERENCE target one counter call is bound to.
 *
 * `endpoint` is the inference target identity — the `selection.model.baseUrl`
 * this preparation would be executed against — and NOT the URL of the
 * counting/tokenizer HTTP call the adapter placed. The two are separate facts:
 * a counter adapter may count over a tokenizer route, a sibling host, or an
 * offline tokenizer, and this field says nothing about which. Whether the
 * counting route is equivalent to the inference route for accounting purposes
 * is UNPROVEN here and is external evidence work; the SDK asserts only that a
 * count is bound to the inference identity it was taken for.
 */
export interface InputPreparationCounterTargetV1 {
  /** The inference target identity (`selection.model.baseUrl`). Not the counting call's URL. */
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

/**
 * What the provider side of a count asserted, and which exact projection it
 * was asserted about.
 *
 * Required on every result, fixture included. A number without the identity of
 * the bytes it was taken over is not evidence: the service compares
 * `projectionDigest` against the artifact's own
 * {@link InputPreparationProjectionV1.digest} and `endpoint`/`modelId` against
 * the counted target, and a missing or mismatched one refuses the count as
 * `counter_unavailable` rather than persisting a number bound to nothing.
 *
 * `asserted` is the provider's own answer, verbatim: the HTTP status it
 * returned, the usage fields it reported, and a digest of the response those
 * came from. The SDK stores it and compares nothing inside it — re-deriving a
 * usage number locally is the shadow accounting this whole surface exists to
 * avoid.
 *
 * It carries no O (output) or W (whole-request) field, deliberately. The Host
 * holds its own request, and `binding.requestDigest` is what ties this evidence
 * to it.
 *
 * `endpoint` here is the INFERENCE target identity (`selection.model.baseUrl`)
 * the count is bound to — never the URL of the counting/tokenizer HTTP call.
 * Nothing in this SDK proves the counting route and the inference route are
 * equivalent; establishing that is external evidence work.
 *
 * `method` and `methodVersion` are recorded as SIBLINGS on
 * {@link InputPreparationCounterEvidenceV1}, deliberately NOT bound into this
 * providerEvidence object. They are co-recorded, not asserted-about: the
 * digest/target comparison covers `projectionDigest` and `endpoint`/`modelId`
 * only. Binding the counting-method identity into providerEvidence would be a
 * WIRE-SHAPE change and requires an Owner ruling, so it is not done here.
 */
export interface InputPreparationCounterProviderEvidenceV1 {
  /** SHA-256 hex of the exact counted projection this count was taken over. */
  readonly projectionDigest: string;
  /**
   * The INFERENCE target identity this count is bound to — the same
   * `selection.model.baseUrl` carried by {@link InputPreparationCounterTargetV1},
   * NOT the URL of the counting/tokenizer HTTP call that produced `asserted`.
   * The service compares it against the counted target and nothing else.
   */
  readonly endpoint: string;
  readonly modelId: string;
  readonly asserted: {
    readonly httpStatus: number;
    /** The usage fields the provider reported, verbatim. Never re-derived here. */
    readonly usageFields: Readonly<Record<string, number>>;
    /** Digest of the provider response the usage fields were read from. */
    readonly responseDigest: string;
  };
}

export interface InputPreparationCounterResultV1 {
  /** Counting method identity, e.g. the provider tokenizer route. */
  readonly method: string;
  readonly methodVersion: string;
  readonly authority: InputPreparationCounterAuthorityV1;
  /** `count` is authoritative; `bound` is a proved upper bound. Nothing else is accepted. */
  readonly kind: 'count' | 'bound';
  readonly value: number;
  readonly coverage: InputPreparationCoverageProofV1;
  /** What the provider asserted, and the projection identity it asserted it about. */
  readonly providerEvidence: InputPreparationCounterProviderEvidenceV1;
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
 * The ONE spelling of a runtime identity string.
 *
 * It binds every artifact through `CompilePreparedInputRequest.binding` and it
 * binds every tool-executor fingerprint. Those two must agree exactly, so the
 * formula lives here rather than being written out at each site — beside the
 * identity shape itself, so the prepared LAUNCH entry can re-derive the same
 * string without importing the preparation service.
 */
export function inputPreparationRuntimeIdentityString(
  runtime: InputPreparationRuntimeIdentityV1,
): string {
  return `${runtime.packageName}@${runtime.packageVersion}+${runtime.upstreamCommit}.${String(runtime.forkBuild)}`;
}

/**
 * Everything a receipt discloses about the stored artifact: identities, sizes
 * and the native compiler's structural projection contract. Never D itself,
 * never P(D), never the snapshot — a scoped reference plus a digest is content
 * identity, not a disclosure channel.
 */
export interface InputPreparationArtifactSummaryV1 {
  /** Digest of the low-level provider request D. */
  readonly requestDigest: string;
  /** Digest of the whole native envelope (snapshot, context, request, manifest). */
  readonly envelopeDigest: string;
  readonly toolManifestDigest: string;
  readonly requestBytes: number;
  readonly projectionBytes: number;
  /**
   * What the native compiler proved about P(D), copied verbatim. The SDK
   * re-derives no part of it except the digest, which it recomputes over the
   * envelope's own counted-projection bytes and refuses on mismatch.
   */
  readonly projection: InputPreparationProjectionV1;
  /**
   * Every top-level key of D outside P(D), classified by the compiler-owned
   * table and copied verbatim. Empty when {@link InputPreparationProjectionV1.kind}
   * is `unknown`, because the compiler claims nothing in that case.
   */
  readonly residual: readonly InputPreparationResidualKeyV1[];
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
  /**
   * The Host's accounting ruling this preparation was requested under, copied
   * verbatim from the request. Absent when the request named none — never
   * filled in, and never narrowed to one this device would have chosen.
   */
  readonly accountingPolicyRef?: InputPreparationAccountingPolicyRefV1;
}

/**
 * The committed Execution one counted preparation is bound to (§10.3.7).
 *
 * Written exactly once per record, by `InputPreparationStore.pin`, through a
 * compare-and-set inside the store's own serialized closure. It is the record's
 * single-consumer proof: a preparation counts ONE request, so a second runner
 * that reaches the same reference finds the pin occupied and declines with zero
 * claim and zero dispatch.
 *
 * A control client cannot set it. The only writer is the daemon's offer
 * admission, after it has sealed a manifest it already proved equal to this
 * record's binding and artifact summary — which is why `manifestDigest` is
 * here: the pin names the exact sealed Execution that consumed the record, so a
 * later reader does not have to take "some task claimed it" on trust.
 *
 * `sealedAt` is the moment the manifest was sealed, not the moment the append
 * landed: the seal is the fact being recorded.
 */
export interface InputPreparationPinV1 {
  /** The protocol task id of the Execution that consumed this preparation. */
  readonly taskId: string;
  /** `inputPreparationDigest` over the sealed `RuntimeOperationManifest`. */
  readonly manifestDigest: string;
  readonly sealedAt: string;
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

/**
 * Why a receipt is not ready. An empty list is the only thing that makes
 * `ready` true.
 *
 * `ready` answers exactly one question — CAN THIS PREPARATION BE CONSUMED —
 * and it is deliberately not Host budget admission. A ready receipt says the
 * artifact is intact, its projection is content-complete, every residual key
 * is ruled by an applicable Host accounting policy, the count is present and
 * bound to this exact projection, and every executor identity is attested. It
 * says nothing about whether the Host's budget allows the spend; that decision
 * needs the ruling this surface only names.
 *
 * - `projection_unknown` — the native compiler's projection kind is not
 *   `content_complete`, so it claims nothing about what P(D) covers.
 * - `residual_not_ruled` — the artifact carries a residual key the binding's
 *   accounting policy does not rule on.
 * - `accounting_policy_missing` — the request named no accounting policy.
 * - `accounting_policy_inapplicable` — the named policy was ruled for a
 *   different runtime or a different endpoint/model.
 * - `counter_missing` — no counter evidence is persisted on the record. Stated
 *   on its own, because it used to be implied by an always-present coverage
 *   reason and is a different fact from either.
 */
export type InputPreparationReadinessReasonV1 =
  | 'not_counted'
  | 'counter_interrupted'
  | 'cancelled'
  | 'failed'
  | 'artifact_expired'
  | 'counter_authority_not_production'
  | 'counter_coverage_incomplete'
  | 'counter_missing'
  | 'projection_unknown'
  | 'residual_not_ruled'
  | 'accounting_policy_missing'
  | 'accounting_policy_inapplicable'
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
  /** Present once a committed Execution consumed this record. See {@link InputPreparationPinV1}. */
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
  /**
   * The declared `permissionMode` exceeds this device's configured ceiling.
   * Never narrowed to an admissible mode: a preparation counts one concrete
   * manifest, and quietly counting a smaller one answers a question nobody
   * asked.
   */
  'permission_mode_denied',
] as const;

export type InputPreparationErrorCodeV1 = (typeof INPUT_PREPARATION_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Prepared tool-surface digests
// ---------------------------------------------------------------------------

/**
 * The two digests that bind one prepared tool surface, written ONCE here.
 *
 * `daemon/prepared-tool-surface.ts` computes them while it assembles a
 * preparation, and `adapters/pi/prepared-tools.ts` recomputes them at launch
 * to decide whether the device still matches the artifact it is about to send.
 * Two copies of either formula would make "the launch matches the preparation"
 * an agreement between two serializers rather than a property of one.
 *
 * They live beside {@link inputPreparationDigest} rather than in the daemon
 * module, so the in-process prepared launch entry can reach them without
 * pulling the registry, the probe and the policy resolver into a subprocess
 * that uses none of them.
 */

/** One projected server, reduced to exactly what a binding digest commits to. */
export interface PreparedToolBindingServerDigestInputV1 {
  readonly serverName: string;
  readonly toolsetId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly implementation: ToolImplementationIdentityV1;
}

export interface PreparedToolBindingDigestInputV1 {
  readonly launch: McpLaunchAttestation;
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  /** Canonically ordered by server name; the canonical JSON preserves array order. */
  readonly servers: readonly PreparedToolBindingServerDigestInputV1[];
}

/**
 * The spawn-free half: the launch attestation, the definition revisions, the
 * configured argv and the implementation identities.
 */
export function preparedToolBindingDigest(input: PreparedToolBindingDigestInputV1): string {
  return inputPreparationDigest({
    v: 1,
    launch: { launchCwd: input.launch.launchCwd, launcher: input.launch.launcher },
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    servers: input.servers.map((entry) => ({
      serverName: entry.serverName,
      toolsetId: entry.toolsetId,
      command: entry.command,
      args: [...entry.args],
      implementation: entry.implementation,
    })),
  });
}

/**
 * The Pi-native half of a prepared Main tool set, bound to the ADMITTED policy
 * that selected it — not merely to the mode.
 *
 * `allowTools`/`denyTools` are what actually decide which built-ins a task gets
 * (`adapters/pi/permission-mapping.ts`), so a digest that bound only `mode`
 * would validate a launch whose native half is a different set from the one
 * that was counted.
 *
 * Absent while the native half is not countable: `daemon/prepared-tool-surface.ts`
 * assembles a preparation with no native tools at all, so there is no selection
 * to bind and the key is omitted rather than written as an empty one.
 */
export interface PreparedNativeToolSelectionV1 {
  /** Model-visible native tool names, in registration order. Never empty. */
  readonly names: readonly string[];
  /** The admitted policy that produced `names`, whole. */
  readonly policy: {
    readonly mode: PermissionMode;
    readonly allowTools?: readonly string[];
    readonly denyTools?: readonly string[];
  };
}

export interface PreparedToolSurfaceDigestInputV1 {
  readonly launch: McpLaunchAttestation;
  readonly permissionMode: PermissionMode;
  readonly runtimeIdentity: string;
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  readonly tools: readonly InputPreparationToolV1[];
  readonly toolExecutors: Readonly<Record<string, string>>;
  readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
  /** Omitted while the prepared native half stays empty; see the type above. */
  readonly nativeSelection?: PreparedNativeToolSelectionV1;
}

/** The whole observed surface: the schemas, the executors, the launch and the identities. */
export function preparedToolSurfaceObservationDigest(input: PreparedToolSurfaceDigestInputV1): string {
  return inputPreparationDigest({
    v: 1,
    launch: { launchCwd: input.launch.launchCwd, launcher: input.launch.launcher },
    permissionMode: input.permissionMode,
    runtimeIdentity: input.runtimeIdentity,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersDigest: inputPreparationDigest(tool.parameters),
    })),
    toolExecutors: input.toolExecutors,
    implementations: input.implementations,
    // `canonicalInputPreparationJson` drops an `undefined` value, so a surface
    // with no native half digests to exactly the bytes it did before this key
    // existed.
    nativeSelection: input.nativeSelection === undefined
      ? undefined
      : {
        names: [...input.nativeSelection.names],
        policy: {
          mode: input.nativeSelection.policy.mode,
          allowTools: input.nativeSelection.policy.allowTools === undefined
            ? undefined
            : [...input.nativeSelection.policy.allowTools],
          denyTools: input.nativeSelection.policy.denyTools === undefined
            ? undefined
            : [...input.nativeSelection.policy.denyTools],
        },
      },
  });
}
