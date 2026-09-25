import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InputPreparationConflictError,
  InputPreparationDurabilityError,
  InputPreparationIntegrityError,
  InputPreparationLimitError,
  InputPreparationStore,
  InputPreparationUnsupportedRecordVersionError,
  INPUT_PREPARATION_RECORD_VERSION,
  inputPreparationRecordId,
  type CounterReservationInput,
  type InputPreparationArtifact,
  type InputPreparationRecordKey,
  type ReserveInput,
} from '../daemon/input-preparation-store';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_RECORD_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationArtifactSummaryV1,
  type InputPreparationBindingV1,
  type InputPreparationModelV1,
} from '../input-preparation';

/**
 * B-P2 §10.5 "Artifact equality/drift" and the durability half of
 * "Durability/idempotency", against the real durable primitives — a real
 * `DurableJsonlFile` log and real `atomicWriteFile` artifacts on a real
 * temporary filesystem. Nothing here is mocked, because the property under
 * test IS what survives a process boundary.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tmpStoreDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-input-prep-store-'));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function key(overrides: Partial<InputPreparationRecordKey> = {}): InputPreparationRecordKey {
  return { scopeId: 'scope-a', agentRef: 'agent-1', requestId: 'req-1', ...overrides };
}

function binding(overrides: Partial<InputPreparationBindingV1> = {}): InputPreparationBindingV1 {
  return {
    scopeId: 'scope-a',
    deviceId: 'device-1',
    agentRef: 'agent-1',
    profileId: 'profile-1',
    profileRevision: 'profile-rev-1',
    source: { revision: 'src-rev-1', digest: 'src-digest-1' },
    target: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
    policyRevision: 'policy-1',
    permissionMode: 'auto',
    runtime: {
      packageName: '@byok-sdk/pi-coding-agent',
      packageVersion: '0.85.1001',
      tarballIntegrity: 'sha512-'+ 'YQ=='.repeat(1),
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
      envelopeFormat: 'pi.session.prepared-input',
      requestFormat: 'pi.openai-completions.prepared',
      compilerVersion: 2,
    },
    requestDigest: 'digest-1',
    ...overrides,
  };
}

const MODEL: InputPreparationModelV1 = {
  id: 'glm-4.6',
  name: 'GLM 4.6',
  api: 'openai-completions',
  provider: 'zai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

/** D is deliberately awkward: multi-byte, embedded quotes and a lone newline. */
const REQUEST_BODY = '{"model":"glm-4.6","messages":[{"role":"user","content":"héllo \\"world\\"\\nsecond line — ✅"}]}';

function artifact(recordId: string, overrides: Partial<InputPreparationArtifact> = {}): InputPreparationArtifact {
  return {
    format: INPUT_PREPARATION_ARTIFACT_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    recordId,
    requestDigest: 'artifact-digest-1',
    envelopeDigest: 'envelope-digest-1',
    toolManifestDigest: 'manifest-digest-1',
    requestBody: REQUEST_BODY,
    counterProjection: '{"model":"glm-4.6"}',
    projection: { version: 3, kind: 'content_complete', digest: 'a'.repeat(64) },
    residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
    envelope: { format: 'pi.session.prepared-input', version: 3 },
    ...overrides,
  };
}

const SUMMARY: InputPreparationArtifactSummaryV1 = {
  requestDigest: 'artifact-digest-1',
  envelopeDigest: 'envelope-digest-1',
  toolManifestDigest: 'manifest-digest-1',
  requestBytes: Buffer.byteLength(REQUEST_BODY, 'utf8'),
  projectionBytes: 19,
  projection: { version: 3, kind: 'content_complete', digest: 'a'.repeat(64) },
  residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
  observationDigest: 'observation-digest-1',
  toolBindingDigest: 'tool-binding-digest-1',
  toolImplementationKinds: { mcp__team__list: 'unavailable:resolver_unconfigured' },
};

/** A reservation with bounds far above anything these durability tests write. */
function reserve(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return { key: key(), requestDigest: 'digest-1', binding: binding(), model: MODEL, maxInFlight: 100, ...overrides };
}

/** One counter reservation: the artifact write and the charge, as the store fuses them. */
function commit(recordId: string, overrides: Partial<CounterReservationInput> = {}): CounterReservationInput {
  return {
    recordId,
    artifact: artifact(recordId),
    summary: SUMMARY,
    requestContentTextOnly: true,
    bounds: { maxScopeAggregateBytes: 10_000_000, maxCounterCallsPerScope: 100 },
    ...overrides,
  };
}

/** Every file under the store subtree with its size, so "no other files touched" is checkable. */
async function inventory(storeDir: string): Promise<Record<string, number>> {
  const root = path.join(storeDir, 'input-preparation');
  const out: Record<string, number> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = (await fs.stat(full)).size;
    }
  };
  await walk(root);
  return out;
}

async function openStore(storeDir: string, options: { retentionMs?: number; retryHorizonMs?: number; now?: () => number } = {}): Promise<InputPreparationStore> {
  const store = new InputPreparationStore({
    storeDir,
    retentionMs: options.retentionMs ?? 60_000,
    retryHorizonMs: options.retryHorizonMs ?? 30_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await store.open();
  return store;
}

describe('B-P2 store: idempotency namespace', () => {
  it('reserves once, returns the same record for the same digest, and conflicts on a different one', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);

    const created = await store.reserve(reserve());
    expect(created.kind).toBe('created');
    expect(created.record.state).toBe('reserved');
    expect(created.record.counterCalls).toBe(0);

    const again = await store.reserve(reserve());
    expect(again.kind).toBe('existing');
    expect(again.record.recordId).toBe(created.record.recordId);

    await expect(store.reserve(reserve({ requestDigest: 'digest-2' }))).rejects.toBeInstanceOf(
      InputPreparationConflictError,
    );
  });

  it('keys by scope, so the same requestId in two scopes is two records', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);

    const a = await store.reserve(reserve({ requestDigest: 'digest-a' }));
    const b = await store.reserve(
      reserve({ key: key({ scopeId: 'scope-b' }), requestDigest: 'digest-b', binding: binding({ scopeId: 'scope-b' }) }),
    );
    expect(a.record.recordId).not.toBe(b.record.recordId);
    // And one scope's key never resolves in the other scope.
    expect(store.find(key({ scopeId: 'scope-c' }))).toBeUndefined();
  });

  it('refuses to transition a terminal record', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    await store.update(created.record.recordId, { state: 'counter_interrupted', detail: 'counter_outcome_unknown' });
    await expect(store.update(created.record.recordId, { state: 'prepared' })).rejects.toBeInstanceOf(
      InputPreparationIntegrityError,
    );
  });
});

describe('B-P2 store: restart roundtrip', () => {
  it('preserves D byte-for-byte and every persisted fact across a fresh store instance', async () => {
    const storeDir = await tmpStoreDir();
    const first = await openStore(storeDir);
    const created = await first.reserve(reserve());
    const bytes = (await first.commitCounterReservation(commit(created.record.recordId))).artifactBytes;

    // A genuinely separate instance: nothing in memory carries over.
    const restarted = await openStore(storeDir);
    const record = restarted.find(key());
    expect(record?.state).toBe('counting');
    expect(record?.counterCalls).toBe(1);
    expect(record?.artifactBytes).toBe(bytes);
    expect(record?.binding.runtime.upstreamCommit).toBe('d981de1229ef899957bbe968bc8dcda02a21f477');

    const readBack = await restarted.readArtifact(record!);
    expect(readBack?.requestBody).toBe(REQUEST_BODY);
    expect(Buffer.from(readBack!.requestBody, 'utf8').equals(Buffer.from(REQUEST_BODY, 'utf8'))).toBe(true);
    expect(readBack?.projection).toEqual({ version: 3, kind: 'content_complete', digest: 'a'.repeat(64) });
    expect(readBack?.residual).toEqual([{ key: 'max_tokens', valueClass: 'bounded_integer' }]);
  });

  it('rejects an artifact whose stored identity drifted from its record binding', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    const record = await store.commitCounterReservation(commit(created.record.recordId));

    // Mutate the retained bytes behind the store's back. An artifact that no
    // longer proves the identity its receipt published is not usable evidence.
    const artifactPath = path.join(storeDir, 'input-preparation', 'artifacts', `${created.record.recordId}.json`);
    const stored = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as InputPreparationArtifact;
    await fs.writeFile(artifactPath, JSON.stringify({ ...stored, requestDigest: 'tampered' }), 'utf8');

    await expect(store.readArtifact(record)).rejects.toBeInstanceOf(InputPreparationIntegrityError);
  });

  it('refuses to replay a record log that is not intact', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    await store.reserve(reserve());

    const logPath = path.join(storeDir, 'input-preparation', 'records.jsonl');
    await fs.appendFile(logPath, '{"format":"byok.input-preparation.record"\n', 'utf8');

    const restarted = new InputPreparationStore({ storeDir, retentionMs: 60_000, retryHorizonMs: 30_000 });
    await expect(restarted.open()).rejects.toBeInstanceOf(InputPreparationIntegrityError);
  });

  it('refuses a version-5 `counted` record with a typed error — the bounded-admission cut has no dual read', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    await store.commitCounterReservation(commit(created.record.recordId));

    // A record exactly as version 5 wrote it: the retired `counted` terminal
    // state, counter evidence with the retired `kind`, and no
    // `requestContentTextOnly` fact. It is not translated into `prepared`.
    const logPath = path.join(storeDir, 'input-preparation', 'records.jsonl');
    const recorded = store.get(created.record.recordId)!;
    const { requestContentTextOnly: _textOnly, ...withoutTextOnly } = recorded;
    await fs.writeFile(
      logPath,
      `${JSON.stringify({
        ...withoutTextOnly,
        format: INPUT_PREPARATION_RECORD_FORMAT,
        version: 5,
        state: 'counted',
        counter: {
          method: 'fixture.tokenizer',
          methodVersion: '0',
          authority: 'provider',
          kind: 'count',
          value: 7,
          coverage: { covered: true },
          providerEvidence: {
            projectionDigest: 'a'.repeat(64),
            endpoint: 'https://api.z.ai/api/coding/paas/v4',
            modelId: 'glm-4.6',
            asserted: { httpStatus: 200, usageFields: { prompt_tokens: 7 }, responseDigest: 'e'.repeat(64) },
          },
          target: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
          calledAt: '2026-09-01T00:00:00.000Z',
          completedAt: '2026-09-01T00:00:01.000Z',
        },
      })}\n`,
      'utf8',
    );
    const before = await fs.readFile(logPath);

    const restarted = new InputPreparationStore({ storeDir, retentionMs: 60_000, retryHorizonMs: 30_000 });
    const refusal = await restarted.open().then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(InputPreparationUnsupportedRecordVersionError);
    expect((refusal as InputPreparationUnsupportedRecordVersionError).reason).toBe('unsupported_record_version');
    expect((refusal as InputPreparationUnsupportedRecordVersionError).recordVersion).toBe(5);
    // It names the exact log an operator archives to re-enable the lane.
    expect((refusal as InputPreparationUnsupportedRecordVersionError).logPath).toBe(logPath);
    expect((refusal as Error).message).toContain(logPath);
    expect(await fs.readFile(logPath)).toEqual(before);
    expect(() => restarted.list()).toThrow(InputPreparationDurabilityError);
  });

  it('refuses a record written at an older record schema version, and leaves every byte of the store where it found it', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    await store.commitCounterReservation(commit(created.record.recordId));

    // A record exactly as version 3 wrote it: its artifact summary carries the
    // opaque `coverage` label, because the structural projection contract
    // became the recorded fact only at version 4. Nothing can honestly decide
    // what that label meant about P(D), which is why the refusal below is the
    // only correct answer.
    const logPath = path.join(storeDir, 'input-preparation', 'records.jsonl');
    const recorded = store.get(created.record.recordId)!;
    const { projection: _projection, residual: _residual, ...summaryWithoutProjection } = recorded.artifact!;
    await fs.writeFile(
      logPath,
      `${JSON.stringify({
        ...recorded,
        format: INPUT_PREPARATION_RECORD_FORMAT,
        version: 3,
        artifact: { ...summaryWithoutProjection, coverage: 'unknown' },
      })}\n`,
      'utf8',
    );
    const before = await fs.readFile(logPath);
    const treeBefore = await inventory(storeDir);

    const restarted = new InputPreparationStore({ storeDir, retentionMs: 60_000, retryHorizonMs: 30_000 });
    const refusal = await restarted.open().then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(InputPreparationUnsupportedRecordVersionError);
    expect((refusal as InputPreparationUnsupportedRecordVersionError).reason).toBe('unsupported_record_version');
    const message = (refusal as Error).message;
    expect(message).toContain('unsupported older version');
    expect(message).toContain('pending explicit operator disposition');
    // The refusal must never advise an operator to destroy durable evidence:
    // the record may be the only proof of a counter call that already happened.
    expect(message).not.toMatch(/remove|delete|start clean|wipe/iu);

    // Zero writes and zero cleanup: the log is byte-identical and no file in
    // the subtree was added, dropped or resized.
    expect(await fs.readFile(logPath)).toEqual(before);
    expect(await inventory(storeDir)).toEqual(treeBefore);
    // And the store stayed closed, so nothing can mistake it for an empty one.
    expect(() => restarted.list()).toThrow(InputPreparationDurabilityError);
  });

  it('stamps the record schema version, which is independent of the wire version', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());

    expect(created.record.version).toBe(INPUT_PREPARATION_RECORD_VERSION);
    expect(INPUT_PREPARATION_RECORD_VERSION).toBe(7);
    // The wire version is a different agreement, moved by a different reason.
    expect(INPUT_PREPARATION_VERSION).toBe(7);
    expect((await openStore(storeDir)).get(created.record.recordId)?.version).toBe(INPUT_PREPARATION_RECORD_VERSION);
  });
});

describe('B-P2 store: durable-write ambiguity', () => {
  it('surfaces a real append failure as a durability error, quarantines the log, and recovers only on explicit revalidation', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());

    // A real I/O fault, not a stubbed throw: the append opens the log
    // O_APPEND|O_WRONLY, so a read-only log makes the write genuinely fail and
    // `DurableJsonlFile` genuinely latch.
    const logPath = path.join(storeDir, 'input-preparation', 'records.jsonl');
    await fs.chmod(logPath, 0o400);
    await expect(store.update(created.record.recordId, { state: 'counting' })).rejects.toBeInstanceOf(
      InputPreparationDurabilityError,
    );
    // The in-memory record must NOT have advanced: an uncertain write is not a
    // write, and a receipt built off it would be a false success.
    expect(store.get(created.record.recordId)?.state).toBe('reserved');

    // The latch holds even once the underlying fault is gone — durability
    // ambiguity is an error until the record log is revalidated.
    await fs.chmod(logPath, 0o600);
    await expect(store.update(created.record.recordId, { state: 'counting' })).rejects.toBeInstanceOf(
      InputPreparationDurabilityError,
    );

    await store.revalidate();
    const updated = await store.update(created.record.recordId, { state: 'counting' });
    expect(updated.state).toBe('counting');
    // Revalidation re-read the log rather than trusting memory.
    expect((await openStore(storeDir)).find(key())?.state).toBe('counting');
  });

  it('surfaces a real artifact write failure as a durability error and retains no partial artifact', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());

    const artifactDir = path.join(storeDir, 'input-preparation', 'artifacts');
    await fs.chmod(artifactDir, 0o500);
    try {
      await expect(store.commitCounterReservation(commit(created.record.recordId))).rejects.toBeInstanceOf(
        InputPreparationDurabilityError,
      );
    } finally {
      await fs.chmod(artifactDir, 0o700);
    }
    expect(await fs.readdir(artifactDir)).toEqual([]);
    // The charge belongs to the artifact: an artifact that was not retained
    // must not have spent the scope's bytes or its counter-call allowance.
    expect(store.get(created.record.recordId)?.state).toBe('reserved');
    expect(store.scopeUsage('scope-a')).toEqual({ artifactBytes: 0, counterCalls: 0, liveRecords: 1 });
  });
});

describe('B-P2 store: policy accounting and retention', () => {
  it('aggregates retained bytes and consumed counter calls per scope, and both survive restart', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    for (const requestId of ['req-1', 'req-2']) {
      const created = await store.reserve(reserve({ key: key({ requestId }), requestDigest: `digest-${requestId}` }));
      await store.update(created.record.recordId, { state: 'counting', artifactBytes: 100, counterCalls: 1 });
    }
    const other = await store.reserve(
      reserve({
        key: key({ scopeId: 'scope-b', requestId: 'req-3' }),
        requestDigest: 'digest-other',
        binding: binding({ scopeId: 'scope-b' }),
      }),
    );
    await store.update(other.record.recordId, { state: 'counting', artifactBytes: 5_000, counterCalls: 1 });

    const restarted = await openStore(storeDir);
    expect(restarted.scopeUsage('scope-a')).toEqual({ artifactBytes: 200, counterCalls: 2, liveRecords: 2 });
    expect(restarted.scopeUsage('scope-b')).toEqual({ artifactBytes: 5_000, counterCalls: 1, liveRecords: 1 });
    // Non-terminal records are the in-flight set.
    expect(restarted.inFlightCount()).toBe(3);
  });

  it('drops the artifact at retention, keeps the tombstone for the whole retry horizon, then collects it', async () => {
    const storeDir = await tmpStoreDir();
    let clock = 1_000_000;
    const store = await openStore(storeDir, { retentionMs: 10_000, retryHorizonMs: 20_000, now: () => clock });
    const created = await store.reserve(reserve());
    await store.commitCounterReservation(commit(created.record.recordId));
    await store.update(created.record.recordId, { state: 'prepared' });

    const artifactPath = path.join(storeDir, 'input-preparation', 'artifacts', `${created.record.recordId}.json`);
    await expect(fs.stat(artifactPath)).resolves.toBeTruthy();

    // Just after the artifact horizon: the bytes go, the record stays. An
    // expired key that still has a record can never read as a fresh call.
    clock += 10_001;
    expect(await store.gc()).toEqual({ artifactsRemoved: 1, recordsRemoved: 0 });
    await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const tombstone = store.find(key());
    expect(tombstone?.state).toBe('prepared');
    expect(tombstone?.counterCalls).toBe(1);
    expect(tombstone?.artifactBytes).toBe(0);
    expect(store.scopeUsage('scope-a').counterCalls).toBe(1);

    // Still inside the retry horizon: the tombstone is still the answer.
    clock += 19_000;
    expect(await store.gc()).toEqual({ artifactsRemoved: 0, recordsRemoved: 0 });
    expect(store.find(key())).toBeDefined();

    // Past it: the record is collected, and the compaction survives restart.
    clock += 2_000;
    expect(await store.gc()).toEqual({ artifactsRemoved: 0, recordsRemoved: 1 });
    expect(store.find(key())).toBeUndefined();
    const restarted = await openStore(storeDir, { retentionMs: 10_000, retryHorizonMs: 20_000, now: () => clock });
    expect(restarted.find(key())).toBeUndefined();
    expect(restarted.list()).toEqual([]);
  });

  it('stops counting an abandoned reservation against the in-flight budget once its record horizon passes', async () => {
    const storeDir = await tmpStoreDir();
    let clock = 1_000_000;
    const store = await openStore(storeDir, { retentionMs: 10_000, retryHorizonMs: 20_000, now: () => clock });
    await store.reserve(reserve());
    expect(store.inFlightCount()).toBe(1);

    // Still inside the horizon: the abandoned `reserved` record is real work as
    // far as anyone knows.
    clock += 29_000;
    expect(store.inFlightCount()).toBe(1);

    // Past its own record horizon: nothing can resume it, so it holds no slot.
    clock += 2_000;
    expect(store.inFlightCount()).toBe(0);
    // And the record itself is still there until GC runs — expiry is the
    // question the budget asks, not a thing GC has to have done first.
    expect(store.find(key())).toBeDefined();
  });

  it('admits at most the in-flight bound, even for reservations raced against each other', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const outcomes = await Promise.allSettled([
      store.reserve(reserve({ key: key({ requestId: 'req-a' }), requestDigest: 'digest-a', maxInFlight: 1 })),
      store.reserve(reserve({ key: key({ requestId: 'req-b' }), requestDigest: 'digest-b', maxInFlight: 1 })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(InputPreparationLimitError);
    expect(((rejected as PromiseRejectedResult).reason as InputPreparationLimitError).detail).toBe(
      'in_flight_limit_exceeded',
    );
    expect(store.inFlightCount()).toBe(1);
  });

  it('charges at most the counter-call bound, even for reservations raced against each other', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const a = await store.reserve(reserve({ key: key({ requestId: 'req-a' }), requestDigest: 'digest-a' }));
    const b = await store.reserve(reserve({ key: key({ requestId: 'req-b' }), requestDigest: 'digest-b' }));
    const bounds = { maxScopeAggregateBytes: 10_000_000, maxCounterCallsPerScope: 1 } as const;

    const outcomes = await Promise.allSettled([
      store.commitCounterReservation(commit(a.record.recordId, { bounds })),
      store.commitCounterReservation(commit(b.record.recordId, { bounds })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(((rejected as PromiseRejectedResult).reason as InputPreparationLimitError).detail).toBe(
      'counter_call_limit_exceeded',
    );
    expect(store.scopeUsage('scope-a').counterCalls).toBe(1);
  });

  it('never collects a pinned record, and collects it again once the pin is released', async () => {
    const storeDir = await tmpStoreDir();
    let clock = 1_000_000;
    const store = await openStore(storeDir, { retentionMs: 10_000, retryHorizonMs: 1_000, now: () => clock });
    const created = await store.reserve(reserve());
    await store.commitCounterReservation(commit(created.record.recordId));
    await store.update(created.record.recordId, { state: 'prepared' });
    await store.pin(created.record.recordId, { taskId: 't-1', manifestDigest: 'm-1', sealedAt: new Date(clock).toISOString() });

    // Long past both horizons: the pin, not the clock, is what keeps the record
    // and its retained bytes alive.
    const restarted = await openStore(storeDir, { retentionMs: 10_000, retryHorizonMs: 1_000, now: () => clock });
    clock += 1_000_000;
    expect(await restarted.gc()).toEqual({ artifactsRemoved: 0, recordsRemoved: 0 });
    expect(restarted.find(key())?.pin?.taskId).toBe('t-1');

    await restarted.unpin(created.record.recordId, 't-1');
    expect(await restarted.gc()).toEqual({ artifactsRemoved: 0, recordsRemoved: 1 });
    expect(restarted.find(key())).toBeUndefined();
  });

  it('admits exactly one of two Executions racing the same record, and tells the loser who won', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    await store.commitCounterReservation(commit(created.record.recordId));
    await store.update(created.record.recordId, { state: 'prepared' });

    const at = new Date().toISOString();
    const outcomes = await Promise.all([
      store.pin(created.record.recordId, { taskId: 'task-left', manifestDigest: 'manifest-left', sealedAt: at }),
      store.pin(created.record.recordId, { taskId: 'task-right', manifestDigest: 'manifest-right', sealedAt: at }),
    ]);

    expect(outcomes.filter((outcome) => outcome.kind === 'pinned')).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.kind === 'occupied');
    expect(loser).toBeDefined();
    // The loser learns WHICH Execution holds the record, not merely that one does.
    expect(loser!.record.pin?.taskId).toBe(store.get(created.record.recordId)?.pin?.taskId);
    expect(['task-left', 'task-right']).toContain(store.get(created.record.recordId)?.pin?.taskId);
  });

  it('reads back the same pin for a replay of the same Execution, and refuses a different seal of the same task', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    await store.commitCounterReservation(commit(created.record.recordId));
    await store.update(created.record.recordId, { state: 'prepared' });
    const pin = { taskId: 'task-1', manifestDigest: 'manifest-1', sealedAt: new Date().toISOString() } as const;

    expect((await store.pin(created.record.recordId, pin)).kind).toBe('pinned');
    expect((await store.pin(created.record.recordId, pin)).kind).toBe('pinned');
    expect((await store.pin(created.record.recordId, { ...pin, manifestDigest: 'manifest-2' })).kind).toBe('occupied');
  });

  it('refuses to pin a record that retains no artifact, and refuses a release by a task that does not hold the pin', async () => {
    const storeDir = await tmpStoreDir();
    const store = await openStore(storeDir);
    const created = await store.reserve(reserve());
    await expect(store.pin(created.record.recordId, { taskId: 't', manifestDigest: 'm', sealedAt: new Date().toISOString() }))
      .rejects.toBeInstanceOf(InputPreparationIntegrityError);

    await store.commitCounterReservation(commit(created.record.recordId));
    await store.update(created.record.recordId, { state: 'prepared' });
    await store.pin(created.record.recordId, { taskId: 'holder', manifestDigest: 'm', sealedAt: new Date().toISOString() });
    await expect(store.unpin(created.record.recordId, 'someone-else')).rejects.toBeInstanceOf(InputPreparationIntegrityError);
    expect(store.get(created.record.recordId)?.pin?.taskId).toBe('holder');

    // Releasing a record nobody pinned is not an error: the pin's job is done either way.
    const second = await store.reserve(reserve({ key: key({ requestId: 'req-unpinned' }), requestDigest: 'digest-unpinned' }));
    expect((await store.unpin(second.record.recordId, 'holder')).pin).toBeUndefined();
  });
});

describe('B-P2 store: record identity', () => {
  it('derives the record id from the whole key and nothing else', () => {
    const base = inputPreparationRecordId(key());
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(inputPreparationRecordId(key())).toBe(base);
    expect(inputPreparationRecordId(key({ scopeId: 'scope-b' }))).not.toBe(base);
    expect(inputPreparationRecordId(key({ agentRef: 'agent-2' }))).not.toBe(base);
    expect(inputPreparationRecordId(key({ requestId: 'req-2' }))).not.toBe(base);
  });
});
