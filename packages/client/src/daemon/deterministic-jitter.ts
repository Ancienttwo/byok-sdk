import { createHash } from 'node:crypto';

export type JitterDomain = 'reconnect' | 'upload' | 'maintenance';

export interface DeterministicJitterInput {
  seed: string;
  domain: JitterDomain;
  sequence: number;
  baseMs: number;
  ratio?: number;
}

/**
 * Stable, domain-separated fleet jitter. The same identity/domain/sequence
 * always produces the same integer delay, while a different domain cannot
 * accidentally reuse the same hash stream. There is deliberately no random
 * fallback: callers must have loaded the device identity before constructing
 * an automatic retry loop.
 */
export function deterministicJitterMs(input: DeterministicJitterInput): number {
  const ratio = input.ratio ?? 0.2;
  if (input.seed.length === 0) throw new Error('deterministic jitter seed must not be empty');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error('deterministic jitter sequence must be a non-negative safe integer');
  }
  if (!Number.isFinite(input.baseMs) || input.baseMs < 0) {
    throw new Error('deterministic jitter baseMs must be a finite non-negative number');
  }
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('deterministic jitter ratio must be between 0 and 1');
  }
  if (input.baseMs === 0 || ratio === 0) return Math.round(input.baseMs);

  const digest = createHash('sha256')
    .update('byok-jitter-v1\0', 'utf8')
    .update(input.domain, 'utf8')
    .update('\0', 'utf8')
    .update(input.seed, 'utf8')
    .update('\0', 'utf8')
    .update(String(input.sequence), 'utf8')
    .digest();
  // 53 deterministic bits fit exactly in a JS number. Mapping to [0, 1)
  // avoids platform-dependent bigint/float conversions.
  const high = digest.readUInt32BE(0) & 0x001fffff;
  const low = digest.readUInt32BE(4);
  const unit = (high * 0x1_0000_0000 + low) / 0x20_0000_0000_0000;
  const multiplier = 1 - ratio + unit * ratio * 2;
  return Math.max(0, Math.round(input.baseMs * multiplier));
}

export interface FleetJitter {
  delay(domain: JitterDomain, sequence: number, baseMs: number): number;
}

export function createFleetJitter(productId: string, deviceId: string): FleetJitter {
  if (productId.length === 0 || deviceId.length === 0) {
    throw new Error('productId and deviceId are required for fleet jitter');
  }
  const seed = `${productId}\0${deviceId}`;
  return {
    delay: (domain, sequence, baseMs) => deterministicJitterMs({ seed, domain, sequence, baseMs }),
  };
}
