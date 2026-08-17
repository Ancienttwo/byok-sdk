import type {
  DeviceAssertionReplayConsumeInput,
  DeviceAssertionReplayAuthority,
} from '../device-assertion';

function replayKey(input: DeviceAssertionReplayConsumeInput): string {
  return JSON.stringify([
    input.tenantId,
    input.issuer,
    input.productId,
    input.deviceId,
    input.audience,
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
