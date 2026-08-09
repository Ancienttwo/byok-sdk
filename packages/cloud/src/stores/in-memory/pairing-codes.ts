/**
 * In-memory {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * `redeem` answers `undefined` for unknown, expired, and already-used alike.
 * The reference server distinguishes those three in its 401 text; a hosted,
 * multi-tenant surface deliberately does not — the code is a bearer credential
 * addressable across every tenant, and "already used" versus "never existed"
 * is exactly the difference an attacker enumerating codes would pay for.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  PairingCodeClaims,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
} from '../ports';

interface PairingCodeRecord {
  readonly claims: PairingCodeClaims;
  readonly expiresAtMs: number;
  used: boolean;
}

export class InMemoryPairingCodeStore implements PairingCodeStore {
  readonly #codes = new Map<string, PairingCodeRecord>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo> {
    this.#codes.set(input.code, {
      claims: { tenantId: tenant, productId: input.productId },
      expiresAtMs: new Date(input.expiresAt).getTime(),
      used: false,
    });
    return { code: input.code, expiresAt: input.expiresAt };
  }

  async redeem(code: string): Promise<PairingCodeClaims | undefined> {
    const record = this.#codes.get(code);
    if (record === undefined) return undefined;
    if (record.used) return undefined;
    if (this.#clock.now().getTime() > record.expiresAtMs) return undefined;
    record.used = true;
    return record.claims;
  }
}
