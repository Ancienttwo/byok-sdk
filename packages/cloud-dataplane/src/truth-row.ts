import type {
  ContentHash,
  TenantId,
  TruthBodyRef,
  TruthRecord,
  TruthRecordKind,
} from '@byok-sdk/core';

export const RECORD_COLUMNS =
  'tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, body_object_hash, label, request_id, written_at';

export interface RecordRow {
  readonly tenant_id: string;
  readonly kind: string;
  readonly subject_id: string;
  readonly rev: number;
  readonly content_hash: string;
  readonly byte_size: bigint;
  readonly body_kind: string;
  readonly body_inline: string | null;
  readonly body_object_hash: string | null;
  readonly label: string | null;
  readonly request_id: string | null;
  readonly written_at: string;
}

function toBody(row: RecordRow): TruthBodyRef {
  return row.body_kind === 'inline'
    ? { kind: 'inline', body: row.body_inline ?? '' }
    : { kind: 'object', hash: (row.body_object_hash ?? '') as ContentHash };
}

export function toRecord(tenant: TenantId, row: RecordRow): TruthRecord {
  return {
    tenantId: tenant,
    kind: row.kind as TruthRecordKind,
    recordKey: row.subject_id,
    rev: row.rev,
    contentHash: row.content_hash as ContentHash,
    byteSize: row.byte_size,
    body: toBody(row),
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    writtenAt: row.written_at,
  };
}

/** Splits the two-case `TruthBodyRef` union into the two nullable columns. */
export function bodyColumns(body: TruthBodyRef): readonly [string, string | null, string | null] {
  return body.kind === 'inline'
    ? ['inline', body.body, null]
    : ['object', null, body.hash];
}
