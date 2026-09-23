import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';
import { DurableJsonlFile } from '../util/durable-jsonl';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_RECORD_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationBindingV1,
  type InputPreparationArtifactSummaryV1,
  type InputPreparationCounterEvidenceV1,
  type InputPreparationModelV1,
  type InputPreparationPinV1,
  type InputPreparationProjectionV1,
  type InputPreparationResidualKeyV1,
  type InputPreparationStateV1,
} from '../input-preparation';

/**
 * Durable request / receipt / artifact persistence for the B-P2 local
 * primitive (`docs/researches/runtime-input-preparation-contract.md` §10.3.5,
 * §10.3.6, §10.3.8).
 *
 * One durable namespace, `(authenticated scope, Agent, preparation requestId)`,
 * bound to the entire normalized request digest. This file owns exactly that
 * namespace plus the retained artifact bytes; it chooses no policy number,
 * resolves no authority and places no counter call. Everything above it is
 * `input-preparation-service.ts`.
 *
 * It does enforce the bounds that service hands it, because a bound is only
 * real where the write is: admission is decided inside the same serialized
 * closure that appends the record, never on a value someone read first.
 *
 * Durability comes from the package's existing primitives, not from `rename`
 * alone: the record log is a `DurableJsonlFile` (append + fsync + directory
 * fsync, and QUARANTINED after any uncertain write until the log is
 * revalidated), and each artifact is an `atomicWriteFile` with `fsync`. An
 * uncertain write is therefore an error the caller sees, never a silent
 * success — §10.3.8.
 *
 * Two horizons, deliberately separate:
 *
 * - `artifactExpiresAt = createdAt + retentionMs` — after this the retained
 *   bytes are removed and the receipt reports `artifact_expired`.
 * - `recordExpiresAt = artifactExpiresAt + retryHorizonMs` — the TOMBSTONE
 *   outlives its own artifact by the whole advertised retry horizon, which is
 *   what makes "an expired key cannot silently become a fresh call inside that
 *   horizon" true rather than aspirational: a duplicate `requestId` inside the
 *   horizon still finds a record, and a found record never triggers a second
 *   counter call.
 */

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

/**
 * The durable RECORD schema version, and nothing else.
 *
 * Deliberately separate from `INPUT_PREPARATION_VERSION`, which versions the
 * wire shapes — the control request, the receipt, the retained artifact. Those
 * are what two parties agree on; this one is what one daemon's own on-disk log
 * is written in, and the two move for different reasons. Bumping the wire
 * version because a private durable field became required would make every
 * peer re-negotiate a contract that did not change; reusing the wire version
 * for the log would make the log's meaning depend on an agreement it is not a
 * party to.
 *
 * 3 was the first version in which `model` is a required durable fact (a
 * prepared launch must re-present the counted model identity as an INDEPENDENT
 * expectation, and the only other copy of it lives inside the retained
 * envelope, which the native contract forbids using as its own expectation).
 *
 * 4 is the first version whose artifact carries the native compiler's
 * structural projection contract — `projection` plus a classified `residual`
 * list — in place of the single opaque `coverage` label version 3 wrote. A
 * version-3 record cannot be read forward: nothing can honestly decide whether
 * a record frozen under an opaque label had a content-complete projection or
 * which residual keys its request carried, and inventing either is precisely
 * the shadow accounting this contract forbids.
 *
 * 5 is the first version written against the 0.86 runtime contract: the
 * retained snapshot carries `prompt.skills` and `prompt.toolGuidelines` in
 * place of `prompt.formattedSkills`, and the artifact's projection declares
 * contract v3. A version-4 record cannot be read forward either — its prompt
 * was rendered by a renderer this build no longer has, so the request it
 * describes cannot be re-derived, and translating it would be inventing bytes.
 *
 * 6 is the first version written under bounded admission: the successful
 * terminal state is `prepared` (it was `counted`), counter evidence carries no
 * `kind`, a record may reach `prepared` with no counter at all, and a record
 * holding an artifact states `requestContentTextOnly`. A version-5 record
 * cannot be read forward: its terminal state names a lifecycle this build no
 * longer has, and nothing can honestly say whether its D was text only
 * without re-reading bytes the record never vouched for.
 *
 * A record at any other version is refused — see
 * {@link InputPreparationUnsupportedRecordVersionError}. There is no
 * compatibility read.
 */
export const INPUT_PREPARATION_RECORD_VERSION = 6;

/** The durable idempotency key. Never a task id, and never caller-asserted: `scopeId` comes from the trusted authority grant. */
export interface InputPreparationRecordKey {
  readonly scopeId: string;
  readonly agentRef: string;
  readonly requestId: string;
}

export interface InputPreparationRecord {
  readonly format: typeof INPUT_PREPARATION_RECORD_FORMAT;
  /** The RECORD schema version — see {@link INPUT_PREPARATION_RECORD_VERSION}. Not the wire version. */
  readonly version: typeof INPUT_PREPARATION_RECORD_VERSION;
  readonly recordId: string;
  readonly key: InputPreparationRecordKey;
  /** Digest over the whole normalized request, scope and runtime identity. */
  readonly requestDigest: string;
  readonly state: InputPreparationStateV1;
  readonly binding: InputPreparationBindingV1;
  /**
   * The exact model identity the request was compiled for.
   *
   * Durable, and BESIDE the binding rather than inside it. Beside, because the
   * binding is the wire projection a receipt discloses and a model identity
   * carries a base URL and a cost table a receipt has no business publishing.
   * Durable, because a prepared launch must re-present it to the native
   * verifier as an INDEPENDENT expectation — the only other copy of it lives
   * inside the retained envelope, and the native contract is explicit that a
   * value read out of the envelope can never serve as its own expectation.
   */
  readonly model: InputPreparationModelV1;
  readonly artifact?: InputPreparationArtifactSummaryV1;
  /**
   * Whether D — the retained provider request — carries text content parts
   * only (`adapters/pi/input-preparation.ts`'s
   * `preparedRequestContentIsTextOnly`). Written in the same durable
   * transition that retains the artifact, and present exactly when
   * `artifact` is: it is a fact about those bytes, decided once, so readiness
   * reads it rather than re-parsing D.
   */
  readonly requestContentTextOnly?: boolean;
  /** Present only when a configured counter answered. Absent is a legal, ready-capable state. */
  readonly counter?: InputPreparationCounterEvidenceV1;
  /** Retained bytes attributable to this record, counted against the per-scope aggregate. */
  readonly artifactBytes: number;
  /** Counter invocations this record has consumed. Never decremented; always 0 without a counter. */
  readonly counterCalls: number;
  /** Stable code on a terminal non-`prepared` state; never provider or stack text. */
  readonly detail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly artifactExpiresAt: string;
  readonly recordExpiresAt: string;
  /** The committed Execution that consumed this record, written once by {@link InputPreparationStore.pin}. */
  readonly pin?: InputPreparationPinV1;
}

/** The retained immutable artifact. `requestBody` is D verbatim. */
export interface InputPreparationArtifact {
  readonly format: typeof INPUT_PREPARATION_ARTIFACT_FORMAT;
  readonly version: typeof INPUT_PREPARATION_VERSION;
  readonly recordId: string;
  readonly requestDigest: string;
  readonly envelopeDigest: string;
  readonly toolManifestDigest: string;
  /** D — the exact provider request body bytes, unchanged. */
  readonly requestBody: string;
  /** P(D) — the counted projection, unchanged. */
  readonly counterProjection: string;
  /** What the native compiler proved about P(D), copied verbatim off the envelope. */
  readonly projection: InputPreparationProjectionV1;
  /** Every top-level key of D outside P(D), classified by the native compiler. */
  readonly residual: readonly InputPreparationResidualKeyV1[];
  /** The native envelope, retained verbatim so a later consumer re-verifies rather than recompiles. */
  readonly envelope: unknown;
}

/** Terminal states never transition again. */
const TERMINAL_STATES: ReadonlySet<InputPreparationStateV1> = new Set<InputPreparationStateV1>([
  'prepared',
  'cancelled',
  'failed',
  'counter_interrupted',
]);

export function isTerminalInputPreparationState(state: InputPreparationStateV1): boolean {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Same key, different normalized request digest. Never resolved by overwriting either side. */
export class InputPreparationConflictError extends Error {
  constructor(readonly recordId: string) {
    super('a preparation with this requestId already exists in this scope bound to a different request digest');
    this.name = 'InputPreparationConflictError';
  }
}

/** A durable write was uncertain, or the log is quarantined pending revalidation. */
export class InputPreparationDurabilityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InputPreparationDurabilityError';
  }
}

/**
 * A bound the caller passed in was already spent when the write was about to
 * happen.
 *
 * The store owns no policy: every number it compares against arrives on the
 * call that asks for the write. What it does own is the only moment at which
 * that comparison is meaningful — inside the serialized tail, in the same
 * closure as the append. A caller that read an aggregate and then asked for a
 * write would be deciding on a snapshot another caller can invalidate before
 * the write lands (§10.3.7).
 */
export type InputPreparationLimitDetail =
  | 'in_flight_limit_exceeded'
  | 'scope_aggregate_bytes_exceeded'
  | 'counter_call_limit_exceeded';

export class InputPreparationLimitError extends Error {
  constructor(
    readonly detail: InputPreparationLimitDetail,
    message: string,
  ) {
    super(message);
    this.name = 'InputPreparationLimitError';
  }
}

/** The stored record or artifact does not match what was persisted. */
export class InputPreparationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputPreparationIntegrityError';
  }
}

/**
 * The log holds a record written in a schema version this build does not
 * support.
 *
 * A refusal, never a migration and never a compatibility read: the older shape
 * is missing facts a prepared Execution cannot be launched without, and a store
 * that silently held records it could not honor would be worse than one that
 * says so. The refusal happens during replay, BEFORE the store is open, so it
 * performs zero writes and zero cleanup — the log and every artifact beside it
 * are left exactly as found for an operator to dispose of explicitly.
 */
export class InputPreparationUnsupportedRecordVersionError extends InputPreparationIntegrityError {
  readonly reason = 'unsupported_record_version';

  constructor(readonly recordId: string, readonly recordVersion: unknown) {
    super(
      `the input-preparation record log contains record ${recordId} at record schema version ${JSON.stringify(recordVersion)},`
      + ` which this build does not support (it supports record schema version ${INPUT_PREPARATION_RECORD_VERSION} only);`
      + ' the record is an unsupported older version and has been left untouched pending explicit operator disposition',
    );
    this.name = 'InputPreparationUnsupportedRecordVersionError';
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface InputPreparationStoreOptions {
  /** The daemon's store directory. The subtree below it is created 0700 on open. */
  readonly storeDir: string;
  readonly retentionMs: number;
  readonly retryHorizonMs: number;
  readonly now?: () => number;
}

export interface ReserveInput {
  readonly key: InputPreparationRecordKey;
  readonly requestDigest: string;
  readonly binding: InputPreparationBindingV1;
  /** See {@link InputPreparationRecord.model}. */
  readonly model: InputPreparationModelV1;
  /**
   * The caller's in-flight bound, enforced in the same closure that appends the
   * new record. Never consulted for a key that already exists: reading back an
   * existing durable fact is not a new admission.
   */
  readonly maxInFlight: number;
}

/** The bounds one artifact retention is admitted against. Supplied by the caller, compared here. */
export interface ArtifactCommitBounds {
  readonly maxScopeAggregateBytes: number;
}

/** The bounds one counter reservation is admitted against: retention plus the counter-call allowance. */
export interface CounterReservationBounds extends ArtifactCommitBounds {
  readonly maxCounterCallsPerScope: number;
}

export interface ArtifactCommitInput {
  readonly recordId: string;
  /** The immutable artifact, written inside the same closure that charges its bytes. */
  readonly artifact: InputPreparationArtifact;
  /** The identities and sizes the receipt publishes. */
  readonly summary: InputPreparationArtifactSummaryV1;
  /** See {@link InputPreparationRecord.requestContentTextOnly}. */
  readonly requestContentTextOnly: boolean;
  readonly bounds: ArtifactCommitBounds;
}

export interface CounterReservationInput extends ArtifactCommitInput {
  readonly bounds: CounterReservationBounds;
}

export type ReserveOutcome =
  | { readonly kind: 'created'; readonly record: InputPreparationRecord }
  | { readonly kind: 'existing'; readonly record: InputPreparationRecord };

/**
 * The result of one compare-and-set against a record's single pin slot.
 *
 * `occupied` is not an error: it is the answer the losing runner of a race is
 * supposed to get, and it carries the record so the caller can report WHICH
 * Execution holds it.
 */
export type PinOutcome =
  | { readonly kind: 'pinned'; readonly record: InputPreparationRecord }
  | { readonly kind: 'occupied'; readonly record: InputPreparationRecord };

/** The mutable fields one durable transition may set. Identity and key are immutable. */
export interface RecordPatch {
  readonly state?: InputPreparationStateV1;
  readonly artifact?: InputPreparationArtifactSummaryV1;
  readonly counter?: InputPreparationCounterEvidenceV1;
  readonly artifactBytes?: number;
  readonly counterCalls?: number;
  readonly detail?: string;
}

export interface ScopeUsage {
  readonly artifactBytes: number;
  readonly counterCalls: number;
  readonly liveRecords: number;
}

const RECORD_DIR = 'input-preparation';
const RECORD_LOG = 'records.jsonl';
const ARTIFACT_DIR = 'artifacts';

/** `recordId` is a digest of the key, so two scopes can never collide and no key value ever becomes a filename. */
export function inputPreparationRecordId(key: InputPreparationRecordKey): string {
  return createHash('sha256')
    .update(JSON.stringify([key.scopeId, key.agentRef, key.requestId]), 'utf8')
    .digest('hex');
}

export class InputPreparationStore {
  private readonly root: string;
  private readonly artifactDir: string;
  private readonly now: () => number;
  private log: DurableJsonlFile;
  private records = new Map<string, InputPreparationRecord>();
  /** Serializes every mutation so two callers never interleave a read-modify-append. */
  private tail: Promise<unknown> = Promise.resolve();
  private opened = false;

  constructor(private readonly options: InputPreparationStoreOptions) {
    this.root = path.join(options.storeDir, RECORD_DIR);
    this.artifactDir = path.join(this.root, ARTIFACT_DIR);
    this.now = options.now ?? Date.now;
    this.log = new DurableJsonlFile(path.join(this.root, RECORD_LOG));
  }

  /**
   * Create the subtree, replay the log and confirm the recovered bytes.
   *
   * Replay alone is not a durability receipt — `confirmRecovered()` fsyncs what
   * was read back before any of it is treated as fact, which is the same rule
   * `DurableJsonlFile` documents for its own consumers.
   */
  async open(): Promise<void> {
    if (this.opened) return;
    await fs.mkdir(this.artifactDir, { recursive: true, mode: 0o700 });
    await this.log.confirmRecovered();
    this.records = await this.replay();
    this.opened = true;
  }

  private async replay(): Promise<Map<string, InputPreparationRecord>> {
    const replayed = new Map<string, InputPreparationRecord>();
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.root, RECORD_LOG), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return replayed;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        // A torn or foreign line means the log's integrity is unknown. Refuse
        // rather than silently dropping a record that may be the only evidence
        // of a counter call that already happened.
        throw new InputPreparationIntegrityError(
          `the input-preparation record log contains a line that is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const record = parsed as InputPreparationRecord;
      if (record.format !== INPUT_PREPARATION_RECORD_FORMAT) {
        throw new InputPreparationIntegrityError('the input-preparation record log contains an unknown record format');
      }
      // The version is the ONLY thing that discriminates a supported record
      // from an older one. Probing for an individual field instead (does it
      // carry `model`?) would be a second, weaker authority over the same
      // question, and would quietly accept any future shape that happens to
      // have the field the probe knows to look for.
      if (record.version !== INPUT_PREPARATION_RECORD_VERSION) {
        throw new InputPreparationUnsupportedRecordVersionError(record.recordId, record.version);
      }
      // Last write wins per record id: the log is an append-only history of
      // one record's transitions, replayed in order.
      replayed.set(record.recordId, record);
    }
    return replayed;
  }

  /**
   * Re-open and revalidate a quarantined log.
   *
   * `DurableJsonlFile` latches after an uncertain write and refuses every later
   * append. That latch is the contract, so recovery is explicit: read the log
   * back, confirm the recovered bytes, and only then accept writes again.
   */
  async revalidate(): Promise<void> {
    this.log = new DurableJsonlFile(path.join(this.root, RECORD_LOG));
    await this.log.confirmRecovered();
    this.records = await this.replay();
    this.opened = true;
  }

  /**
   * Drop this instance's replayed state.
   *
   * Nothing on disk is touched: the log and the artifacts are the durable
   * facts, and this only ends one process's view of them. After it, every read
   * refuses instead of answering `undefined` — which is the whole point, since
   * a closed store and an empty one would otherwise be indistinguishable to a
   * caller. Re-opening replays from disk again.
   */
  close(): void {
    this.opened = false;
    this.records = new Map();
  }

  private assertOpen(): void {
    if (!this.opened) throw new InputPreparationDurabilityError('the input-preparation store has not been opened');
  }

  /** Serialize a mutation behind every mutation already queued. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    // Keep the chain alive regardless of this call's own outcome; the caller
    // still observes its own rejection through the returned promise.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async append(record: InputPreparationRecord): Promise<void> {
    try {
      await this.log.append(JSON.stringify(record));
    } catch (cause) {
      throw new InputPreparationDurabilityError(
        'the input-preparation record could not be durably written; the log is quarantined until it is revalidated',
        { cause },
      );
    }
    this.records.set(record.recordId, record);
  }

  /**
   * Durably reserve the key BEFORE anything is compiled or counted.
   *
   * Same key and same digest returns the existing record — the caller decides
   * whether that is a completed receipt, a pending fact or a terminal
   * interruption. Same key and a DIFFERENT digest conflicts: neither side is
   * overwritten, because one of the two callers is wrong about what it asked
   * for and guessing which is how a counted artifact gets swapped underneath a
   * receipt.
   *
   * The in-flight admission is decided HERE, in the same closure as the append,
   * because two different requestIds share no caller-side lock: a bound checked
   * before this closure is a bound two concurrent admissions can both pass.
   */
  reserve(input: ReserveInput): Promise<ReserveOutcome> {
    return this.enqueue(async () => {
      this.assertOpen();
      const recordId = inputPreparationRecordId(input.key);
      const existing = this.records.get(recordId);
      if (existing) {
        if (existing.requestDigest !== input.requestDigest) throw new InputPreparationConflictError(recordId);
        return { kind: 'existing', record: existing } as const;
      }
      const createdAtMs = this.now();
      if (this.inFlightCount(createdAtMs) >= input.maxInFlight) {
        throw new InputPreparationLimitError(
          'in_flight_limit_exceeded',
          'this daemon has no remaining in-flight preparation allowance',
        );
      }
      const artifactExpiresAtMs = createdAtMs + this.options.retentionMs;
      const record: InputPreparationRecord = {
        format: INPUT_PREPARATION_RECORD_FORMAT,
        version: INPUT_PREPARATION_RECORD_VERSION,
        recordId,
        key: { ...input.key },
        requestDigest: input.requestDigest,
        state: 'reserved',
        binding: input.binding,
        model: input.model,
        artifactBytes: 0,
        counterCalls: 0,
        createdAt: new Date(createdAtMs).toISOString(),
        updatedAt: new Date(createdAtMs).toISOString(),
        artifactExpiresAt: new Date(artifactExpiresAtMs).toISOString(),
        recordExpiresAt: new Date(artifactExpiresAtMs + this.options.retryHorizonMs).toISOString(),
      };
      await this.append(record);
      return { kind: 'created', record } as const;
    });
  }

  /** Append one durable transition. Terminal records never transition again. */
  update(recordId: string, patch: RecordPatch): Promise<InputPreparationRecord> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = this.records.get(recordId);
      if (!current) throw new InputPreparationIntegrityError(`no input-preparation record ${recordId}`);
      if (isTerminalInputPreparationState(current.state) && patch.state !== undefined && patch.state !== current.state) {
        throw new InputPreparationIntegrityError(
          `input-preparation record ${recordId} is terminal in state ${current.state} and cannot transition to ${patch.state}`,
        );
      }
      const next: InputPreparationRecord = {
        ...current,
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.artifact === undefined ? {} : { artifact: patch.artifact }),
        ...(patch.counter === undefined ? {} : { counter: patch.counter }),
        ...(patch.artifactBytes === undefined ? {} : { artifactBytes: patch.artifactBytes }),
        ...(patch.counterCalls === undefined ? {} : { counterCalls: patch.counterCalls }),
        ...(patch.detail === undefined ? {} : { detail: patch.detail }),
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.append(next);
      return next;
    });
  }

  /**
   * Every read asserts the store is open, for one reason: an unopened store
   * and an empty store are indistinguishable from the in-memory map, and they
   * mean opposite things. `undefined` from an unopened store would read as "no
   * such record on this device" while the record sits durably on disk — which
   * is exactly how a restart turns a counted preparation into
   * `preparation_not_found`. Refusing is the only answer that cannot be
   * mistaken for an answer about the durable state.
   */
  get(recordId: string): InputPreparationRecord | undefined {
    this.assertOpen();
    return this.records.get(recordId);
  }

  find(key: InputPreparationRecordKey): InputPreparationRecord | undefined {
    this.assertOpen();
    return this.records.get(inputPreparationRecordId(key));
  }

  /** Every live record, for tests and for the aggregate below. */
  list(): readonly InputPreparationRecord[] {
    this.assertOpen();
    return [...this.records.values()];
  }

  /**
   * Retained bytes and consumed counter calls for one authenticated scope.
   *
   * Both survive restart because both are fields of the durable record, not
   * in-memory counters — which is exactly what stops a restart from becoming a
   * fresh counter-call allowance.
   */
  scopeUsage(scopeId: string): ScopeUsage {
    this.assertOpen();
    let artifactBytes = 0;
    let counterCalls = 0;
    let liveRecords = 0;
    for (const record of this.records.values()) {
      if (record.key.scopeId !== scopeId) continue;
      liveRecords += 1;
      artifactBytes += record.artifactBytes;
      counterCalls += record.counterCalls;
    }
    return { artifactBytes, counterCalls, liveRecords };
  }

  /**
   * Records that are neither terminal nor expired, across every scope.
   *
   * Expiry is part of the question, not a detail GC will get to eventually: a
   * `reserved` record whose owning run died holds no work, and letting it keep
   * a slot past its own record horizon would turn an abandoned key into a
   * permanent hole in the in-flight allowance.
   */
  inFlightCount(nowMs = this.now()): number {
    this.assertOpen();
    let count = 0;
    for (const record of this.records.values()) {
      if (isTerminalInputPreparationState(record.state)) continue;
      if (nowMs >= Date.parse(record.recordExpiresAt)) continue;
      count += 1;
    }
    return count;
  }

  private artifactPath(recordId: string): string {
    return path.join(this.artifactDir, `${recordId}.json`);
  }

  /**
   * Admit one counter call: check the caller's bounds, persist the immutable
   * artifact (fsynced, 0600, D verbatim) and durably reserve the call — all in
   * ONE serialized closure. The record moves to `counting`.
   *
   * Fusing the three is the point. Retained bytes and consumed counter calls
   * are per-SCOPE aggregates, so they are shared by requests that share nothing
   * else: different requestIds are different records, different keys and
   * different caller-side locks. Checking the aggregate anywhere but here would
   * be a read another admission can invalidate before the write lands, which is
   * exactly how two concurrent requests both pass a bound of one.
   *
   * The artifact is written after the bounds pass and before the record is
   * charged, so a refused admission leaves no retained bytes behind and a
   * charged record always has its artifact on disk.
   */
  commitCounterReservation(input: CounterReservationInput): Promise<InputPreparationRecord> {
    return this.commitArtifact(input, input.bounds.maxCounterCallsPerScope);
  }

  /**
   * Retain the artifact of a preparation that has NO counter configured and
   * settle it as `prepared` — the same serialized closure, the same retention
   * bound and the same fsynced write as {@link commitCounterReservation}, but
   * no counter call is reserved: `counterCalls` stays 0 and the scope's
   * counter-call allowance is neither read nor charged.
   */
  commitPreparedArtifact(input: ArtifactCommitInput): Promise<InputPreparationRecord> {
    return this.commitArtifact(input, undefined);
  }

  /**
   * The one retention closure behind both commits. `maxCounterCallsPerScope`
   * is present exactly when a counter call is being reserved; its absence is
   * what makes the transition land on `prepared` instead of `counting`.
   */
  private commitArtifact(
    input: ArtifactCommitInput,
    maxCounterCallsPerScope: number | undefined,
  ): Promise<InputPreparationRecord> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = this.records.get(input.recordId);
      if (!current) throw new InputPreparationIntegrityError(`no input-preparation record ${input.recordId}`);
      if (input.artifact.recordId !== input.recordId) {
        throw new InputPreparationIntegrityError(
          `prepared artifact ${input.artifact.recordId} does not belong to record ${input.recordId}`,
        );
      }
      if (isTerminalInputPreparationState(current.state)) {
        throw new InputPreparationIntegrityError(
          `input-preparation record ${input.recordId} is terminal in state ${current.state} and cannot retain an artifact`,
        );
      }
      const serialized = JSON.stringify(input.artifact);
      const artifactBytes = Buffer.byteLength(serialized, 'utf8');
      const usage = this.scopeUsage(current.key.scopeId);
      if (usage.artifactBytes + artifactBytes > input.bounds.maxScopeAggregateBytes) {
        throw new InputPreparationLimitError(
          'scope_aggregate_bytes_exceeded',
          'this scope has no remaining prepared-artifact byte allowance',
        );
      }
      if (maxCounterCallsPerScope !== undefined && usage.counterCalls + 1 > maxCounterCallsPerScope) {
        throw new InputPreparationLimitError(
          'counter_call_limit_exceeded',
          'this scope has no remaining counter-call allowance',
        );
      }
      try {
        await atomicWriteFile(this.artifactPath(input.artifact.recordId), serialized, { mode: 0o600, fsync: true });
      } catch (cause) {
        throw new InputPreparationDurabilityError('the prepared artifact could not be durably written', { cause });
      }
      const next: InputPreparationRecord = {
        ...current,
        state: maxCounterCallsPerScope === undefined ? 'prepared' : 'counting',
        artifact: input.summary,
        requestContentTextOnly: input.requestContentTextOnly,
        artifactBytes,
        counterCalls: maxCounterCallsPerScope === undefined ? 0 : 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.append(next);
      return next;
    });
  }

  /**
   * The absolute path of one record's retained artifact.
   *
   * Exposed because a prepared Execution is handed a PATH, not bytes: the
   * artifact carries D, P(D) and the whole native envelope, and there is
   * exactly one retained copy of it. A second inline representation crossing to
   * the adapter would be a second authority over the same bytes. Deriving the
   * path anywhere else would be a second authority over the layout instead.
   */
  artifactPathOf(record: InputPreparationRecord): string {
    return this.artifactPath(record.recordId);
  }

  /**
   * Bind one committed Execution to this record, or report that another one
   * already did.
   *
   * A compare-and-set, inside the same serialized closure as the append, for
   * the same reason every other admission in this file is: two runners racing
   * the same reference share no caller-side lock, so a `pin === undefined`
   * check made before this closure is a check both of them pass. The loser gets
   * `occupied` with the pin that won, and its caller sends zero claim and
   * dispatches nothing.
   *
   * Idempotent for the SAME Execution: a replay that re-presents the identical
   * taskId and manifest digest reads back `pinned` with the record it already
   * has, because re-deriving the same seal is not a second consumer. A
   * different taskId, or the same taskId with a different sealed manifest, is
   * `occupied` — it is a different Execution.
   *
   * Only a `prepared` record with a retained artifact may be pinned: a pin on a
   * record that has no artifact would keep a tombstone alive forever without
   * ever being launchable.
   */
  pin(recordId: string, pin: InputPreparationPinV1): Promise<PinOutcome> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = this.records.get(recordId);
      if (!current) throw new InputPreparationIntegrityError(`no input-preparation record ${recordId}`);
      if (current.state !== 'prepared' || current.artifact === undefined || current.artifactBytes === 0) {
        throw new InputPreparationIntegrityError(
          `input-preparation record ${recordId} is in state ${current.state} with no retained artifact and cannot be pinned`,
        );
      }
      const existing = current.pin;
      if (existing !== undefined) {
        const same = existing.taskId === pin.taskId && existing.manifestDigest === pin.manifestDigest;
        if (!same) return { kind: 'occupied', record: current } as const;
        return { kind: 'pinned', record: current } as const;
      }
      const next: InputPreparationRecord = { ...current, pin, updatedAt: new Date(this.now()).toISOString() };
      await this.append(next);
      return { kind: 'pinned', record: next } as const;
    });
  }

  /**
   * Release the pin this Execution holds.
   *
   * Scoped to the holder on purpose: `taskId` must match, so a task cannot
   * release a record another Execution consumed. Releasing a record that is
   * already unpinned is not an error — the pin's job is done either way, and a
   * terminal path that had to know whether it ever pinned would grow a second
   * answer to a question the record already holds.
   *
   * WHEN a pin is released is a single rule: the Execution reached a terminal.
   * Not at claim, not at start, not when the session closes — a record stays
   * pinned for exactly as long as the Execution that consumed it can still be
   * running, which is also exactly as long as GC must not collect it.
   */
  unpin(recordId: string, taskId: string): Promise<InputPreparationRecord> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = this.records.get(recordId);
      if (!current) throw new InputPreparationIntegrityError(`no input-preparation record ${recordId}`);
      if (current.pin === undefined) return current;
      if (current.pin.taskId !== taskId) {
        throw new InputPreparationIntegrityError(
          `input-preparation record ${recordId} is pinned by task ${current.pin.taskId} and cannot be released by ${taskId}`,
        );
      }
      const { pin: _released, ...rest } = current;
      const next: InputPreparationRecord = { ...rest, updatedAt: new Date(this.now()).toISOString() };
      await this.append(next);
      return next;
    });
  }

  /**
   * Read the artifact back and re-check the identity it claims.
   *
   * The digest comparison is integrity, not authorization: authority was
   * already resolved before the caller reached this method.
   */
  async readArtifact(record: InputPreparationRecord): Promise<InputPreparationArtifact | undefined> {
    this.assertOpen();
    let raw: string;
    try {
      raw = await fs.readFile(this.artifactPath(record.recordId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: InputPreparationArtifact;
    try {
      parsed = JSON.parse(raw) as InputPreparationArtifact;
    } catch (cause) {
      throw new InputPreparationIntegrityError(
        `prepared artifact ${record.recordId} is not readable JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (parsed.format !== INPUT_PREPARATION_ARTIFACT_FORMAT || parsed.version !== INPUT_PREPARATION_VERSION) {
      throw new InputPreparationIntegrityError(`prepared artifact ${record.recordId} has an unknown format or version`);
    }
    if (parsed.recordId !== record.recordId || parsed.requestDigest !== record.artifact?.requestDigest) {
      throw new InputPreparationIntegrityError(`prepared artifact ${record.recordId} does not match its record binding`);
    }
    return parsed;
  }

  /**
   * Drop expired artifacts and, one retry horizon later, expired records.
   *
   * A pinned record is never collected — not its artifact and not its
   * tombstone. That is what makes a pin meaningful: the Execution holding it
   * has not reached a terminal yet, so the bytes it is about to send (or is
   * sending) must still be on disk, whatever the retention horizon says. The
   * horizon resumes the moment `unpin` lands.
   */
  gc(nowMs = this.now(), preserveInFlight = false): Promise<{ artifactsRemoved: number; recordsRemoved: number }> {
    return this.enqueue(async () => {
      this.assertOpen();
      let artifactsRemoved = 0;
      const survivors: InputPreparationRecord[] = [];
      const removedIds: string[] = [];
      for (const record of this.records.values()) {
        if (record.pin !== undefined || (preserveInFlight && !isTerminalInputPreparationState(record.state))) {
          survivors.push(record);
          continue;
        }
        if (nowMs >= Date.parse(record.recordExpiresAt)) {
          removedIds.push(record.recordId);
          continue;
        }
        if (record.artifactBytes > 0 && nowMs >= Date.parse(record.artifactExpiresAt)) {
          await fs.rm(this.artifactPath(record.recordId), { force: true });
          artifactsRemoved += 1;
          survivors.push({ ...record, artifactBytes: 0, updatedAt: new Date(nowMs).toISOString() });
          continue;
        }
        survivors.push(record);
      }
      for (const recordId of removedIds) {
        await fs.rm(this.artifactPath(recordId), { force: true });
      }
      if (artifactsRemoved === 0 && removedIds.length === 0) return { artifactsRemoved: 0, recordsRemoved: 0 };
      try {
        // One rewrite publishes both the expiries and the compaction: the log
        // is a history, and GC is the only thing allowed to forget part of it.
        await this.log.replace(survivors.map((record) => JSON.stringify(record)));
      } catch (cause) {
        throw new InputPreparationDurabilityError('the input-preparation record log could not be durably compacted', { cause });
      }
      this.records = new Map(survivors.map((record) => [record.recordId, record]));
      return { artifactsRemoved, recordsRemoved: removedIds.length };
    });
  }
}
