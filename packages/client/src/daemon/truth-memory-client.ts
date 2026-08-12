import { createHash, randomUUID } from 'node:crypto';
import {
  TRUTH_RECORD_KINDS,
  contentHash,
  type ContentHash,
  type TruthRecordKind,
  type TruthRecordSelector,
} from '@byok-sdk/core';
import { DEVICE_PROOF_HEADER, type DeviceProofEnvelopeV1 } from '@byok-sdk/core';
import { BYOK_RECORDS_PATH, byokRecordPath } from '@byok-sdk/protocol';
import type { DeviceProofSigner } from './device-proof-signer';
import { toHttpBase } from './url';

const EMPTY_BODY = new Uint8Array();
const LARGE_SNAPSHOT_THRESHOLD_BYTES = 1024 * 1024;

export interface TruthManifestRecord {
  readonly kind: TruthRecordKind;
  readonly recordKey: string;
  readonly rev: number;
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  readonly label?: string;
  readonly updatedAt: string;
}

export interface TruthManifestQueryInput {
  readonly kind?: TruthRecordKind;
  readonly keyPrefix?: string;
  readonly limit?: number;
}

/** Cloud-agnostic local semantic selection. It sees metadata and no body bytes. */
export interface MemorySelector {
  select(
    manifest: readonly TruthManifestRecord[],
  ): readonly TruthRecordSelector[] | Promise<readonly TruthRecordSelector[]>;
}

/** A body reaches this seam only after manifest equality, byte-size and SHA-256 checks. */
export interface VerifiedTruthRecord extends TruthManifestRecord {
  readonly bytes: Uint8Array;
}

/** The only value returned by `loadSelected`; runtime prompt/context shape stays host-owned. */
export interface LocalMemoryFilter<Context> {
  filter(records: readonly VerifiedTruthRecord[]): Context | Promise<Context>;
}

export interface TruthMemoryMetric {
  readonly kind: 'truth.snapshot.large';
  readonly selector: TruthRecordSelector;
  readonly byteSize: number;
  readonly thresholdBytes: number;
}

export interface TruthMemoryClientOptions {
  readonly serverUrl: string;
  readonly signer: DeviceProofSigner;
  /** Exact http(s) origins permitted to receive object-download grants. An empty list disables object reads. */
  readonly allowedObjectDownloadOrigins: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly requestId?: () => string;
  readonly onMetric?: (metric: TruthMemoryMetric) => void;
}

export type TruthWriteBody =
  | { readonly kind: 'inline'; readonly content: string }
  | { readonly kind: 'object'; readonly contentHash: string; readonly byteSize: number };

export interface TruthSnapshotWriteInput {
  readonly kind: 'profile' | 'memory';
  readonly recordKey: string;
  readonly expectedRev: number;
  readonly body: TruthWriteBody;
  readonly requestId: string;
  readonly label?: string;
}

export interface TruthSnapshotCandidateInput {
  readonly kind: 'profile' | 'memory';
  readonly recordKey: string;
  readonly expectedRev: number;
  readonly body: TruthWriteBody;
  readonly label?: string;
}

export interface TruthTerminalWriteInput {
  readonly taskId: string;
  readonly body: TruthWriteBody;
  readonly requestId: string;
  readonly label?: string;
  readonly snapshots?: readonly TruthSnapshotCandidateInput[];
}

export interface TruthWriteResult {
  readonly primary: TruthManifestRecord;
  readonly snapshots: readonly TruthManifestRecord[];
  readonly replayed: boolean;
}

interface PreparedTransportBody {
  readonly transport: Record<string, unknown>;
  readonly contentHash: ContentHash;
  readonly byteSize: number;
}

interface ExpectedTruthWrite {
  readonly kind: TruthRecordKind;
  readonly recordKey: string;
  readonly rev: number;
  readonly contentHash: ContentHash;
  readonly byteSize: number;
}

export type TruthMemoryClientErrorCode =
  | 'truth_http_failed'
  | 'truth_response_invalid'
  | 'truth_selection_invalid'
  | 'truth_manifest_changed'
  | 'truth_content_size_mismatch'
  | 'truth_content_hash_mismatch'
  | 'truth_object_url_rejected'
  | 'truth_write_invalid'
  | 'truth_write_confirmation_mismatch';

export class TruthMemoryClientError extends Error {
  constructor(
    readonly code: TruthMemoryClientErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TruthMemoryClientError';
  }
}

/** Proof-only client for S6 truth records. It never sends a bearer token. */
export class TruthMemoryClient {
  readonly #base: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestId: () => string;
  readonly #allowedObjectDownloadOrigins: ReadonlySet<string>;

  constructor(private readonly options: TruthMemoryClientOptions) {
    this.#base = toHttpBase(options.serverUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestId = options.requestId ?? randomUUID;
    this.#allowedObjectDownloadOrigins = new Set(
      options.allowedObjectDownloadOrigins.map(normalizeAllowedObjectDownloadOrigin),
    );
  }

  async listManifest(query: TruthManifestQueryInput = {}): Promise<readonly TruthManifestRecord[]> {
    const path = manifestPath(query);
    const response = await this.#proofFetch(path, {
      method: 'GET',
      operation: 'truth.list',
      resource: 'records',
      requestId: this.#requestId(),
      body: EMPTY_BODY,
    });
    const input = await parseJson(response);
    if (
      !isPlainObject(input) ||
      Object.keys(input).some((key) => key !== 'records') ||
      !Array.isArray(input['records'])
    ) {
      throw invalidResponse('truth manifest response must contain a records array');
    }
    const records = input['records'].map((entry) => parseMetadata(entry));
    const keys = new Set<string>();
    for (const record of records) {
      const key = selectorKey(record);
      if (keys.has(key)) throw invalidResponse(`truth manifest contains duplicate ${key}`);
      keys.add(key);
    }
    return records;
  }

  async loadSelected<Context>(
    selector: MemorySelector,
    filter: LocalMemoryFilter<Context>,
    query: TruthManifestQueryInput = {},
  ): Promise<Context> {
    const manifest = await this.listManifest(query);
    const selected = await selector.select(manifest);
    const bySelector = new Map(manifest.map((entry) => [selectorKey(entry), entry] as const));
    const seen = new Set<string>();
    const selectedRecords: TruthManifestRecord[] = [];
    for (const selection of selected) {
      if (!isSelector(selection)) {
        throw new TruthMemoryClientError('truth_selection_invalid', 'memory selector returned an invalid selector');
      }
      const key = selectorKey(selection);
      if (seen.has(key)) {
        throw new TruthMemoryClientError('truth_selection_invalid', `memory selector returned duplicate ${key}`);
      }
      seen.add(key);
      const listed = bySelector.get(key);
      if (listed === undefined) {
        throw new TruthMemoryClientError('truth_selection_invalid', `memory selector returned unlisted ${key}`);
      }
      selectedRecords.push(listed);
    }
    const verified: VerifiedTruthRecord[] = [];
    for (const listed of selectedRecords) {
      const record = await this.#readVerified(listed);
      verified.push(record);
      if (record.kind !== 'task.terminal' && record.byteSize > LARGE_SNAPSHOT_THRESHOLD_BYTES) {
        emitMetric(this.options.onMetric, {
          kind: 'truth.snapshot.large',
          selector: { kind: record.kind, recordKey: record.recordKey },
          byteSize: record.byteSize,
          thresholdBytes: LARGE_SNAPSHOT_THRESHOLD_BYTES,
        });
      }
    }
    return filter.filter(verified);
  }

  async writeSnapshot(input: TruthSnapshotWriteInput): Promise<TruthWriteResult> {
    const body = prepareTransportBody(input.body);
    return this.#write(input.kind, input.recordKey, input.requestId, {
      expectedRev: input.expectedRev,
      body: body.transport,
      ...(input.label === undefined ? {} : { label: input.label }),
    }, {
      kind: input.kind,
      recordKey: input.recordKey,
      rev: nextSnapshotRev(input.expectedRev),
      contentHash: body.contentHash,
      byteSize: body.byteSize,
    }, []);
  }

  async writeTerminal(input: TruthTerminalWriteInput): Promise<TruthWriteResult> {
    const body = prepareTransportBody(input.body);
    const snapshots = (input.snapshots ?? []).map((snapshot) => {
      const snapshotBody = prepareTransportBody(snapshot.body);
      return {
        payload: {
          kind: snapshot.kind,
          recordKey: snapshot.recordKey,
          expectedRev: snapshot.expectedRev,
          body: snapshotBody.transport,
          ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
        },
        expected: {
          kind: snapshot.kind,
          recordKey: snapshot.recordKey,
          rev: nextSnapshotRev(snapshot.expectedRev),
          contentHash: snapshotBody.contentHash,
          byteSize: snapshotBody.byteSize,
        } satisfies ExpectedTruthWrite,
      };
    });
    return this.#write('task.terminal', input.taskId, input.requestId, {
      body: body.transport,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.snapshots === undefined
        ? {}
        : {
            snapshots: snapshots.map((snapshot) => snapshot.payload),
          }),
    }, {
      kind: 'task.terminal',
      recordKey: input.taskId,
      rev: 1,
      contentHash: body.contentHash,
      byteSize: body.byteSize,
    }, snapshots.map((snapshot) => snapshot.expected));
  }

  async #write(
    kind: TruthRecordKind,
    recordKey: string,
    requestId: string,
    payload: Record<string, unknown>,
    expectedPrimary: ExpectedTruthWrite,
    expectedSnapshots: readonly ExpectedTruthWrite[],
  ): Promise<TruthWriteResult> {
    assertDistinctExpectedWrites([expectedPrimary, ...expectedSnapshots]);
    const path = recordPath(kind, recordKey);
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const response = await this.#proofFetch(path, {
      method: 'PUT',
      operation: 'truth.write',
      resource: `${kind}/${recordKey}`,
      requestId,
      body,
      headers: { 'content-type': 'application/json' },
    });
    const parsed = await parseJson(response);
    if (
      !isPlainObject(parsed) ||
      Object.keys(parsed).some((key) => key !== 'primary' && key !== 'snapshots') ||
      !Array.isArray(parsed['snapshots'])
    ) {
      throw invalidResponse('truth write response is malformed');
    }
    const replayed = response.headers.get('x-byok-replayed');
    if (replayed !== 'true' && replayed !== 'false') {
      throw invalidResponse('truth write response has no valid replay marker');
    }
    const primary = parseMetadata(parsed['primary']);
    const snapshots = parsed['snapshots'].map((entry) => parseMetadata(entry));
    assertWriteConfirmation(expectedPrimary, expectedSnapshots, primary, snapshots);
    return {
      primary,
      snapshots,
      replayed: replayed === 'true',
    };
  }

  async #readVerified(listed: TruthManifestRecord): Promise<VerifiedTruthRecord> {
    const path = recordPath(listed.kind, listed.recordKey);
    const response = await this.#proofFetch(path, {
      method: 'GET',
      operation: 'truth.read',
      resource: `${listed.kind}/${listed.recordKey}`,
      requestId: this.#requestId(),
      body: EMPTY_BODY,
    });
    const parsed = await parseJson(response);
    if (!isPlainObject(parsed) || !isPlainObject(parsed['body'])) {
      throw invalidResponse('truth record response is malformed');
    }
    const observed = parseMetadata(parsed, true);
    if (!sameMetadata(listed, observed)) {
      throw new TruthMemoryClientError(
        'truth_manifest_changed',
        `truth record ${selectorKey(listed)} changed after local selection`,
      );
    }
    const body = parsed['body'];
    let bytes: Uint8Array;
    if (body['kind'] === 'inline' && typeof body['content'] === 'string') {
      if (Object.keys(body).some((key) => key !== 'kind' && key !== 'content')) {
        throw invalidResponse('inline truth body contains unknown fields');
      }
      bytes = new TextEncoder().encode(body['content']);
    } else if (body['kind'] === 'object' && typeof body['downloadUrl'] === 'string') {
      if (Object.keys(body).some((key) => key !== 'kind' && key !== 'downloadUrl')) {
        throw invalidResponse('object truth body contains unknown fields');
      }
      const downloadUrl = resolveObjectDownloadUrl(
        body['downloadUrl'],
        this.#base,
        this.#allowedObjectDownloadOrigins,
      );
      const download = await this.#fetch(downloadUrl, { redirect: 'manual' });
      if (!download.ok) {
        throw new TruthMemoryClientError(
          'truth_http_failed',
          `truth object download failed with HTTP ${download.status}`,
          download.status,
        );
      }
      bytes = await readBoundedBytes(download, listed.byteSize);
    } else {
      throw invalidResponse('truth body kind is invalid');
    }
    if (bytes.byteLength !== listed.byteSize) {
      throw new TruthMemoryClientError(
        'truth_content_size_mismatch',
        `truth record ${selectorKey(listed)} declared ${listed.byteSize} bytes but returned ${bytes.byteLength}`,
      );
    }
    const observedHash = sha256(bytes);
    if (observedHash !== listed.contentHash) {
      throw new TruthMemoryClientError(
        'truth_content_hash_mismatch',
        `truth record ${selectorKey(listed)} failed SHA-256 verification`,
      );
    }
    return { ...listed, bytes };
  }

  async #proofFetch(
    path: string,
    request: {
      readonly method: 'GET' | 'PUT';
      readonly operation: string;
      readonly resource: string;
      readonly requestId: string;
      readonly body: Uint8Array;
      readonly headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const proof = await this.options.signer.sign({
      method: request.method,
      path,
      operation: request.operation,
      resource: request.resource,
      requestId: request.requestId,
      body: request.body,
    });
    const response = await this.#fetch(new URL(path, this.#base), {
      method: request.method,
      headers: {
        ...request.headers,
        [DEVICE_PROOF_HEADER]: encodeProof(proof),
      },
      ...(request.method === 'PUT' ? { body: request.body } : {}),
    });
    if (!response.ok) {
      throw new TruthMemoryClientError(
        'truth_http_failed',
        `truth request ${request.method} ${path} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return response;
  }
}

function manifestPath(query: TruthManifestQueryInput): string {
  const search = new URLSearchParams();
  if (query.kind !== undefined) search.set('kind', query.kind);
  if (query.keyPrefix !== undefined) search.set('prefix', query.keyPrefix);
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  const encoded = search.toString();
  return encoded.length === 0 ? BYOK_RECORDS_PATH : `${BYOK_RECORDS_PATH}?${encoded}`;
}

function recordPath(kind: TruthRecordKind, recordKey: string): string {
  return byokRecordPath(kind, recordKey);
}

function prepareTransportBody(body: TruthWriteBody): PreparedTransportBody {
  if (body.kind === 'inline') {
    const bytes = new TextEncoder().encode(body.content);
    const hash = sha256(bytes);
    return {
      transport: { kind: 'inline', content: body.content, contentHash: hash },
      contentHash: hash,
      byteSize: bytes.byteLength,
    };
  }
  if (!Number.isSafeInteger(body.byteSize) || body.byteSize < 0) {
    throw new TruthMemoryClientError(
      'truth_write_invalid',
      'object truth byteSize must be a non-negative safe integer',
    );
  }
  const hash = contentHash(body.contentHash);
  return {
    transport: { kind: 'object', contentHash: hash, byteSize: body.byteSize },
    contentHash: hash,
    byteSize: body.byteSize,
  };
}

function nextSnapshotRev(expectedRev: number): number {
  if (!Number.isSafeInteger(expectedRev) || expectedRev < 0 || expectedRev >= Number.MAX_SAFE_INTEGER) {
    throw new TruthMemoryClientError(
      'truth_write_invalid',
      'snapshot expectedRev must be a non-negative safe integer with room for the next revision',
    );
  }
  return expectedRev + 1;
}

function assertDistinctExpectedWrites(writes: readonly ExpectedTruthWrite[]): void {
  const seen = new Set<string>();
  for (const write of writes) {
    const key = selectorKey(write);
    if (seen.has(key)) {
      throw new TruthMemoryClientError(
        'truth_write_invalid',
        `truth write contains duplicate ${key}`,
      );
    }
    seen.add(key);
  }
}

function assertWriteConfirmation(
  expectedPrimary: ExpectedTruthWrite,
  expectedSnapshots: readonly ExpectedTruthWrite[],
  primary: TruthManifestRecord,
  snapshots: readonly TruthManifestRecord[],
): void {
  if (
    !sameExpectedWrite(expectedPrimary, primary) ||
    snapshots.length !== expectedSnapshots.length ||
    snapshots.some((snapshot, index) => !sameExpectedWrite(expectedSnapshots[index]!, snapshot))
  ) {
    throw new TruthMemoryClientError(
      'truth_write_confirmation_mismatch',
      'truth write response does not confirm the requested selector, revision, hash, size and snapshot order',
    );
  }
}

function sameExpectedWrite(expected: ExpectedTruthWrite, observed: TruthManifestRecord): boolean {
  return (
    expected.kind === observed.kind &&
    expected.recordKey === observed.recordKey &&
    expected.rev === observed.rev &&
    expected.contentHash === observed.contentHash &&
    expected.byteSize === observed.byteSize
  );
}

function normalizeAllowedObjectDownloadOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TruthMemoryClientError(
      'truth_object_url_rejected',
      `allowed object download origin is not an absolute URL: ${value}`,
    );
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TruthMemoryClientError(
      'truth_object_url_rejected',
      `allowed object download origin must be an exact credential-free http(s) origin: ${value}`,
    );
  }
  return url.origin;
}

function resolveObjectDownloadUrl(
  value: string,
  base: string,
  allowedOrigins: ReadonlySet<string>,
): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new TruthMemoryClientError('truth_object_url_rejected', 'truth object download URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !allowedOrigins.has(url.origin)
  ) {
    throw new TruthMemoryClientError(
      'truth_object_url_rejected',
      'truth object download URL is outside the configured credential-free http(s) origins',
    );
  }
  return url;
}

function encodeProof(proof: DeviceProofEnvelopeV1): string {
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url');
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse('truth response is not valid JSON');
  }
}

function parseMetadata(input: unknown, allowBody = false): TruthManifestRecord {
  if (!isPlainObject(input)) throw invalidResponse('truth metadata must be an object');
  const allowed = new Set(['kind', 'recordKey', 'rev', 'contentHash', 'byteSize', 'label', 'updatedAt']);
  if (allowBody) allowed.add('body');
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalidResponse('truth metadata contains unknown fields');
  }
  const kind = input['kind'];
  const recordKey = input['recordKey'];
  const rev = input['rev'];
  const hash = input['contentHash'];
  const byteSize = input['byteSize'];
  const label = input['label'];
  const updatedAt = input['updatedAt'];
  if (
    !isTruthKind(kind) ||
    typeof recordKey !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(recordKey) ||
    !Number.isSafeInteger(rev) ||
    (rev as number) < 1 ||
    typeof hash !== 'string' ||
    !Number.isSafeInteger(byteSize) ||
    (byteSize as number) < 0 ||
    (label !== undefined && typeof label !== 'string') ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw invalidResponse('truth metadata fields are invalid');
  }
  let canonicalHash: ContentHash;
  try {
    canonicalHash = contentHash(hash);
  } catch {
    throw invalidResponse('truth metadata contentHash is invalid');
  }
  return {
    kind,
    recordKey,
    rev: rev as number,
    contentHash: canonicalHash,
    byteSize: byteSize as number,
    ...(label === undefined ? {} : { label }),
    updatedAt,
  };
}

function isTruthKind(value: unknown): value is TruthRecordKind {
  return typeof value === 'string' && (TRUTH_RECORD_KINDS as readonly string[]).includes(value);
}

function isSelector(value: unknown): value is TruthRecordSelector {
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) => key === 'kind' || key === 'recordKey') &&
    isTruthKind(value['kind']) &&
    typeof value['recordKey'] === 'string' &&
    value['recordKey'].length > 0
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function sameMetadata(left: TruthManifestRecord, right: TruthManifestRecord): boolean {
  return (
    left.kind === right.kind &&
    left.recordKey === right.recordKey &&
    left.rev === right.rev &&
    left.contentHash === right.contentHash &&
    left.byteSize === right.byteSize &&
    left.label === right.label &&
    left.updatedAt === right.updatedAt
  );
}

function selectorKey(selector: Pick<TruthRecordSelector, 'kind' | 'recordKey'>): string {
  return `${selector.kind}\u0000${selector.recordKey}`;
}

async function readBoundedBytes(response: Response, expectedSize: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null) {
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed) || parsed !== expectedSize) {
      throw new TruthMemoryClientError(
        'truth_content_size_mismatch',
        `truth object declared ${expectedSize} bytes but Content-Length was ${length}`,
      );
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedSize) {
        await reader.cancel();
        throw new TruthMemoryClientError(
          'truth_content_size_mismatch',
          `truth object exceeded declared ${expectedSize} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sha256(bytes: Uint8Array): ContentHash {
  return contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function invalidResponse(message: string): TruthMemoryClientError {
  return new TruthMemoryClientError('truth_response_invalid', message);
}

function emitMetric(
  listener: TruthMemoryClientOptions['onMetric'],
  metric: TruthMemoryMetric,
): void {
  if (listener === undefined) return;
  try {
    listener(metric);
  } catch {
    // An observability sink is not a snapshot admission gate. The verified
    // record continues to the local filter even when the host's metric hook is
    // broken; no body or selector data is logged from this boundary.
    console.error('[byok/client] truth metric listener threw; verified record remains available');
  }
}
