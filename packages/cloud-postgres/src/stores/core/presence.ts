/**
 * Postgres {@link PresenceStore} and {@link ActivityStore} (§12.3).
 *
 * Both are lossy, TTL-bounded, unsigned, and never authoritative, and both are
 * bounded upserts: one row per device, one row per task. Nothing here may be
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
  DEFAULT_ACTIVITY_CAPACITY,
  type ActivityAppendInput,
  type ActivityEntry,
  type ActivityStore,
  type ActivityTail,
  type Clock,
  type PresenceHint,
  type PresenceHintInput,
  type PresenceLevel,
  type PresenceStore,
  type TenantId,
} from '@byok/core';
import type { Pool } from 'pg';

const PRESENCE_COLUMNS = 'tenant_id, device_id, level, detail, observed_at, expires_at';

interface PresenceRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly level: string;
  readonly detail: string | null;
  readonly observed_at: string;
  readonly expires_at: string;
}

interface TailRow {
  readonly tenant_id: string;
  readonly task_id: string;
  readonly entries: readonly ActivityEntry[];
  readonly dropped: number;
  readonly capacity: number;
  readonly expires_at: string;
}

function toHint(row: PresenceRow): PresenceHint {
  return {
    tenantId: row.tenant_id as TenantId,
    deviceId: row.device_id,
    level: row.level as PresenceLevel,
    ...(row.detail === null ? {} : { detail: row.detail }),
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
  };
}

function toTail(row: TailRow): ActivityTail {
  return {
    tenantId: row.tenant_id as TenantId,
    taskId: row.task_id,
    entries: row.entries,
    dropped: row.dropped,
    capacity: row.capacity,
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

export class PostgresPresenceStore implements PresenceStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint> {
    assertTtl(input.ttlMs);
    const result = await this.#pool.query<PresenceRow>(
      `INSERT INTO device_presence (${PRESENCE_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, device_id) DO UPDATE
          SET level       = EXCLUDED.level,
              detail      = EXCLUDED.detail,
              observed_at = EXCLUDED.observed_at,
              expires_at  = EXCLUDED.expires_at
       RETURNING ${PRESENCE_COLUMNS}`,
      [tenant, input.deviceId, input.level, input.detail ?? null, this.#now(), this.#expiry(input.ttlMs)],
    );
    return toHint(result.rows[0]!);
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

export class PostgresActivityStore implements ActivityStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    assertTtl(input.ttlMs);
    const capacity = input.capacity ?? DEFAULT_ACTIVITY_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new ByokCoreError(
        'activity_capacity_invalid',
        `Activity capacity must be a positive integer, received ${String(capacity)}.`,
      );
    }

    // One statement. `live` reads the stored tail only if it has not expired —
    // an expired tail restarts from empty rather than resurrecting entries a
    // reader was already told did not exist. `trimmed` then drops from the
    // FRONT down to `capacity` and adds however many it dropped to the running
    // counter, so lossiness stays in the data instead of being a gap the reader
    // has to notice.
    const result = await this.#pool.query<TailRow>(
      `WITH live AS (
         SELECT entries, dropped FROM activity_tail
          WHERE tenant_id = $1 AND task_id = $2 AND expires_at > $3
       ), combined AS (
         SELECT COALESCE((SELECT entries FROM live), '[]'::jsonb)
                  || jsonb_build_array(jsonb_build_object('at', $3::text, 'detail', $4::text))
                AS entries,
                COALESCE((SELECT dropped FROM live), 0) AS dropped
       ), trimmed AS (
         SELECT COALESCE(
                  (SELECT jsonb_agg(entry ORDER BY ordinality)
                     FROM jsonb_array_elements(combined.entries)
                          WITH ORDINALITY AS element(entry, ordinality)
                    WHERE ordinality > GREATEST(jsonb_array_length(combined.entries) - $5, 0)),
                  '[]'::jsonb) AS entries,
                combined.dropped
                  + GREATEST(jsonb_array_length(combined.entries) - $5, 0) AS dropped
           FROM combined
       )
       INSERT INTO activity_tail (tenant_id, task_id, entries, dropped, capacity, expires_at)
       SELECT $1, $2, trimmed.entries, trimmed.dropped, $5, $6 FROM trimmed
       ON CONFLICT (tenant_id, task_id) DO UPDATE
          SET entries    = EXCLUDED.entries,
              dropped    = EXCLUDED.dropped,
              capacity   = EXCLUDED.capacity,
              expires_at = EXCLUDED.expires_at
       RETURNING tenant_id, task_id, entries, dropped, capacity, expires_at`,
      [tenant, input.taskId, this.#now(), input.detail, capacity, this.#expiry(input.ttlMs)],
    );
    return toTail(result.rows[0]!);
  }

  async read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined> {
    const result = await this.#pool.query<TailRow>(
      `SELECT tenant_id, task_id, entries, dropped, capacity, expires_at
         FROM activity_tail
        WHERE tenant_id = $1 AND task_id = $2 AND expires_at > $3`,
      [tenant, taskId, this.#now()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toTail(row);
  }

  #expiry(ttlMs: number): string {
    return new Date(this.#clock.now().getTime() + ttlMs).toISOString();
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
