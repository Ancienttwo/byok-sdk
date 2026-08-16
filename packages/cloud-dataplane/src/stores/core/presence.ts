/**
 * Postgres {@link PresenceStore} (§12.3).
 *
 * Presence is lossy, TTL-bounded, unsigned, and never authoritative. It is a
 * bounded upsert with one row per device. Nothing here may be
 * used to derive coordination state, execution state, authorization, billing or
 * recovery — which is why this file shares no vocabulary with `board.ts` and
 * none with the frozen wire states.
 *
 * **Expiry is absence, and it is expressed as a read filter.** A hint past its
 * `expiresAt` is invisible to every read, so no reader can observe a stale
 * level and mistake it for a live one. The in-memory reference deletes the
 * entry lazily on read; here the row stays and the predicate excludes it. Same
 * observable answer, and a `SELECT` that does not write to answer itself.
 *
 * Every instant is the injected clock's. Asserting TTL behavior against a wall
 * clock means sleeping or accepting flakes, which is why the port takes `ttlMs`
 * and the composition supplies the clock.
 */
import {
  ByokCoreError,
  type Clock,
  type PresenceHint,
  type PresenceHintInput,
  type PresenceLevel,
  type PresenceStore,
  type TenantId,
} from '@byok-sdk/core';
import type { Pool } from 'pg';

const PRESENCE_COLUMNS =
  'tenant_id, device_id, level, detail, configured_toolsets, observed_at, expires_at';

interface PresenceRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly level: string;
  readonly detail: string | null;
  readonly configured_toolsets: readonly string[] | null;
  readonly observed_at: string;
  readonly expires_at: string;
}

function toHint(row: PresenceRow): PresenceHint {
  return {
    tenantId: row.tenant_id as TenantId,
    deviceId: row.device_id,
    level: row.level as PresenceLevel,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.configured_toolsets === null
      ? {}
      : { configuredToolsets: Object.freeze([...row.configured_toolsets]) }),
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
  };
}

function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ByokCoreError(
      'hint_ttl_invalid',
      `Hint ttl must be a positive number of milliseconds, received ${String(ttlMs)}.`,
    );
  }
}

function assertMinimumInterval(minimumIntervalMs: number): void {
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
    throw new ByokCoreError(
      'hint_ttl_invalid',
      `Hint minimum interval must be a non-negative number of milliseconds, received ${String(minimumIntervalMs)}.`,
    );
  }
}

export class PostgresPresenceStore implements PresenceStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint> {
    assertTtl(input.ttlMs);
    assertMinimumInterval(input.minimumIntervalMs);
    const now = this.#clock.now();
    const observedAt = now.toISOString();
    const allowedBefore = new Date(now.getTime() - input.minimumIntervalMs).toISOString();
    const result = await this.#pool.query<PresenceRow>(
      `INSERT INTO device_presence (${PRESENCE_COLUMNS})
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (tenant_id, device_id) DO UPDATE
          SET level       = EXCLUDED.level,
              detail      = EXCLUDED.detail,
              configured_toolsets = EXCLUDED.configured_toolsets,
              observed_at = EXCLUDED.observed_at,
              expires_at  = EXCLUDED.expires_at
        WHERE device_presence.expires_at <= EXCLUDED.observed_at
           OR device_presence.observed_at <= $8
       RETURNING ${PRESENCE_COLUMNS}`,
      [
        tenant,
        input.deviceId,
        input.level,
        input.detail ?? null,
        input.configuredToolsets === undefined ? null : JSON.stringify(input.configuredToolsets),
        observedAt,
        new Date(now.getTime() + input.ttlMs).toISOString(),
        allowedBefore,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ByokCoreError(
        'hint_rate_limited',
        `Presence for ${input.deviceId} was published more recently than the configured minimum interval.`,
      );
    }
    return toHint(row);
  }

  async read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined> {
    const result = await this.#pool.query<PresenceRow>(
      `SELECT ${PRESENCE_COLUMNS} FROM device_presence
        WHERE tenant_id = $1 AND device_id = $2 AND expires_at > $3`,
      [tenant, deviceId, this.#now()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toHint(row);
  }

  async list(tenant: TenantId): Promise<readonly PresenceHint[]> {
    const result = await this.#pool.query<PresenceRow>(
      `SELECT ${PRESENCE_COLUMNS} FROM device_presence
        WHERE tenant_id = $1 AND expires_at > $2
        ORDER BY device_id COLLATE "C"`,
      [tenant, this.#now()],
    );
    return result.rows.map(toHint);
  }

  #expiry(ttlMs: number): string {
    return new Date(this.#clock.now().getTime() + ttlMs).toISOString();
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
