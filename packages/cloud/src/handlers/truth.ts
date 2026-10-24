import {
  DEVICE_PROOF_HEADER,
  STORAGE_ERROR_CODES,
  STORAGE_ERROR_HTTP_STATUS,
  TRUTH_RECORD_KINDS,
  contentHash,
  isCoreConflictError,
  isCoreError,
  principalTenant,
  type DevicePrincipal,
  type StorageErrorCode,
  type TruthManifestQuery,
  type TruthRecord,
  type TruthRecordKind,
} from '@byok-sdk/core';
import type { Context } from 'hono';
import type { DeviceProofAuthDeps } from '../auth/device-proof';
import {
  TRUTH_MANIFEST_MAX_LIMIT,
  TruthRecordKeySchema,
  TruthWriteRequestSchema,
  truthManifestMetadata,
  truthRecordMetadata,
  type PreparedTruthWrite,
  type TruthBodyInput,
  type TruthCommitInput,
  type TruthCommitter,
  type TruthObjectDownloads,
  type TruthRecordMetadata,
} from '../truth/contract';
import { isTruthCommitError } from '../truth/errors';
import { authenticateProofRequest, readProofRequestBody } from './device-proof-request';

// Re-exported from core (single source of truth for the wire header); still
// part of this module's public surface for callers importing it from cloud.
export { DEVICE_PROOF_HEADER };
export { MAX_DEVICE_PROOF_HEADER_BYTES } from './device-proof-request';
export const DEFAULT_MAX_TRUTH_REQUEST_BYTES = 2 * 1024 * 1024;

const EMPTY_BODY = new Uint8Array();
const RECORD_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface TruthRouteDeps {
  readonly proof: DeviceProofAuthDeps;
  readonly truth: TruthCommitter;
  readonly objectDownloads: TruthObjectDownloads;
  readonly maxRequestBytes: number;
}

interface ProofContext {
  readonly device: DevicePrincipal;
  readonly requestId: string;
  readonly operation: string;
  readonly resource: string;
  readonly bodySha256: string;
  readonly bodySize: bigint;
}

export function truthManifestHandler(deps: TruthRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateTruthRequest(c, deps, {
      body: EMPTY_BODY,
      operation: 'truth.list',
      resource: 'records',
    });
    if (authenticated === undefined) return unauthorized(c);

    const query = manifestQuery(c);
    if (query === undefined) return c.json({ error: 'invalid truth manifest query' }, 400);
    const records = await deps.truth.listManifest(principalTenant(authenticated.device), query);
    return c.json({ records: records.map(truthManifestMetadata) }, 200);
  };
}

export function truthGetHandler(deps: TruthRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const resource = rawRecordResource(c);
    const authenticated = await authenticateTruthRequest(c, deps, {
      body: EMPTY_BODY,
      operation: 'truth.read',
      resource,
    });
    if (authenticated === undefined) return unauthorized(c);
    const selector = recordSelector(c);
    if (selector === undefined) return c.json({ error: 'invalid truth record selector' }, 400);

    const record = await deps.truth.getRecord(principalTenant(authenticated.device), selector);
    if (record === undefined) return c.json({ error: 'truth_record_not_found' }, 404);
    const metadata = truthRecordMetadata(record);
    if (record.body.kind === 'inline') {
      return c.json({ ...metadata, body: { kind: 'inline', content: record.body.body } }, 200);
    }

    const downloadUrl = await deps.objectDownloads.getDownloadUrl(
      principalTenant(authenticated.device),
      record.body.hash,
    );
    if (downloadUrl === undefined) return c.json({ error: 'object_not_found' }, 404);
    return c.json({ ...metadata, body: { kind: 'object', downloadUrl } }, 200);
  };
}

export function truthPutHandler(deps: TruthRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const body = await readProofRequestBody(c, deps.maxRequestBytes);
    if (body === 'too_large') return c.json({ error: 'truth request body too large' }, 413);
    if (body === undefined) return c.json({ error: 'invalid truth request body' }, 400);

    const authenticated = await authenticateTruthRequest(c, deps, {
      body,
      operation: 'truth.write',
      resource: rawRecordResource(c),
    });
    if (authenticated === undefined) return unauthorized(c);
    const selector = recordSelector(c);
    if (selector === undefined) return c.json({ error: 'invalid truth record selector' }, 400);

    const parsedJson = parseJsonBytes(body);
    const parsed = TruthWriteRequestSchema.safeParse(parsedJson);
    if (!parsed.success) return c.json({ error: 'invalid truth write request' }, 400);
    const writes = prepareWrites(selector.kind, selector.recordKey, parsed.data);
    if (writes === undefined) return c.json({ error: 'invalid truth write model' }, 400);

    const input: TruthCommitInput = {
      deviceId: authenticated.device.deviceId,
      requestId: authenticated.requestId,
      operation: authenticated.operation,
      resource: authenticated.resource,
      proofBodySha256: authenticated.bodySha256,
      proofBodySize: authenticated.bodySize,
      writes,
    };
    try {
      const result = await deps.truth.commit(principalTenant(authenticated.device), input);
      return c.json(result.response, 200, { 'x-byok-replayed': result.replayed ? 'true' : 'false' });
    } catch (caught) {
      return truthFailure(c, caught);
    }
  };
}

function recordSelector(
  c: Context,
): { readonly kind: TruthRecordKind; readonly recordKey: string } | undefined {
  const kind = c.req.param('kind');
  const recordKey = c.req.param('key');
  if (!TRUTH_RECORD_KINDS.includes(kind as TruthRecordKind)) return undefined;
  const parsedKey = TruthRecordKeySchema.safeParse(recordKey);
  if (!parsedKey.success) return undefined;
  return { kind: kind as TruthRecordKind, recordKey: parsedKey.data };
}

function rawRecordResource(c: Context): string {
  return `${c.req.param('kind') ?? ''}/${c.req.param('key') ?? ''}`;
}

function manifestQuery(c: Context): TruthManifestQuery | undefined {
  const url = new URL(c.req.url);
  for (const key of url.searchParams.keys()) {
    if (
      (key !== 'kind' && key !== 'prefix' && key !== 'limit') ||
      url.searchParams.getAll(key).length !== 1
    ) {
      return undefined;
    }
  }
  const kind = url.searchParams.get('kind') ?? undefined;
  if (kind !== undefined && !TRUTH_RECORD_KINDS.includes(kind as TruthRecordKind)) return undefined;
  const keyPrefix = url.searchParams.get('prefix') ?? undefined;
  if (
    keyPrefix !== undefined &&
    (keyPrefix.length === 0 || keyPrefix.length > 200 || !RECORD_PREFIX_PATTERN.test(keyPrefix))
  ) {
    return undefined;
  }
  const limitRaw = url.searchParams.get('limit') ?? undefined;
  const limit = limitRaw === undefined ? TRUTH_MANIFEST_MAX_LIMIT : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRUTH_MANIFEST_MAX_LIMIT) return undefined;
  return {
    ...(kind === undefined ? {} : { kind: kind as TruthRecordKind }),
    ...(keyPrefix === undefined ? {} : { keyPrefix }),
    limit,
  };
}

function prepareWrites(
  kind: TruthRecordKind,
  recordKey: string,
  request: ReturnType<typeof TruthWriteRequestSchema.parse>,
): readonly [PreparedTruthWrite, ...PreparedTruthWrite[]] | undefined {
  if (kind === 'task.terminal') {
    if (request.expectedRev !== undefined) return undefined;
  } else if (request.expectedRev === undefined || request.snapshots !== undefined) {
    return undefined;
  }

  const primary = prepareWrite(kind, recordKey, request.body, request.expectedRev, request.label);
  const snapshots = (request.snapshots ?? []).map((snapshot) =>
    prepareWrite(
      snapshot.kind,
      snapshot.recordKey,
      snapshot.body,
      snapshot.expectedRev,
      snapshot.label,
    ),
  );
  return [primary, ...snapshots];
}

function prepareWrite(
  kind: TruthRecordKind,
  recordKey: string,
  input: TruthBodyInput,
  expectedRev: number | undefined,
  label: string | undefined,
): PreparedTruthWrite {
  const hash = contentHash(input.contentHash);
  const body =
    input.kind === 'inline'
      ? ({ kind: 'inline', body: input.content } as const)
      : ({ kind: 'object', hash } as const);
  const byteSize =
    input.kind === 'inline'
      ? BigInt(new TextEncoder().encode(input.content).byteLength)
      : BigInt(input.byteSize);
  if (kind === 'task.terminal') {
    return { kind, recordKey, contentHash: hash, byteSize, body, ...(label === undefined ? {} : { label }) };
  }
  if (expectedRev === undefined) throw new Error('snapshot expectedRev was not validated');
  return {
    kind,
    recordKey,
    expectedRev,
    contentHash: hash,
    byteSize,
    body,
    ...(label === undefined ? {} : { label }),
  };
}

function authenticateTruthRequest(
  c: Context,
  deps: TruthRouteDeps,
  request: { readonly body: Uint8Array; readonly operation: string; readonly resource: string },
): Promise<ProofContext | undefined> {
  return authenticateProofRequest(c, deps.proof, request);
}

function parseJsonBytes(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function unauthorized(c: Context): Response {
  return c.json({ error: 'unauthorized' }, 401);
}

function truthFailure(c: Context, caught: unknown): Response {
  if (isCoreConflictError<TruthRecord | undefined>(caught)) {
    const current: TruthRecordMetadata | null =
      caught.current === undefined ? null : truthRecordMetadata(caught.current);
    return c.json({ error: caught.code, current, observedAt: caught.observedAt }, 409);
  }
  if (isTruthCommitError(caught)) {
    return c.json({ error: caught.code, ...(caught.current === undefined ? {} : { current: caught.current }) }, 409);
  }
  if (isCoreError(caught)) {
    if ((STORAGE_ERROR_CODES as readonly string[]).includes(caught.code)) {
      const code = caught.code as StorageErrorCode;
      return c.json({ error: code }, STORAGE_ERROR_HTTP_STATUS[code]);
    }
    if (caught.code === 'storage_entitlement_missing' || caught.code === 'object_state_invalid') {
      return c.json({ error: caught.code }, 409);
    }
    if (caught.code === 'content_hash_invalid') return c.json({ error: caught.code }, 400);
  }
  throw caught;
}
