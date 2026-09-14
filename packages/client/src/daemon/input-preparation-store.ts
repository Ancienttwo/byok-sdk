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
  type InputPreparationPinV1,
  type InputPreparationStateV1,
} from '../input-preparation';

/**
 * Durable request / receipt / artifact persistence for the B-P2 local
 * primitive (`docs/researches/runtime-input-preparation-contract.md` §10.3.5,
 * §10.3.6, §10.3.8).
 *
 * One durable namespace, `(authenticated scope, Agent, preparation requestId)`,
 * bound to the entire normalized request digest. This file owns exactly that
 * namespace plus the retained artifact bytes; it owns no policy decision, no
 * authority resolution and no counter call. Everything above it is
 * `input-preparation-service.ts`.
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

/** The durable idempotency key. Never a task id, and never caller-asserted: `scopeId` comes from the trusted authority grant. */
export interface InputPreparationRecordKey {
  readonly scopeId: string;
  readonly agentRef: string;
  readonly requestId: string;
}

export interface InputPreparationRecord {
  readonly format: typeof INPUT_PREPARATION_RECORD_FORMAT;
  readonly version: typeof INPUT_PREPARATION_VERSION;
  readonly recordId: string;
  readonly key: InputPreparationRecordKey;
  /** Digest over the whole normalized request, scope and runtime identity. */
  readonly requestDigest: string;
  readonly state: InputPreparationStateV1;
  readonly binding: InputPreparationBindingV1;
  readonly artifact?: InputPreparationArtifactSummaryV1;
  readonly counter?: InputPreparationCounterEvidenceV1;
  /** Retained bytes attributable to this record, counted against the per-scope aggregate. */
  readonly artifactBytes: number;
  /** Counter invocations this record has consumed. Never decremented. */
  readonly counterCalls: number;
  /** Stable code on a terminal non-`counted` state; never provider or stack text. */
  readonly detail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly artifactExpiresAt: string;
  readonly recordExpiresAt: string;
  /** Reserved for G3b. This package never writes it. */
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
  readonly coverage: string;
  /** The native envelope, retained verbatim so a later consumer re-verifies rather than recompiles. */
  readonly envelope: unknown;
}

/** Terminal states never transition again. */
const TERMINAL_STATES: ReadonlySet<InputPreparationStateV1> = new Set<InputPreparationStateV1>([
  'counted',
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

/** The stored record or artifact does not match what was persisted. */
export class InputPreparationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputPreparationIntegrityError';
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
}

export type ReserveOutcome =
  | { readonly kind: 'created'; readonly record: InputPreparationRecord }
  | { readonly kind: 'existing'; readonly record: InputPreparationRecord };

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
      if (record.format !== INPUT_PREPARATION_RECORD_FORMAT || record.version !== INPUT_PREPARATION_VERSION) {
        throw new InputPreparationIntegrityError('the input-preparation record log contains an unknown record format or version');
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
      const artifactExpiresAtMs = createdAtMs + this.options.retentionMs;
      const record: InputPreparationRecord = {
        format: INPUT_PREPARATION_RECORD_FORMAT,
        version: INPUT_PREPARATION_VERSION,
        recordId,
        key: { ...input.key },
        requestDigest: input.requestDigest,
        state: 'reserved',
        binding: input.binding,
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

  get(recordId: string): InputPreparationRecord | undefined {
    return this.records.get(recordId);
  }

  find(key: InputPreparationRecordKey): InputPreparationRecord | undefined {
    return this.records.get(inputPreparationRecordId(key));
  }

  /** Every live record, for tests and for the aggregate below. */
  list(): readonly InputPreparationRecord[] {
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

  /** Records that are neither terminal nor expired, across every scope. */
  inFlightCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (!isTerminalInputPreparationState(record.state)) count += 1;
    }
    return count;
  }

  private artifactPath(recordId: string): string {
    return path.join(this.artifactDir, `${recordId}.json`);
  }

  /** Persist the immutable artifact, fsynced, 0600. D is stored verbatim. */
  putArtifact(artifact: InputPreparationArtifact): Promise<number> {
    return this.enqueue(async () => {
      this.assertOpen();
      const serialized = JSON.stringify(artifact);
      try {
        await atomicWriteFile(this.artifactPath(artifact.recordId), serialized, { mode: 0o600, fsync: true });
      } catch (cause) {
        throw new InputPreparationDurabilityError('the prepared artifact could not be durably written', { cause });
      }
      return Buffer.byteLength(serialized, 'utf8');
    });
  }

  /**
   * Read the artifact back and re-check the identity it claims.
   *
   * The digest comparison is integrity, not authorization: authority was
   * already resolved before the caller reached this method.
   */
  async readArtifact(record: InputPreparationRecord): Promise<InputPreparationArtifact | undefined> {
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
   * A pinned record is never collected. Nothing in this package pins today, so
   * the guard is the shape §10.3.7 requires rather than live behavior — but it
   * is enforced here, not deferred, so G3b cannot introduce a GC race by
   * forgetting it.
   */
  gc(nowMs = this.now()): Promise<{ artifactsRemoved: number; recordsRemoved: number }> {
    return this.enqueue(async () => {
      this.assertOpen();
      let artifactsRemoved = 0;
      const survivors: InputPreparationRecord[] = [];
      const removedIds: string[] = [];
      for (const record of this.records.values()) {
        if (record.pin !== undefined) {
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
