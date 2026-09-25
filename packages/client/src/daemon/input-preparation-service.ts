import {
  canonicalInputPreparationJson,
  inputPreparationDigest,
  inputPreparationRuntimeIdentityString,
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_RECEIPT_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationAuthorityGrantV1,
  type InputPreparationAuthorityResolver,
  type InputPreparationBindingV1,
  type InputPreparationCancelParamsV1,
  type InputPreparationCounterAdapter,
  type InputPreparationCounterEvidenceV1,
  type InputPreparationCounterProviderEvidenceV1,
  type InputPreparationCounterResultV1,
  type InputPreparationCounterTargetV1,
  type InputPreparationErrorCodeV1,
  type InputPreparationLimitsPolicyV1,
  type InputPreparationLookupParamsV1,
  type InputPreparationReadinessReasonV1,
  type InputPreparationReceiptV1,
  type InputPreparationRequestV1,
  type InputPreparationRuntimeIdentityV1,
  type InputPreparationScopeClaimV1,
} from '../input-preparation';
import {
  InputPreparationCompileError,
  InputPreparationRuntimeIdentityError,
  preparedRequestContentIsTextOnly,
  SUPPORTED_PREPARED_COMPILER_VERSION,
  type InputPreparationCompiler,
} from '../adapters/pi/input-preparation';
import {
  buildPreparedPromptCommand,
  PREPARED_PROMPT_COMMAND_ID,
} from '../adapters/pi/prepared-prompt-frame';
// The SDK owns the single-frame bound: official Pi 0.87.1 reads stdin without
// one, so this send-side check is the only thing that keeps an oversized frame
// off the peer. `util/rpc-frame.ts` is the one authority for the cap and the
// length function.
import { fitsRpcFrame, rpcFrameByteLength, RPC_MAX_FRAME_BYTES } from '../util/rpc-frame';
import type {
  PreparedToolSurface,
  PreparedToolSurfaceAssembler,
  PreparedToolSurfaceRefusal,
} from './prepared-tool-surface';
import {
  InputPreparationConflictError,
  InputPreparationDurabilityError,
  InputPreparationLimitError,
  InputPreparationStore,
  inputPreparationRecordId,
  isTerminalInputPreparationState,
  type InputPreparationRecord,
  type InputPreparationRecordKey,
} from './input-preparation-store';

/**
 * B-P2 local primitive — binding, authority resolution and orchestration
 * (`docs/researches/runtime-input-preparation-contract.md` §10.3).
 *
 * The one thing this file is FOR: turning an authenticated local control call
 * into an immutable prepared-input artifact plus a durable receipt, with no
 * task, claim, Execution, nonce or tool grant created anywhere along the way.
 * It holds no reference to `TaskRunner`, the connection or the journal, which
 * is why "no Execution is created" is a structural fact here rather than a
 * behavior a test has to chase.
 *
 * The fixed order of a `prepare`, and why each step is where it is:
 *
 *  1. The caller's params are COPIED before the first `await`. Everything after
 *     that reads the copy, so a caller that keeps mutating its own object
 *     cannot change what is compiled, digested or retained (§10.3.2).
 *  2. Policy revision, then request bytes. Both are cheap refusals that must
 *     happen before any authority lookup does work on a request this daemon
 *     was never going to accept.
 *  3. Authority. The configured resolver checks the claimed device / Agent /
 *     profile against its trusted local records; an unavailable authority is a
 *     refusal, and a grant that does not match the claim is a refusal too — a
 *     resolver cannot launder an identity through this seam (§10.3.1).
 *  4. The normalized request digest binds the whole request together with the
 *     TRUSTED scope and the runtime identity derived from the verified
 *     installed closure. Caller text contributes nothing to that identity.
 *  5. Durable reserve, before any counter is ever invoked. Same key and digest
 *     returns the existing fact; a different digest conflicts (§10.3.5).
 *  6. The ONE prepared-tool-surface assembly (`./prepared-tool-surface.ts`) —
 *     launch boundary, implementation identities, probe, policy filter,
 *     projection, fingerprints — deliberately AFTER the reserve, so a
 *     re-delivery of an already-recorded requestId answers from the durable
 *     record without starting a single server.
 *  7. Pure compile, then ONE serialized closure that admits the artifact
 *     against the per-scope bounds and retains it. With no counter configured
 *     that closure settles the record as `prepared` and nothing else happens:
 *     no counter call, no counter-call reservation. With a counter configured
 *     the same closure also durably reserves the counter call, then the
 *     counter runs, then the durably persisted result — in that order, so no
 *     success is ever reported that is not already on disk, and no bound is
 *     ever decided on a value another request can invalidate before the write
 *     lands (§10.3.5, §10.3.7, §10.3.8).
 */

// ---------------------------------------------------------------------------
// Typed rejection
// ---------------------------------------------------------------------------

/** Every refusal this service produces. `create-daemon.ts` maps `code` straight onto the wire. */
export class InputPreparationRequestError extends Error {
  constructor(
    readonly code: InputPreparationErrorCodeV1,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'InputPreparationRequestError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InputPreparationServiceOptions {
  readonly storeDir: string;
  readonly limits: InputPreparationLimitsPolicyV1;
  readonly authorityResolver: InputPreparationAuthorityResolver;
  /**
   * The OPTIONAL counter. Absent, a preparation compiles, persists and settles
   * as `prepared` with no counter call and no counter-call reservation; the
   * size evidence is the artifact's own `requestBytes`. Present, it is called
   * exactly once per preparation and its evidence must be provider-
   * authoritative and covered for the receipt to be ready.
   */
  readonly counter?: InputPreparationCounterAdapter;
  readonly compiler: InputPreparationCompiler;
  /**
   * The ONE prepared-tool-surface entry (`./prepared-tool-surface.ts`).
   *
   * Required, with no default: a service constructed without one could not
   * derive a tool manifest at all, and the only alternative to deriving one is
   * accepting a caller's — which is precisely what this version of the request
   * contract removed. Injected rather than constructed here so this module
   * still names no registry, no launch configuration and no MCP probe.
   */
  readonly toolSurface: PreparedToolSurfaceAssembler;
  readonly now?: () => number;
}

/**
 * Per-call bounds a caller may TIGHTEN, never loosen.
 *
 * The remote lane (`input-preparation-remote.ts`) carries a Host-stated
 * `deadlineAt`. It is applied here as `min(requested, configured)` so a
 * generous Host deadline can never enlarge this daemon's configured
 * `preparationDeadlineMs` — the local policy stays the ceiling, and the caller
 * only ever gets less time than it asked for.
 */
export interface InputPreparationCallOptions {
  readonly deadlineMs?: number;
}

export interface InputPreparationService {
  /** Replay, confirm and reconcile the durable log. Must complete before any method answers. */
  open(): Promise<void>;
  prepare(request: InputPreparationRequestV1, options?: InputPreparationCallOptions): Promise<InputPreparationReceiptV1>;
  lookup(params: InputPreparationLookupParamsV1): Promise<InputPreparationReceiptV1>;
  cancel(params: InputPreparationCancelParamsV1): Promise<InputPreparationReceiptV1>;
  /** Aborts every owned counter call. Outcomes stay observable in the durable record. */
  stop(): Promise<void>;
  /**
   * The runtime/compiler identity this service binds every artifact to,
   * derived from the VERIFIED installed closure. Exposed because a caller that
   * builds `toolExecutors` must fingerprint against the SAME identity the
   * compiler will bind, and re-deriving it from its own copy of the compiler
   * is how those two silently drift apart.
   */
  readonly runtime: InputPreparationRuntimeIdentityV1;
  /** Internal test seam: the durable store behind this service. */
  readonly store: InputPreparationStore;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Why this record is not ready to be CONSUMED.
 *
 * An empty list is the only thing that makes `ready` true. `ready` answers
 * exactly one question — can this preparation be consumed — and it is
 * deliberately NOT Host budget admission: the Host decides the spend against
 * the accounting ruling this service only NAMES, and nothing here performs
 * budget arithmetic.
 *
 * Every reason is read off recorded evidence rather than asserted:
 *
 * - `projection_unknown` — the native compiler's own projection kind is not
 *   `content_complete`. The SDK never re-derives that kind: the compiler owns
 *   the classification table, and a second local copy of it would be a shadow
 *   parser for the same semantic fact.
 * - `accounting_policy_missing` / `accounting_policy_inapplicable` /
 *   `residual_not_ruled` — pure APPLICABILITY of the Host's accounting ruling.
 *   Was one named at all; was it ruled for this runtime and this
 *   endpoint/model; does it name every residual key the compiler classified.
 *   There is no default ruling, so a request that named none stays unready
 *   rather than being silently treated as ruled.
 * - `request_content_not_text` — D carries a content part whose `type` is not
 *   `text`, read off the record's `requestContentTextOnly`, which was decided
 *   once over D's own bytes when the artifact was retained.
 * - `executor_identity_unproven` — derived from the recorded per-tool
 *   implementation kinds: a manifest is only as proven as its least proven
 *   entry. On this SDK's default — no configured `toolImplementationAuthority`
 *   — every kind is `unavailable:resolver_unconfigured`.
 * - `counter_authority_not_production` / `counter_coverage_incomplete` — a
 *   counter is OPTIONAL, and neither reason exists without one. When one IS on
 *   the record, a fixture count can never make a receipt ready (so an offline
 *   suite cannot look like production accounting evidence), and an uncovered
 *   count cannot either.
 * - `runtime_contract_superseded` — the record's binding declares a
 *   prepared-compiler version this build does not prepare or consume against.
 *   Fail closed with no forward read: the artifact's residual classification
 *   came from another compiler's table and its snapshot from another renderer.
 */
export function inputPreparationReadinessReasons(
  record: InputPreparationRecord,
  nowMs: number,
): InputPreparationReadinessReasonV1[] {
  const reasons: InputPreparationReadinessReasonV1[] = [];
  switch (record.state) {
    case 'reserved':
    case 'counting':
      reasons.push('not_prepared');
      break;
    case 'cancelled':
      reasons.push('cancelled');
      break;
    case 'failed':
      reasons.push('failed');
      break;
    case 'counter_interrupted':
      reasons.push('counter_interrupted');
      break;
    case 'prepared':
      break;
  }
  // The runtime-contract check, made here about a RECORD rather than about a
  // fresh compile. `binding.runtime.compilerVersion` is the prepared-compiler
  // contract the record was frozen under, observed from the verified install at
  // preparation time; this build prepares and consumes exactly one. A record
  // carrying any other one is not re-read through the current contract and is
  // not translated — its projection was classified by a table this build does
  // not have and its snapshot was rendered by a renderer this build no longer
  // ships — so it stays unready, by name.
  if (record.binding.runtime.compilerVersion !== SUPPORTED_PREPARED_COMPILER_VERSION) {
    reasons.push('runtime_contract_superseded');
  }
  if (record.artifact === undefined) {
    if (!reasons.includes('not_prepared')) reasons.push('not_prepared');
  } else {
    if (record.artifact.projection.kind !== 'content_complete') reasons.push('projection_unknown');
    // Text-only D is the first release's support set. `!== true` rather than
    // `=== false`: a record holding an artifact without the fact is a record
    // nobody vouched for, and it stays unready.
    if (record.requestContentTextOnly !== true) reasons.push('request_content_not_text');
    // Applicability of the Host's accounting ruling, and nothing else. The SDK
    // compares names and identities; it never decides what a residual key COSTS,
    // because the compiler proved only the key's SHAPE and the price of a shape
    // is an external accounting fact no local rule can re-derive.
    const policy = record.binding.accountingPolicyRef;
    if (policy === undefined) {
      reasons.push('accounting_policy_missing');
    } else if (
      policy.ruledRuntime !== inputPreparationRuntimeIdentityString(record.binding.runtime) ||
      policy.ruledTarget.endpoint !== record.binding.target.endpoint ||
      policy.ruledTarget.modelId !== record.binding.target.modelId
    ) {
      reasons.push('accounting_policy_inapplicable');
    } else {
      const ruled = new Set(policy.ruledResidualKeys);
      if (record.artifact.residual.some((entry) => !ruled.has(entry.key))) reasons.push('residual_not_ruled');
    }
    // A tool executor string is an OBSERVATION fingerprint. It binds what a
    // server said about a tool AND the implementation identity this daemon
    // resolved for that server — so whether it proves anything about the
    // executable depends entirely on whether that identity was attested.
    //
    // The receipt therefore reads the recorded kinds rather than asserting the
    // limitation unconditionally: any tool whose implementation is
    // `unavailable` keeps the whole preparation unready, because a manifest is
    // only as proven as its least proven entry. On this SDK's default — no
    // configured `toolImplementationAuthority` — every kind is
    // `unavailable:resolver_unconfigured` and the reason is always present,
    // which is the same honest answer as before; what changed is that it is
    // now derived from evidence instead of hard-coded.
    if (Object.values(record.artifact.toolImplementationKinds).some((kind) => kind !== 'attested')) {
      reasons.push('executor_identity_unproven');
    }
    if (record.artifactBytes === 0 || nowMs >= Date.parse(record.artifactExpiresAt)) reasons.push('artifact_expired');
  }
  // The counter is optional. Its absence is not a reason; its presence is
  // judged, so a fixture or uncovered count can never ride along into ready.
  if (record.counter !== undefined) {
    if (record.counter.authority !== 'provider') reasons.push('counter_authority_not_production');
    if (!record.counter.coverage.covered) reasons.push('counter_coverage_incomplete');
  }
  return reasons;
}

function toReceipt(record: InputPreparationRecord, nowMs: number): InputPreparationReceiptV1 {
  const readinessReasons = inputPreparationReadinessReasons(record, nowMs);
  return {
    format: INPUT_PREPARATION_RECEIPT_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    reference: record.recordId,
    requestId: record.key.requestId,
    state: record.state,
    binding: record.binding,
    ...(record.artifact === undefined ? {} : { artifact: record.artifact }),
    ...(record.counter === undefined ? {} : { counter: record.counter }),
    ready: readinessReasons.length === 0,
    readinessReasons,
    ...(record.detail === undefined ? {} : { detail: record.detail }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    artifactExpiresAt: record.artifactExpiresAt,
    recordExpiresAt: record.recordExpiresAt,
    ...(record.pin === undefined ? {} : { pin: record.pin }),
  };
}

// ---------------------------------------------------------------------------
// Counter result validation
// ---------------------------------------------------------------------------

/**
 * A counter adapter is configured, not trusted blindly: a malformed result is a
 * refusal, never a number this service invents a shape for.
 */
function validateCounterResult(value: unknown): InputPreparationCounterResultV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputPreparationRequestError('counter_unavailable', 'the counter adapter returned a non-object result');
  }
  const result = value as Record<string, unknown>;
  const coverage = result.coverage as Record<string, unknown> | undefined;
  if (
    typeof result.method !== 'string' ||
    result.method.length === 0 ||
    typeof result.methodVersion !== 'string' ||
    result.methodVersion.length === 0 ||
    (result.authority !== 'provider' && result.authority !== 'test_fixture') ||
    !Number.isSafeInteger(result.value) ||
    (result.value as number) < 0 ||
    typeof coverage !== 'object' ||
    coverage === null ||
    typeof coverage.covered !== 'boolean' ||
    (coverage.reason !== undefined && typeof coverage.reason !== 'string')
  ) {
    throw new InputPreparationRequestError('counter_unavailable', 'the counter adapter returned a result outside the accepted shape');
  }
  return {
    method: result.method,
    methodVersion: result.methodVersion,
    authority: result.authority,
    value: result.value as number,
    coverage: {
      covered: coverage.covered,
      ...(coverage.reason === undefined ? {} : { reason: coverage.reason as string }),
    },
    providerEvidence: validateProviderEvidence(result.providerEvidence),
  };
}

/**
 * The provider half of a count, validated as a SHAPE only.
 *
 * Nothing inside `asserted` is recomputed or second-guessed here: it is what
 * the provider answered, and re-deriving a usage number locally would be the
 * shadow accounting this whole surface exists to avoid. What IS checked, and
 * checked elsewhere against the artifact, is the identity of the bytes the
 * count was taken over — a number whose projection nobody can name is not
 * evidence about this preparation.
 */
function validateProviderEvidence(value: unknown): InputPreparationCounterProviderEvidenceV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputPreparationRequestError('counter_unavailable', 'the counter adapter returned no provider evidence');
  }
  const evidence = value as Record<string, unknown>;
  const asserted = evidence.asserted as Record<string, unknown> | undefined;
  if (
    typeof evidence.projectionDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(evidence.projectionDigest) ||
    typeof evidence.endpoint !== 'string' ||
    evidence.endpoint.length === 0 ||
    typeof evidence.modelId !== 'string' ||
    evidence.modelId.length === 0 ||
    typeof asserted !== 'object' ||
    asserted === null ||
    Array.isArray(asserted) ||
    !Number.isSafeInteger(asserted.httpStatus) ||
    typeof asserted.responseDigest !== 'string' ||
    asserted.responseDigest.length === 0 ||
    typeof asserted.usageFields !== 'object' ||
    asserted.usageFields === null ||
    Array.isArray(asserted.usageFields) ||
    !Object.values(asserted.usageFields as Record<string, unknown>).every(
      (field) => typeof field === 'number' && Number.isFinite(field),
    )
  ) {
    throw new InputPreparationRequestError(
      'counter_unavailable',
      'the counter adapter returned provider evidence outside the accepted shape',
    );
  }
  return {
    projectionDigest: evidence.projectionDigest,
    endpoint: evidence.endpoint,
    modelId: evidence.modelId,
    asserted: {
      httpStatus: asserted.httpStatus as number,
      usageFields: { ...(asserted.usageFields as Record<string, number>) },
      responseDigest: asserted.responseDigest,
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface ActiveRun {
  readonly controller: AbortController;
  /** Assigned synchronously right after the run starts, before it can yield. */
  done: Promise<void>;
  cancelRequested: boolean;
}

export function createInputPreparationService(options: InputPreparationServiceOptions): InputPreparationService {
  const now = options.now ?? Date.now;
  const limits = options.limits;
  const store = new InputPreparationStore({
    storeDir: options.storeDir,
    retentionMs: limits.retentionMs,
    retryHorizonMs: limits.retryHorizonMs,
    now,
  });
  const active = new Map<string, ActiveRun>();
  /** Per-record serialization, so two concurrent duplicates cannot both compile or both count. */
  const locks = new Map<string, Promise<unknown>>();
  let opened: Promise<void> | undefined;
  let stopped = false;
  let gcTimer: ReturnType<typeof setTimeout> | undefined;
  let gcInFlight: Promise<void> | undefined;
  let gcFailure: { cause: unknown } | undefined;

  function assertAvailable(): void {
    if (gcFailure) rethrowDurable(gcFailure.cause);
    if (stopped) throw new InputPreparationRequestError('cancelled', 'the input-preparation service is stopped');
  }

  // One timer for the earliest retained expiry. Active records are protected
  // until their owning run settles and rearms this timer; an overdue compile
  // must not cause a zero-delay GC loop. An empty or wholly pinned store sleeps.
  function scheduleGc(): void {
    if (gcTimer !== undefined) clearTimeout(gcTimer);
    gcTimer = undefined;
    if (stopped || gcFailure || gcInFlight !== undefined) return;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const record of store.list()) {
      if (record.pin !== undefined || !isTerminalInputPreparationState(record.state)) continue;
      nextExpiry = Math.min(nextExpiry, Date.parse(record.recordExpiresAt));
      if (record.artifactBytes > 0) nextExpiry = Math.min(nextExpiry, Date.parse(record.artifactExpiresAt));
    }
    if (!Number.isFinite(nextExpiry)) return;
    gcTimer = setTimeout(() => {
      gcTimer = undefined;
      gcInFlight = store.gc(now(), true).then(
        () => undefined,
        (cause: unknown) => { gcFailure = { cause }; },
      ).finally(() => {
        gcInFlight = undefined;
        scheduleGc();
      });
    }, Math.min(Math.max(1, nextExpiry - now()), 2_147_483_647));
    gcTimer.unref?.();
  }

  function withRecordLock<T>(recordId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(recordId) ?? Promise.resolve();
    const next = previous.then(work, work);
    locks.set(
      recordId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Mark a preparation failed, and let a durable fault out.
   *
   * The refusal that led here is a fact about the request; whether it was
   * RECORDED is a fact about this daemon's storage, and §10.3.8 says an
   * uncertain durable write is never masked by the error that occasioned it. So
   * a failed failure-marking replaces the refusal with `durable_write_failed`:
   * the caller is told the record log is quarantined, which is the more
   * dangerous of the two truths and the one that governs what may be retried.
   */
  async function markFailed(recordId: string, detail: string): Promise<void> {
    try {
      await store.update(recordId, { state: 'failed', detail });
    } catch (cause) {
      rethrowDurable(cause);
    }
  }

  function rethrowDurable(error: unknown): never {
    if (error instanceof InputPreparationDurabilityError) {
      throw new InputPreparationRequestError(
        'durable_write_failed',
        'a durable write for this preparation was uncertain; the record log must be revalidated before it is used again',
        { cause: error },
      );
    }
    throw error;
  }

  /**
   * Reconcile what a crash left behind.
   *
   * A non-terminal record on disk means this daemon stopped between two durable
   * writes. Neither survivor may be silently resumed:
   *
   * - `counting` — the counter call was already reserved and may have reached
   *   the provider. Its outcome is unknown, so it becomes `counter_interrupted`
   *   and is never automatically repeated (§10.3.5). The consumed call stays
   *   charged against the scope's allowance.
   * - `reserved` — nothing was counted, but the key is spent. It becomes
   *   `failed`, so continuing requires a caller decision and a new requestId,
   *   which is exactly what §10.3.5 asks for.
   */
  async function reconcile(): Promise<void> {
    for (const record of store.list()) {
      if (isTerminalInputPreparationState(record.state)) continue;
      if (record.state === 'counting') {
        await store.update(record.recordId, {
          state: 'counter_interrupted',
          detail: 'counter_outcome_unknown_after_restart',
        });
        continue;
      }
      await store.update(record.recordId, { state: 'failed', detail: 'interrupted_before_counter' });
    }
  }

  async function ensureOpen(): Promise<void> {
    opened ??= (async (): Promise<void> => {
      await store.open();
      await reconcile();
      await store.gc(now(), true);
      scheduleGc();
    })();
    await opened;
    assertAvailable();
  }

  /**
   * Resolve the claimed scope against the configured local authority.
   *
   * Three distinct refusals, none of which is a degradation: the resolver threw
   * (authority unavailable), the resolver said no, or the resolver answered
   * about a different subject than the one asked about.
   */
  async function resolveAuthority(claim: InputPreparationScopeClaimV1): Promise<InputPreparationAuthorityGrantV1> {
    let outcome;
    try {
      outcome = await options.authorityResolver.resolveScope({
        deviceId: claim.deviceId,
        agentRef: claim.agentRef,
        profileId: claim.profileId,
        profileRevision: claim.profileRevision,
      });
    } catch (cause) {
      throw new InputPreparationRequestError(
        'authority_unavailable',
        'the configured input-preparation authority could not be consulted',
        { cause },
      );
    }
    if (outcome === undefined || outcome === null || typeof outcome !== 'object' || !('authorized' in outcome)) {
      throw new InputPreparationRequestError('authority_unavailable', 'the configured authority returned no decision');
    }
    if (!outcome.authorized) {
      throw new InputPreparationRequestError('scope_denied', 'the claimed scope is not authorized on this device');
    }
    const grant = outcome.grant;
    if (
      typeof grant !== 'object' ||
      grant === null ||
      typeof grant.scopeId !== 'string' ||
      grant.scopeId.length === 0 ||
      grant.deviceId !== claim.deviceId ||
      grant.agentRef !== claim.agentRef ||
      grant.profileId !== claim.profileId ||
      grant.profileRevision !== claim.profileRevision
    ) {
      // A grant that does not answer the question that was asked is not an
      // authorization. Refusing here is what stops a misbehaving or forged
      // resolver from substituting an identity the caller never claimed.
      throw new InputPreparationRequestError('scope_denied', 'the configured authority returned a grant that does not match the claimed scope');
    }
    return {
      scopeId: grant.scopeId,
      deviceId: grant.deviceId,
      agentRef: grant.agentRef,
      profileId: grant.profileId,
      profileRevision: grant.profileRevision,
    };
  }

  async function resolveSourceAuthority(
    request: InputPreparationRequestV1,
    grant: InputPreparationAuthorityGrantV1,
  ): Promise<InputPreparationRequestV1['source']> {
    let outcome;
    try {
      // Resolver-owned mutable data must never alias the later compile input.
      outcome = await options.authorityResolver.resolveSource(structuredClone({
        grant, source: request.source, snapshot: request.snapshot,
      }));
      // Take ownership before validating; a retained resolver object cannot
      // replace the pair between verification and binding.
      outcome = structuredClone(outcome);
      if (outcome === null || typeof outcome !== 'object' ||
          (outcome.authorized !== true && outcome.authorized !== false)) {
        throw new Error('source authority returned no valid decision');
      }
      if (outcome.authorized === true && (outcome.source === null || typeof outcome.source !== 'object' ||
          typeof outcome.source.revision !== 'string' || outcome.source.revision.length === 0 ||
          typeof outcome.source.digest !== 'string' || outcome.source.digest.length === 0)) {
        throw new Error('source authority returned no valid source pair');
      }
    } catch (cause) {
      throw new InputPreparationRequestError('authority_unavailable', 'the configured source authority could not be consulted', { cause });
    }
    if (!outcome.authorized || outcome.source.revision !== request.source.revision || outcome.source.digest !== request.source.digest) {
      throw new InputPreparationRequestError('scope_denied', 'the source snapshot is not authorized in the verified scope');
    }
    return { revision: outcome.source.revision, digest: outcome.source.digest };
  }

  function buildBinding(
    request: InputPreparationRequestV1,
    grant: InputPreparationAuthorityGrantV1,
    target: InputPreparationCounterTargetV1,
    requestDigest: string,
  ): InputPreparationBindingV1 {
    return {
      scopeId: grant.scopeId,
      deviceId: grant.deviceId,
      agentRef: grant.agentRef,
      profileId: grant.profileId,
      profileRevision: grant.profileRevision,
      source: { revision: request.source.revision, digest: request.source.digest },
      target,
      policyRevision: limits.revision,
      permissionMode: request.permissionMode,
      runtime: options.compiler.runtime,
      requestDigest,
      // Host authority, carried verbatim. Never defaulted: a preparation whose
      // request named no accounting ruling answers with a receipt that says so.
      ...(request.accountingPolicyRef === undefined
        ? {}
        : {
          accountingPolicyRef: {
            revision: request.accountingPolicyRef.revision,
            ruledRuntime: request.accountingPolicyRef.ruledRuntime,
            ruledTarget: { ...request.accountingPolicyRef.ruledTarget },
            ruledResidualKeys: [...request.accountingPolicyRef.ruledResidualKeys],
          },
        }),
    };
  }

  /**
   * Turn one assembly refusal into the typed rejection the wire carries, and
   * record WHY on the durable record before it leaves.
   *
   * The refusal detail is a stable code, so a later `lookup` answers the same
   * fact the original call did rather than only "failed".
   */
  async function refuseAssembly(
    recordId: string,
    refusal: PreparedToolSurfaceRefusal,
  ): Promise<never> {
    await markFailed(recordId, refusal.detail);
    throw new InputPreparationRequestError(refusal.code, refusal.message);
  }

  async function runPreparation(
    record: InputPreparationRecord,
    request: InputPreparationRequestV1,
    grant: InputPreparationAuthorityGrantV1,
    target: InputPreparationCounterTargetV1,
    run: ActiveRun,
  ): Promise<InputPreparationRecord> {
    // --- observation stage ------------------------------------------------
    // The one entry that resolves the launch boundary, resolves an
    // implementation identity per server, probes through both, and returns the
    // frozen tool surface. It runs AFTER the durable reserve above, which is
    // what makes a re-delivery return the recorded fact without a second
    // spawn: no server is started until this key is provably new.
    let surface: PreparedToolSurface;
    {
      const assembled = await options.toolSurface.assemble({
        requiredToolsets: request.requiredToolsets,
        permissionMode: request.permissionMode,
        runtimeIdentity: inputPreparationRuntimeIdentityString(options.compiler.runtime),
      });
      if (!assembled.ok) await refuseAssembly(record.recordId, assembled);
      surface = (assembled as { readonly surface: PreparedToolSurface }).surface;
    }

    // --- pure stage -------------------------------------------------------
    // No filesystem, environment, session, process, tool or network access
    // happens inside this call; the runtime identity it is bound to was read
    // once at compiler construction.
    let compiled;
    try {
      compiled = await options.compiler.compile({
        snapshot: {
          prompt: { systemPrompt: request.snapshot.prompt.systemPrompt },
          messages: request.snapshot.messages,
          // Daemon-derived, never caller-stated. The tools the model is shown
          // and the executors the manifest binds come from the same assembly.
          tools: surface.tools,
        },
        model: request.selection.model,
        options: request.selection.options,
        binding: {
          inputIdentity: `${request.source.revision}:${request.source.digest}`,
          runtimeIdentity: inputPreparationRuntimeIdentityString(options.compiler.runtime),
          policyIdentity: limits.revision,
          profileRevision: grant.profileRevision,
        },
        toolExecutors: surface.toolExecutors,
      });
    } catch (cause) {
      if (cause instanceof InputPreparationRuntimeIdentityError) {
        await markFailed(record.recordId, 'runtime_identity_unavailable');
        throw new InputPreparationRequestError('runtime_identity_unavailable', cause.message, { cause });
      }
      // A compile refusal that names a specific broken contract — an
      // unsupported compiler version, a projection digest that does not
      // describe its own bytes — records THAT code, so a later `lookup`
      // answers the same fact instead of a generic `compile_rejected`.
      await markFailed(
        record.recordId,
        cause instanceof InputPreparationCompileError && cause.detail !== undefined ? cause.detail : 'compile_rejected',
      );
      if (cause instanceof InputPreparationCompileError) {
        throw new InputPreparationRequestError('unsupported_input', cause.message, { cause });
      }
      throw new InputPreparationRequestError('unsupported_input', 'the prepared input could not be compiled', { cause });
    }

    // --- RPC frame admission ----------------------------------------------
    // Decided HERE — after the compile that produces the envelope, and BEFORE
    // the operator's per-artifact retention bound below — because these two
    // bounds belong to different authorities and the frame bound comes first. An
    // envelope that cannot be handed to the runtime in one frame can never be
    // launched, so counting it, retaining it, or charging it against a scope
    // aggregate would all be work done for an artifact nobody can consume.
    //
    // The frame is BUILT, not estimated: the same builder the launcher writes
    // with (`adapters/pi/prepared-prompt-frame.ts`), carrying the same stated
    // command id, so the bytes measured here are the bytes written there.
    {
      const command = buildPreparedPromptCommand(
        compiled.envelope,
        {
          envelopeDigest: compiled.envelopeDigest,
          toolManifestDigest: compiled.toolManifestDigest,
          model: request.selection.model,
          binding: {
            inputIdentity: `${request.source.revision}:${request.source.digest}`,
            runtimeIdentity: inputPreparationRuntimeIdentityString(options.compiler.runtime),
            policyIdentity: limits.revision,
            profileRevision: grant.profileRevision,
          },
        },
        PREPARED_PROMPT_COMMAND_ID,
      );
      if (!fitsRpcFrame(command)) {
        const measuredBytes = rpcFrameByteLength(command);
        await markFailed(record.recordId, 'rpc_frame_too_large');
        throw new InputPreparationRequestError(
          'rpc_frame_too_large',
          `the prepared prompt frame measures ${measuredBytes} bytes, above the ${RPC_MAX_FRAME_BYTES}-byte single-frame limit the SDK enforces on frames it sends`,
        );
      }
    }

    // --- retention budget -------------------------------------------------
    const artifact = {
      format: INPUT_PREPARATION_ARTIFACT_FORMAT,
      version: INPUT_PREPARATION_VERSION,
      recordId: record.recordId,
      requestDigest: compiled.requestDigest,
      envelopeDigest: compiled.envelopeDigest,
      toolManifestDigest: compiled.toolManifestDigest,
      requestBody: compiled.requestBody,
      counterProjection: compiled.counterProjection,
      projection: compiled.projection,
      residual: compiled.residual,
      envelope: compiled.envelope,
    } as const;
    // The per-ARTIFACT bound is a property of this one artifact, so it is
    // decided here. The per-SCOPE aggregates are not: they are shared with
    // every other request in the scope, so they are decided where they are
    // written — inside the store's serialized tail, below.
    if (Buffer.byteLength(JSON.stringify(artifact), 'utf8') > limits.maxArtifactBytes) {
      await markFailed(record.recordId, 'artifact_bytes_exceeded');
      throw new InputPreparationRequestError('limit_exceeded', 'the prepared artifact exceeds the configured per-artifact byte policy');
    }

    // Nothing has been called yet, so an abort that has already landed is a
    // clean cancellation — provably not an unknown counter outcome. Checked
    // before the reservation so the allowance is not spent either.
    if (run.controller.signal.aborted) {
      const detail = run.cancelRequested ? 'cancelled_before_counter' : 'deadline_elapsed_before_counter';
      try {
        await store.update(record.recordId, { state: 'cancelled', detail });
      } catch (writeError) {
        rethrowDurable(writeError);
      }
      throw new InputPreparationRequestError('cancelled', 'this preparation was cancelled before any counter call was placed');
    }

    const summary = {
      requestDigest: compiled.requestDigest,
      envelopeDigest: compiled.envelopeDigest,
      toolManifestDigest: compiled.toolManifestDigest,
      requestBytes: compiled.requestBytes,
      projectionBytes: compiled.projectionBytes,
      projection: compiled.projection,
      residual: compiled.residual,
      observationDigest: surface.observationDigest,
      toolBindingDigest: surface.toolBindingDigest,
      toolImplementationKinds: surface.toolImplementationKinds,
    };
    // Decided once, over D's own bytes, and retained beside the artifact in
    // the same durable transition.
    const requestContentTextOnly = preparedRequestContentIsTextOnly(compiled.requestBody);

    // --- no counter: retain and settle -------------------------------------
    // The size evidence is `summary.requestBytes`, measured by the compiler
    // above. Nothing is counted, nothing is reserved against the scope's
    // counter-call allowance, and the record lands on `prepared` in the same
    // closure that retains its artifact.
    const counter = options.counter;
    if (counter === undefined) {
      try {
        return await store.commitPreparedArtifact({
          recordId: record.recordId,
          artifact,
          summary,
          requestContentTextOnly,
          bounds: { maxScopeAggregateBytes: limits.maxScopeAggregateBytes },
        });
      } catch (cause) {
        if (cause instanceof InputPreparationLimitError) {
          await markFailed(record.recordId, cause.detail);
          throw new InputPreparationRequestError('limit_exceeded', cause.message, { cause });
        }
        await markFailed(record.recordId, 'artifact_write_failed');
        return rethrowDurable(cause);
      }
    }

    // --- reserve the counter call, durably, BEFORE invoking it -------------
    // One serialized closure retains the artifact and charges both per-scope
    // aggregates against the policy this daemon enforces. If this daemon dies
    // after that write and before the result is persisted, restart finds
    // `counting` and reports an interrupted outcome rather than silently
    // placing a second call.
    try {
      await store.commitCounterReservation({
        recordId: record.recordId,
        artifact,
        summary,
        requestContentTextOnly,
        bounds: {
          maxScopeAggregateBytes: limits.maxScopeAggregateBytes,
          maxCounterCallsPerScope: limits.maxCounterCallsPerScope,
        },
      });
    } catch (cause) {
      if (cause instanceof InputPreparationLimitError) {
        await markFailed(record.recordId, cause.detail);
        throw new InputPreparationRequestError('limit_exceeded', cause.message, { cause });
      }
      await markFailed(record.recordId, 'artifact_write_failed');
      rethrowDurable(cause);
    }

    // The reservation write above is an `await`; an abort can land inside it.
    // The call still provably has not been placed, so this stays a clean
    // cancellation — but the reserved allowance is already spent and is not
    // given back.
    if (run.controller.signal.aborted) {
      const detail = run.cancelRequested ? 'cancelled_before_counter' : 'deadline_elapsed_before_counter';
      try {
        await store.update(record.recordId, { state: 'cancelled', detail });
      } catch (writeError) {
        rethrowDurable(writeError);
      }
      throw new InputPreparationRequestError('cancelled', 'this preparation was cancelled before any counter call was placed');
    }

    // --- counter ----------------------------------------------------------
    // The per-call timeout starts HERE, not when the preparation started: it
    // bounds one counter invocation. Starting its clock before the compile and
    // the durable writes would make it a second, shorter copy of the whole
    // preparation's deadline, which is what `preparationDeadlineMs` already is.
    const callTimeout = setTimeout(() => run.controller.abort(), limits.counterTimeoutMs);
    callTimeout.unref?.();
    const calledAt = new Date(now()).toISOString();
    let counted: InputPreparationCounterResultV1;
    let removeAbortListener = (): void => {};
    try {
      counted = validateCounterResult(
        await new Promise<InputPreparationCounterResultV1>((resolve, reject) => {
          const interrupted = (): void => reject(new InputPreparationRequestError(
            'counter_interrupted', 'the counter wait was interrupted; its outcome is unknown',
          ));
          run.controller.signal.addEventListener('abort', interrupted, { once: true });
          removeAbortListener = () => run.controller.signal.removeEventListener('abort', interrupted);
          if (run.controller.signal.aborted) { interrupted(); return; }
          // Both handlers stay attached even after the SDK wait has settled.
          // Late adapter resolution cannot write state; late rejection is consumed.
          counter.count({
            counterProjection: compiled.counterProjection,
            target,
            timeoutMs: limits.counterTimeoutMs,
            signal: run.controller.signal,
          }).then(resolve, reject);
        }),
      );
      if (run.controller.signal.aborted) {
        // The adapter resolved, but this run was already aborted: the outcome
        // reached us after the decision to stop, so it is not a clean count.
        throw new InputPreparationRequestError('counter_interrupted', 'the counter call was aborted before its result was accepted');
      }
      // The count must be evidence about THIS preparation. The adapter was
      // handed P(D) and a target; the evidence it answers with names a
      // projection digest and an endpoint/model, and both are compared against
      // the compiled artifact rather than taken on trust. A number bound to a
      // different projection is not a smaller count, it is a count of something
      // else, and persisting it would make the receipt claim a fact nobody
      // established.
      if (
        counted.providerEvidence.projectionDigest !== compiled.projection.digest ||
        counted.providerEvidence.endpoint !== target.endpoint ||
        counted.providerEvidence.modelId !== target.modelId
      ) {
        throw new InputPreparationRequestError(
          'counter_unavailable',
          'the counter evidence names a projection or target other than the one this preparation compiled',
        );
      }
    } catch (cause) {
      const detail = run.cancelRequested
        ? 'cancelled_during_counter'
        : run.controller.signal.aborted
          ? 'counter_deadline_elapsed'
          : 'counter_outcome_unknown';
      // Deliberately `counter_interrupted` even for an explicit cancel that
      // landed mid-call: the call WAS placed and its provider-side outcome is
      // unknown, and recording that as a clean cancellation would invite an
      // automatic retry that could be a second billed call (§10.3.5).
      try {
        await store.update(record.recordId, { state: 'counter_interrupted', detail });
      } catch (writeError) {
        rethrowDurable(writeError);
      }
      if (cause instanceof InputPreparationRequestError) throw cause;
      throw new InputPreparationRequestError('counter_interrupted', 'the counter call outcome is unknown and will not be repeated', {
        cause,
      });
    } finally {
      clearTimeout(callTimeout);
      removeAbortListener();
    }

    const evidence: InputPreparationCounterEvidenceV1 = {
      ...counted,
      target,
      calledAt,
      completedAt: new Date(now()).toISOString(),
    };
    try {
      return await store.update(record.recordId, { state: 'prepared', counter: evidence });
    } catch (cause) {
      return rethrowDurable(cause);
    }
  }

  async function prepare(
    rawRequest: InputPreparationRequestV1,
    callOptions?: InputPreparationCallOptions,
  ): Promise<InputPreparationReceiptV1> {
    // Copy before the first await. Everything below reads this copy only.
    const request = structuredClone(rawRequest) as InputPreparationRequestV1;
    await ensureOpen();

    if (request.policyRevision !== limits.revision) {
      throw new InputPreparationRequestError(
        'policy_revision_mismatch',
        'this request presents a policy revision this daemon does not enforce',
      );
    }
    const normalized = canonicalInputPreparationJson(request);
    if (Buffer.byteLength(normalized, 'utf8') > limits.maxRequestBytes) {
      throw new InputPreparationRequestError('limit_exceeded', 'the request exceeds the configured request byte policy');
    }

    const grant = await resolveAuthority(request.scope);
    const source = await resolveSourceAuthority(request, grant);
    const verifiedRequest = { ...request, source };
    assertAvailable();
    const runtime = options.compiler.runtime;
    const requestDigest = inputPreparationDigest({
      request,
      scopeId: grant.scopeId,
      runtime,
      policyRevision: limits.revision,
    });
    const target: InputPreparationCounterTargetV1 = {
      endpoint: request.selection.model.baseUrl,
      modelId: request.selection.model.id,
    };
    const key: InputPreparationRecordKey = {
      scopeId: grant.scopeId,
      agentRef: grant.agentRef,
      requestId: request.requestId,
    };
    const recordId = inputPreparationRecordId(key);

    return withRecordLock(recordId, async () => {
      assertAvailable();
      await store.gc(now(), true).catch(rethrowDurable);
      assertAvailable();
      let outcome;
      try {
        // The in-flight bound travels WITH the reservation: two different
        // requestIds take two different record locks, so the only place the
        // admission and the append cannot be pulled apart is inside the store.
        outcome = await store.reserve({
          key,
          requestDigest,
          binding: buildBinding(verifiedRequest, grant, target, requestDigest),
          // Recorded with the reservation, before anything is compiled: a
          // prepared launch must re-present this exact identity to the native
          // verifier, and the only other copy of it is inside the envelope the
          // native contract forbids reading expectations out of.
          model: request.selection.model,
          maxInFlight: limits.maxInFlight,
        });
      } catch (cause) {
        if (cause instanceof InputPreparationLimitError) {
          throw new InputPreparationRequestError('limit_exceeded', cause.message, { cause });
        }
        if (cause instanceof InputPreparationConflictError) {
          throw new InputPreparationRequestError(
            'request_conflict',
            'this requestId is already bound to a different request in this scope',
            { cause },
          );
        }
        return rethrowDurable(cause);
      }
      if (outcome.kind === 'existing') {
        // Idempotent: the durable fact is the answer. Never a second compile,
        // never a second counter call, and — since the tool manifest became a
        // daemon observation rather than caller text — never a second PROBE
        // either. A repeat that re-observed would mint a second executor fact
        // under one idempotency key, which is the substitution this key exists
        // to prevent.
        //
        // Drift is still checked, on the half of the evidence that can be
        // re-derived without starting anything: the launch attestation, the
        // toolset definition revisions, the configured argv and the
        // implementation identities. If any of those moved since the recorded
        // artifact was frozen, the recorded receipt no longer describes this
        // device and the repeat is REFUSED rather than answered — the caller
        // mints a new preparation instead of silently receiving one bound to
        // stale evidence.
        //
        // A record with no artifact yet (a concurrent duplicate still in
        // flight, or one that failed before it froze anything) has nothing to
        // compare against, so it answers with its own durable state.
        const recorded = outcome.record.artifact;
        if (recorded !== undefined) {
          const rebound = await options.toolSurface.resolveBinding({
            requiredToolsets: request.requiredToolsets,
          });
          if (!rebound.ok) {
            throw new InputPreparationRequestError(rebound.code, rebound.message);
          }
          if (rebound.binding.toolBindingDigest !== recorded.toolBindingDigest) {
            throw new InputPreparationRequestError(
              'observation_drift',
              'the launch binding, toolset definitions or tool implementations behind this preparation'
                + ' changed after its artifact was frozen; it will not be re-derived under the same requestId',
            );
          }
        }
        return toReceipt(outcome.record, now());
      }

      // One mutable run object, shared by `runPreparation` and `cancel()`: both
      // halves must observe the same `cancelRequested` flag and the same
      // controller, or a cancel lands on a copy nobody reads.
      const controller = new AbortController();
      // Shutdown may have started while the durable reservation was queued.
      // Its waiter owns this lock too; do not begin a new counter after stop.
      if (stopped) controller.abort();
      const run: ActiveRun = { controller, done: Promise.resolve(), cancelRequested: false };
      // The whole preparation's deadline. The single counter call has its own,
      // separate bound, started inside `runPreparation` when that call actually
      // begins. Both are explicit policy; neither is a default.
      const requestedDeadlineMs = callOptions?.deadlineMs;
      const deadlineMs =
        requestedDeadlineMs === undefined || !Number.isFinite(requestedDeadlineMs)
          ? limits.preparationDeadlineMs
          : Math.max(1, Math.min(requestedDeadlineMs, limits.preparationDeadlineMs));
      const deadline = setTimeout(() => controller.abort(), deadlineMs);
      deadline.unref?.();
      active.set(recordId, run);
      const settled = runPreparation(outcome.record, request, grant, target, run);
      run.done = settled.then(
        () => undefined,
        () => undefined,
      );
      try {
        return toReceipt(await settled, now());
      } finally {
        clearTimeout(deadline);
        active.delete(recordId);
        scheduleGc();
      }
    });
  }

  async function locate(params: InputPreparationLookupParamsV1): Promise<{ record: InputPreparationRecord; recordId: string }> {
    await ensureOpen();
    const grant = await resolveAuthority(params.scope);
    const recordId = inputPreparationRecordId({
      scopeId: grant.scopeId,
      agentRef: grant.agentRef,
      requestId: params.requestId,
    });
    const record = store.get(recordId);
    if (!record) {
      // The same answer for "never existed" and "belongs to another scope":
      // a refusal must not be a probe for what another scope has prepared.
      throw new InputPreparationRequestError('not_found', 'no preparation record for this requestId in this scope');
    }
    return { record, recordId };
  }

  return {
    store,
    async open(): Promise<void> {
      const wasOpened = opened !== undefined;
      stopped = false;
      await ensureOpen();
      if (wasOpened) await store.gc(now(), true).catch(rethrowDurable);
      scheduleGc();
    },
    prepare,
    runtime: options.compiler.runtime,
    async lookup(params: InputPreparationLookupParamsV1): Promise<InputPreparationReceiptV1> {
      const { record } = await locate(params);
      return toReceipt(record, now());
    },
    async cancel(params: InputPreparationCancelParamsV1): Promise<InputPreparationReceiptV1> {
      const { record, recordId } = await locate(params);
      if (isTerminalInputPreparationState(record.state)) {
        // Cancelling a settled preparation changes nothing. It is not an error
        // either: the caller asked for it to be over, and it is.
        return toReceipt(record, now());
      }
      const run = active.get(recordId);
      if (run) {
        run.cancelRequested = true;
        run.controller.abort();
        // The owning run writes the terminal record; waiting for it is what
        // makes this method's answer the real durable outcome rather than a
        // hopeful one.
        await run.done;
        const settledRecord = store.get(recordId);
        if (settledRecord) return toReceipt(settledRecord, now());
      }
      try {
        return toReceipt(await store.update(recordId, { state: 'cancelled', detail: 'cancelled_by_operator' }), now());
      } catch (cause) {
        return rethrowDurable(cause);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      if (gcTimer !== undefined) clearTimeout(gcTimer);
      gcTimer = undefined;
      await opened;
      const pending = [...active.values()];
      for (const run of pending) run.controller.abort();
      await Promise.all(pending.map((run) => run.done));
      await Promise.all(locks.values());
      await gcInFlight;
      if (gcFailure) rethrowDurable(gcFailure.cause);
    },
  };
}
