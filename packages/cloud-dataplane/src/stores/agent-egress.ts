import {
  AgentEgressReliablePayloadSchema,
  type AgentEgressReliablePayload,
} from '@byok-sdk/protocol';
import type { AgentEgressRecord, AgentEgressStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';

interface AgentEgressRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly event_id: string;
  readonly agent_id: string;
  readonly agent_profile_revision: string;
  readonly session_ref: string;
  readonly policy_revision: string;
  readonly cursor: string;
  readonly payload_json: unknown;
  readonly content_hash: string;
  readonly byte_count: number;
  readonly receipt_id: string;
  readonly recorded_at: Date;
}

const SELECT_COLUMNS = [
  'tenant_id',
  'device_id',
  'event_id',
  'agent_id',
  'agent_profile_revision',
  'session_ref',
  'policy_revision',
  'cursor',
  'payload_json',
  'content_hash',
  'byte_count',
  'receipt_id',
  'recorded_at',
].join(', ');

function toRecord(row: AgentEgressRow): AgentEgressRecord {
  const payload: AgentEgressReliablePayload = AgentEgressReliablePayloadSchema.parse({
    agentRef: { agentId: row.agent_id, profileRevision: row.agent_profile_revision },
    sessionRef: row.session_ref,
    policyRevision: row.policy_revision,
    eventId: row.event_id,
    cursor: Number(row.cursor),
    payload: row.payload_json,
    contentHash: row.content_hash,
    byteCount: row.byte_count,
  });
  return {
    tenantId: row.tenant_id as TenantId,
    deviceId: row.device_id,
    payload,
    receiptId: row.receipt_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

/** Postgres implementation of the immutable reliable Agent egress receipt fact. */
export class PostgresAgentEgressStore implements AgentEgressStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async record(
    tenant: TenantId,
    input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>,
  ): Promise<{ readonly record: AgentEgressRecord; readonly created: boolean }> {
    const payload = AgentEgressReliablePayloadSchema.parse(input.payload);
    const inserted = await this.pool.query<AgentEgressRow>(
      `INSERT INTO agent_egress_event (${SELECT_COLUMNS})
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8::bigint, $9::jsonb, $10, $11::integer, $12::uuid, $13)
       ON CONFLICT (tenant_id, device_id, agent_id, agent_profile_revision, event_id) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        tenant,
        input.deviceId,
        payload.eventId,
        payload.agentRef.agentId,
        payload.agentRef.profileRevision,
        payload.sessionRef,
        payload.policyRevision,
        payload.cursor,
        JSON.stringify(payload.payload),
        payload.contentHash,
        payload.byteCount,
        input.receiptId,
        this.clock.now().toISOString(),
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { record: toRecord(row), created: true };
    const existing = await this.get(tenant, input.deviceId, payload.agentRef, payload.eventId);
    if (existing === undefined) throw new Error(`Agent egress ${payload.eventId} vanished during first-write record.`);
    return { record: existing, created: false };
  }

  async get(
    tenant: TenantId,
    deviceId: string,
    agentRef: AgentEgressReliablePayload['agentRef'],
    eventId: string,
  ): Promise<AgentEgressRecord | undefined> {
    const result = await this.pool.query<AgentEgressRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM agent_egress_event
        WHERE tenant_id = $1 AND device_id = $2
          AND agent_id = $3 AND agent_profile_revision = $4
          AND event_id = $5::uuid`,
      [tenant, deviceId, agentRef.agentId, agentRef.profileRevision, eventId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }
}
