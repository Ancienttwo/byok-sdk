import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult } from '../retention';
import type { TenantId } from '../tenant';
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

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    const cutoff = Date.parse(input.now);
    let removed = 0, more = false;
    for (const [key, expiresAt] of this.#expiresAtByKey) {
      if (JSON.parse(key)[0] !== tenant || expiresAt > cutoff) continue;
      if (removed === input.limit) { more = true; break; }
      this.#expiresAtByKey.delete(key); removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }
}
