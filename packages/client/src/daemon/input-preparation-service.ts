import { createHash } from 'node:crypto';
import {
  INPUT_PREPARATION_RECEIPT_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationAuthorityGrantV1,
  type InputPreparationAuthorityResolver,
  type InputPreparationBindingV1,
  type InputPreparationCancelParamsV1,
  type InputPreparationCounterAdapter,
  type InputPreparationCounterEvidenceV1,
  type InputPreparationCounterResultV1,
  type InputPreparationCounterTargetV1,
  type InputPreparationErrorCodeV1,
  type InputPreparationLimitsPolicyV1,
  type InputPreparationLookupParamsV1,
  type InputPreparationReadinessReasonV1,
  type InputPreparationReceiptV1,
  type InputPreparationRequestV1,
  type InputPreparationScopeClaimV1,
} from '../input-preparation';
import {
  InputPreparationCompileError,
  type InputPreparationCompiler,
} from '../adapters/pi/input-preparation';
import {
  InputPreparationConflictError,
  InputPreparationDurabilityError,
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
 *  5. Durable reserve, before the counter is ever invoked. Same key and digest
 *     returns the existing fact; a different digest conflicts (§10.3.5).
 *  6. Pure compile, then durable artifact, then the durably reserved counter
 *     call, then the durably persisted result — in that order, so no success is
 *     ever reported that is not already on disk (§10.3.5, §10.3.8).
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
  readonly counter: InputPreparationCounterAdapter;
  readonly compiler: InputPreparationCompiler;
  readonly now?: () => number;
}

export interface InputPreparationService {
  /** Replay, confirm and reconcile the durable log. Must complete before any method answers. */
  open(): Promise<void>;
  prepare(request: InputPreparationRequestV1): Promise<InputPreparationReceiptV1>;
  lookup(params: InputPreparationLookupParamsV1): Promise<InputPreparationReceiptV1>;
  cancel(params: InputPreparationCancelParamsV1): Promise<InputPreparationReceiptV1>;
  /** Aborts every owned counter call. Outcomes stay observable in the durable record. */
  stop(): Promise<void>;
  /** Internal test seam: the durable store behind this service. */
  readonly store: InputPreparationStore;
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Key-sorted JSON, so two structurally equal requests always produce the same
 * bytes and therefore the same digest. Field ORDER on the wire must never be
 * able to turn one request into two idempotency keys.
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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Why this record is not ready to admit an Execution.
 *
 * An empty list is the only thing that makes `ready` true, and today the list
 * can never be empty: the native compiler proves `coverage: "unknown"`, so
 * `compiler_coverage_unknown` is always present. That is the honest state of
 * §10.2's G4, not a placeholder — a fixture counter adds
 * `counter_authority_not_production` on top of it, so an offline suite cannot
 * even accidentally look like production accounting evidence.
 */
export function inputPreparationReadinessReasons(
  record: InputPreparationRecord,
  nowMs: number,
): InputPreparationReadinessReasonV1[] {
  const reasons: InputPreparationReadinessReasonV1[] = [];
  switch (record.state) {
    case 'reserved':
    case 'counting':
      reasons.push('not_counted');
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
    case 'counted':
      break;
  }
  if (record.artifact === undefined) {
    if (!reasons.includes('not_counted')) reasons.push('not_counted');
  } else {
    if (record.artifact.coverage !== 'complete') reasons.push('compiler_coverage_unknown');
    if (record.artifactBytes === 0 || nowMs >= Date.parse(record.artifactExpiresAt)) reasons.push('artifact_expired');
  }
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
    (result.kind !== 'count' && result.kind !== 'bound') ||
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
    kind: result.kind,
    value: result.value as number,
    coverage: {
      covered: coverage.covered,
      ...(coverage.reason === undefined ? {} : { reason: coverage.reason as string }),
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
    })();
    await opened;
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
      runtime: options.compiler.runtime,
      requestDigest,
    };
  }

  async function runPreparation(
    record: InputPreparationRecord,
    request: InputPreparationRequestV1,
    grant: InputPreparationAuthorityGrantV1,
    target: InputPreparationCounterTargetV1,
    run: ActiveRun,
  ): Promise<InputPreparationRecord> {
    // --- pure stage -------------------------------------------------------
    // No filesystem, environment, session, process, tool or network access
    // happens inside this call; the runtime identity it is bound to was read
    // once at compiler construction.
    let compiled;
    try {
      compiled = await options.compiler.compile({
        snapshot: request.snapshot,
        model: request.selection.model,
        options: request.selection.options,
        binding: {
          inputIdentity: `${request.source.revision}:${request.source.digest}`,
          runtimeIdentity: `${options.compiler.runtime.packageName}@${options.compiler.runtime.packageVersion}+${options.compiler.runtime.upstreamCommit}.${String(options.compiler.runtime.forkBuild)}`,
          policyIdentity: limits.revision,
          profileRevision: grant.profileRevision,
        },
        toolExecutors: request.toolExecutors,
      });
    } catch (cause) {
      await store.update(record.recordId, { state: 'failed', detail: 'compile_rejected' }).catch(() => undefined);
      if (cause instanceof InputPreparationCompileError) {
        throw new InputPreparationRequestError('unsupported_input', cause.message, { cause });
      }
      throw new InputPreparationRequestError('unsupported_input', 'the prepared input could not be compiled', { cause });
    }

    // --- retention budget -------------------------------------------------
    const artifact = {
      format: 'byok.input-preparation.artifact',
      version: INPUT_PREPARATION_VERSION,
      recordId: record.recordId,
      requestDigest: compiled.requestDigest,
      envelopeDigest: compiled.envelopeDigest,
      toolManifestDigest: compiled.toolManifestDigest,
      requestBody: compiled.requestBody,
      counterProjection: compiled.counterProjection,
      coverage: compiled.coverage,
      envelope: compiled.envelope,
    } as const;
    const artifactBytes = Buffer.byteLength(JSON.stringify(artifact), 'utf8');
    if (artifactBytes > limits.maxArtifactBytes) {
      await store.update(record.recordId, { state: 'failed', detail: 'artifact_bytes_exceeded' }).catch(() => undefined);
      throw new InputPreparationRequestError('limit_exceeded', 'the prepared artifact exceeds the configured per-artifact byte policy');
    }
    const usage = store.scopeUsage(grant.scopeId);
    if (usage.artifactBytes + artifactBytes > limits.maxScopeAggregateBytes) {
      await store.update(record.recordId, { state: 'failed', detail: 'scope_aggregate_bytes_exceeded' }).catch(() => undefined);
      throw new InputPreparationRequestError('limit_exceeded', 'this scope has no remaining prepared-artifact byte allowance');
    }
    if (usage.counterCalls + 1 > limits.maxCounterCallsPerScope) {
      await store.update(record.recordId, { state: 'failed', detail: 'counter_call_limit_exceeded' }).catch(() => undefined);
      throw new InputPreparationRequestError('limit_exceeded', 'this scope has no remaining counter-call allowance');
    }

    try {
      await store.putArtifact(artifact);
    } catch (cause) {
      await store.update(record.recordId, { state: 'failed', detail: 'artifact_write_failed' }).catch(() => undefined);
      rethrowDurable(cause);
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

    // --- reserve the counter call, durably, BEFORE invoking it -------------
    // If this daemon dies after this write and before the result is persisted,
    // restart finds `counting` and reports an interrupted outcome rather than
    // silently placing a second call.
    try {
      await store.update(record.recordId, {
        state: 'counting',
        artifact: {
          requestDigest: compiled.requestDigest,
          envelopeDigest: compiled.envelopeDigest,
          toolManifestDigest: compiled.toolManifestDigest,
          requestBytes: compiled.requestBytes,
          projectionBytes: compiled.projectionBytes,
          coverage: compiled.coverage,
        },
        artifactBytes,
        counterCalls: 1,
      });
    } catch (cause) {
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
    try {
      counted = validateCounterResult(
        await options.counter.count({
          counterProjection: compiled.counterProjection,
          target,
          timeoutMs: limits.counterTimeoutMs,
          signal: run.controller.signal,
        }),
      );
      if (run.controller.signal.aborted) {
        // The adapter resolved, but this run was already aborted: the outcome
        // reached us after the decision to stop, so it is not a clean count.
        throw new InputPreparationRequestError('counter_interrupted', 'the counter call was aborted before its result was accepted');
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
    }

    const evidence: InputPreparationCounterEvidenceV1 = {
      ...counted,
      target,
      calledAt,
      completedAt: new Date(now()).toISOString(),
    };
    try {
      return await store.update(record.recordId, { state: 'counted', counter: evidence });
    } catch (cause) {
      return rethrowDurable(cause);
    }
  }

  async function prepare(rawRequest: InputPreparationRequestV1): Promise<InputPreparationReceiptV1> {
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
    const runtime = options.compiler.runtime;
    const requestDigest = sha256Hex(
      canonicalInputPreparationJson({
        request,
        scopeId: grant.scopeId,
        runtime,
        policyRevision: limits.revision,
      }),
    );
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
      await store.gc(now()).catch(rethrowDurable);
      if (store.inFlightCount() >= limits.maxInFlight) {
        throw new InputPreparationRequestError('limit_exceeded', 'this daemon has no remaining in-flight preparation allowance');
      }
      let outcome;
      try {
        outcome = await store.reserve({
          key,
          requestDigest,
          binding: buildBinding(request, grant, target, requestDigest),
        });
      } catch (cause) {
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
        // never a second counter call — including for a record whose counter
        // outcome is unknown.
        return toReceipt(outcome.record, now());
      }

      // One mutable run object, shared by `runPreparation` and `cancel()`: both
      // halves must observe the same `cancelRequested` flag and the same
      // controller, or a cancel lands on a copy nobody reads.
      const controller = new AbortController();
      const run: ActiveRun = { controller, done: Promise.resolve(), cancelRequested: false };
      // The whole preparation's deadline. The single counter call has its own,
      // separate bound, started inside `runPreparation` when that call actually
      // begins. Both are explicit policy; neither is a default.
      const deadline = setTimeout(() => controller.abort(), limits.preparationDeadlineMs);
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
    open: ensureOpen,
    prepare,
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
      const pending = [...active.values()];
      for (const run of pending) run.controller.abort();
      await Promise.all(pending.map((run) => run.done));
    },
  };
}
