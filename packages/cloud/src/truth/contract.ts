import type {
  ContentHash,
  TenantId,
  TruthBodyRef,
  TruthManifestEntry,
  TruthManifestQuery,
  TruthRecord,
  TruthRecordKind,
  TruthRecordSelector,
} from '@byok-sdk/core';
import { z } from 'zod';

export const TRUTH_RECORD_CAPABILITY = 'truth.records';
export const TRUTH_INLINE_CONTENT_TYPE = 'application/vnd.byok.truth+utf8';
export const TRUTH_REQUEST_ID_MAX_LENGTH = 120;
export const TRUTH_RECORD_KEY_MAX_LENGTH = 200;
export const TRUTH_LABEL_MAX_LENGTH = 200;
export const TRUTH_BATCH_MAX_RECORDS = 32;
export const TRUTH_MANIFEST_MAX_LIMIT = 100;

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RECORD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const TruthRecordKeySchema = z
  .string()
  .min(1)
  .max(TRUTH_RECORD_KEY_MAX_LENGTH)
  .regex(RECORD_KEY_PATTERN)
  .refine((value) => value !== '.' && value !== '..');

export const TruthBodyInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('inline'),
    content: z.string(),
    contentHash: z.string().regex(CONTENT_HASH_PATTERN),
  }),
  z.strictObject({
    kind: z.literal('object'),
    contentHash: z.string().regex(CONTENT_HASH_PATTERN),
    byteSize: z.number().int().nonnegative().safe(),
  }),
]);

const SnapshotCandidateSchema = z.strictObject({
  kind: z.enum(['profile', 'memory']),
  recordKey: TruthRecordKeySchema,
  expectedRev: z.number().int().nonnegative().safe(),
  body: TruthBodyInputSchema,
  label: z.string().max(TRUTH_LABEL_MAX_LENGTH).optional(),
});

export const TruthWriteRequestSchema = z.strictObject({
  expectedRev: z.number().int().nonnegative().safe().optional(),
  body: TruthBodyInputSchema,
  label: z.string().max(TRUTH_LABEL_MAX_LENGTH).optional(),
  snapshots: z.array(SnapshotCandidateSchema).max(TRUTH_BATCH_MAX_RECORDS - 1).optional(),
});

export type TruthBodyInput = z.infer<typeof TruthBodyInputSchema>;
export type TruthWriteRequest = z.infer<typeof TruthWriteRequestSchema>;

export type PreparedTruthWrite =
  | {
      readonly kind: 'task.terminal';
      readonly recordKey: string;
      readonly contentHash: ContentHash;
      readonly byteSize: bigint;
      readonly body: TruthBodyRef;
      readonly label?: string;
    }
  | {
      readonly kind: 'profile' | 'memory';
      readonly recordKey: string;
      readonly expectedRev: number;
      readonly contentHash: ContentHash;
      readonly byteSize: bigint;
      readonly body: TruthBodyRef;
      readonly label?: string;
    };

export interface TruthCommitInput {
  readonly deviceId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly resource: string;
  readonly proofBodySha256: string;
  readonly proofBodySize: bigint;
  readonly writes: readonly [PreparedTruthWrite, ...PreparedTruthWrite[]];
}

export interface TruthRecordMetadata {
  readonly kind: TruthRecordKind;
  readonly recordKey: string;
  readonly rev: number;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly label?: string;
  readonly updatedAt: string;
}

export const TruthRecordMetadataSchema = z.strictObject({
  kind: z.enum(['task.terminal', 'profile', 'memory']),
  recordKey: TruthRecordKeySchema,
  rev: z.number().int().positive().safe(),
  contentHash: z.string().regex(CONTENT_HASH_PATTERN),
  byteSize: z.number().int().nonnegative().safe(),
  label: z.string().max(TRUTH_LABEL_MAX_LENGTH).optional(),
  updatedAt: z.string().datetime({ offset: true }),
});

export interface TruthCommitResponse {
  readonly primary: TruthRecordMetadata;
  readonly snapshots: readonly TruthRecordMetadata[];
}

export const TruthCommitResponseSchema = z.strictObject({
  primary: TruthRecordMetadataSchema,
  snapshots: z.array(TruthRecordMetadataSchema).max(TRUTH_BATCH_MAX_RECORDS - 1),
});

export interface TruthCommitResult {
  readonly response: TruthCommitResponse;
  readonly replayed: boolean;
}

export interface TruthCommitter {
  commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult>;
  getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
  listManifest(
    tenant: TenantId,
    query: TruthManifestQuery,
  ): Promise<readonly TruthManifestEntry[]>;
}

/**
 * Object download grant authority for truth bodies. The input is the canonical
 * content hash stored in `TruthBodyRef`, never an opaque upload id.
 */
export interface TruthObjectDownloads {
  getDownloadUrl(tenant: TenantId, hash: ContentHash): Promise<string | undefined>;
}

export function truthRecordMetadata(record: TruthRecord): TruthRecordMetadata {
  const byteSize = Number(record.byteSize);
  if (!Number.isSafeInteger(byteSize)) throw new Error('truth record byte size exceeds JSON range');
  return {
    kind: record.kind,
    recordKey: record.recordKey,
    rev: record.rev,
    contentHash: record.contentHash,
    byteSize,
    ...(record.label === undefined ? {} : { label: record.label }),
    updatedAt: record.writtenAt,
  };
}

export function truthManifestMetadata(entry: TruthManifestEntry): TruthRecordMetadata {
  const byteSize = Number(entry.byteSize);
  if (!Number.isSafeInteger(byteSize)) throw new Error('truth manifest byte size exceeds JSON range');
  return {
    kind: entry.kind,
    recordKey: entry.recordKey,
    rev: entry.rev,
    contentHash: entry.contentHash,
    byteSize,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    updatedAt: entry.updatedAt,
  };
}
