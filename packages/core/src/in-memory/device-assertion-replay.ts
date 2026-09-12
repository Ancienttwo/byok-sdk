import type {
  DeviceAssertionReplayConsumeInput,
  DeviceAssertionReplayAuthority,
} from '../device-assertion';

/**
 * The reference key, in the SAME segment order as the durable primary key
 * (`deploy/sql/0022_task_assertion_replay_schema.sql`):
 * `(tenant_id, issuer, product_id, device_id, audience, schema, jti)`.
 *
 * The `schema` segment is what contract §8.2(2) requires: one `jti` presented
 * as a device assertion and as a task assertion produces two distinct keys, so
 * each lane is consumed exactly once and neither occupies the other's slot.
 * Order matters only in that it must match the SQL key — a reference authority
 * that keyed differently from the durable one would let the two implementations
 * disagree about which credentials collide.
 */
function replayKey(input: DeviceAssertionReplayConsumeInput): string {
  return JSON.stringify([
    input.tenantId,
    input.issuer,
    input.productId,
    input.deviceId,
    input.audience,
    input.schema,
    input.jti,
  ]);
}

/** Process-local reference authority. Production runtimes need durable atomic storage. */
export class InMemoryDeviceAssertionReplayAuthority implements DeviceAssertionReplayAuthority {
  readonly #expiresAtByKey = new Map<string, number>();

  async consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean> {
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('device assertion replay expiry is invalid');
    const key = replayKey(input);
    if (this.#expiresAtByKey.has(key)) return false;
    this.#expiresAtByKey.set(key, expiresAt);
    return true;
  }

  /** Delete at most `limit` keys whose assertion lifetime ended at or before `before`. */
  async deleteExpired(before: Date, limit: number): Promise<number> {
    const cutoff = before.getTime();
    if (!Number.isFinite(cutoff) || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('device assertion replay cleanup bounds are invalid');
    }
    let deleted = 0;
    for (const [key, expiresAt] of this.#expiresAtByKey) {
      if (expiresAt > cutoff) continue;
      this.#expiresAtByKey.delete(key);
      deleted += 1;
      if (deleted === limit) break;
    }
    return deleted;
  }
}
