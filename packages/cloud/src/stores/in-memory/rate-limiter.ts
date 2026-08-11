/**
 * The reference {@link InboundRateLimiter}: allow-all.
 *
 * S3a's job is to put the seam at gate position 0 — before the type-allow
 * check — not to invent a limiter policy. A hosted deployment's real budget
 * lives at its edge; when it arrives it plugs in here and the gate order does
 * not move.
 */
import type { TenantId } from '@byok-sdk/core';
import type { InboundRateLimiter } from '../ports';

export class AllowAllRateLimiter implements InboundRateLimiter {
  async consume(_tenant: TenantId, _deviceId: string): Promise<boolean> {
    return true;
  }
}
