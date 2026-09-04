/**
 * Postgres {@link InboundDedupStore} (N3): bounded at-most-once processing.
 *
 * Check-and-record is one `INSERT ... ON CONFLICT DO NOTHING`, so a
 * composition cannot accidentally split it into a racy read-then-write: the
 * primary key does the deciding, and zero returned rows means "already seen".
 *
 * Reclaim runs only on the path that actually grew the table, and it deletes
 * oldest-first down to `DEDUP_RING_CAPACITY` rows for that exact physical or
 * Agent-bound key — the same bound the in-memory ring holds. The ids most
 * likely to be redelivered are the recent ones, so dropping the oldest is the
 * retention that matches the wire's behavior. An unbounded set would pass every
 * duplicate assertion and still let one chatty device or Agent grow this table
 * without limit.
 */
import { DEDUP_RING_CAPACITY, type InboundDedupStore } from '@byok-sdk/cloud';
import type { TenantId } from '@byok-sdk/core';
import type { AgentRef } from '@byok-sdk/protocol';
import type { Pool } from 'pg';

export class PostgresInboundDedupStore implements InboundDedupStore {
  readonly #pool: Pool;
  readonly #capacity: number;

  constructor(pool: Pool, capacity: number = DEDUP_RING_CAPACITY) {
    this.#pool = pool;
    this.#capacity = capacity;
  }

  async checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean> {
    return this.#checkAndRecord(tenant, deviceId, '', '', envelopeId);
  }

  async checkAndRecordAgent(
    tenant: TenantId,
    deviceId: string,
    agentRef: AgentRef,
    envelopeId: string,
  ): Promise<boolean> {
    return this.#checkAndRecord(tenant, deviceId, agentRef.agentId, agentRef.profileRevision, envelopeId);
  }

  async #checkAndRecord(
    tenant: TenantId,
    deviceId: string,
    agentId: string,
    agentProfileRevision: string,
    envelopeId: string,
  ): Promise<boolean> {
    const inserted = await this.#pool.query(
      `INSERT INTO inbound_dedup (tenant_id, device_id, agent_id, agent_profile_revision, envelope_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, device_id, agent_id, agent_profile_revision, envelope_id) DO NOTHING
       RETURNING 1`,
      [tenant, deviceId, agentId, agentProfileRevision, envelopeId],
    );
    if (inserted.rowCount === 0) return true;

    // Everything at or below the capacity-th newest row goes. The subquery
    // returns no row until the device is over capacity, and `<= NULL` deletes
    // nothing, so the common case costs one index scan and no writes.
    await this.#pool.query(
      `DELETE FROM inbound_dedup
        WHERE tenant_id = $1 AND device_id = $2
          AND agent_id = $3 AND agent_profile_revision = $4
          AND recorded_seq <= (
            SELECT recorded_seq FROM inbound_dedup
             WHERE tenant_id = $1 AND device_id = $2
               AND agent_id = $3 AND agent_profile_revision = $4
             ORDER BY recorded_seq DESC
             OFFSET $5 LIMIT 1)`,
      [tenant, deviceId, agentId, agentProfileRevision, this.#capacity],
    );
    return false;
  }
}
