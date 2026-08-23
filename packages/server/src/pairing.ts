import type { TenantId } from './auth';
import { PairResponseTenantIdSchema } from '@byok-sdk/protocol';
import { generatePairingCode } from './ids';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // ~10min, per spec

/**
 * S1: the tenant identity a pairing code carries. Minted out-of-band by the
 * SaaS's own auth/device-flow UI — the only party that knows which tenant a
 * human is acting for — and returned by {@link PairingManager.redeemPairingCode}
 * so `POST /byok/pair` can write it onto the device row in the same
 * synchronous step that consumes the code.
 *
 * Deliberately NOT a wire field: `PairRequest` has no tenant of its own
 * (docs/protocol.md §6.1), so a device can never name the tenant it lands in.
 * These claims are the single source of truth for the row, and the row — not
 * a later token, and never client input — is what every authed surface
 * checks against.
 */
export interface PairingCodeClaims {
  tenantId: TenantId;
  productId: string;
}

export interface PairingCodeInfo {
  code: string;
  expiresAt: string;
}

interface PairingCodeRecord {
  code: string;
  claims: PairingCodeClaims;
  expiresAt: number;
  used: boolean;
}

/** Thrown when a pairing code is missing, expired, or already used. */
export class PairingCodeInvalidError extends Error {
  constructor(reason: string) {
    super(`invalid pairing code: ${reason}`);
    this.name = 'PairingCodeInvalidError';
  }
}

/**
 * In-memory pairing-code lifecycle: single-use, ~10min TTL codes minted
 * out-of-band (by the SaaS's own auth/device-flow UI) and redeemed exactly
 * once by `POST /byok/pair`.
 *
 * Device identity (deviceId/deviceName/devicePublicKey/revocation) and
 * token issuance moved to `auth.ts`'s `DeviceRegistry`/`TokenSigner` as of
 * Auth v2 (docs/protocol.md §6) — this class knows about devices only to the
 * extent of carrying the {@link PairingCodeClaims} that decide which tenant
 * and product the device being paired will belong to (S1).
 */
export class PairingManager {
  private readonly codes = new Map<string, PairingCodeRecord>();

  /**
   * Mint a single-use code bound to `claims`. Claims are REQUIRED — a
   * claimless mint is a compile error, and (for a JS caller, or a claims
   * object assembled from untyped config) a runtime {@link TypeError}. There
   * is no default tenant and no default product: a device with no tenant
   * must be inexpressible, so the failure happens here, at the mint, rather
   * than being filled in downstream.
   */
  createPairingCode(claims: PairingCodeClaims): PairingCodeInfo {
    const validated = validatePairingCodeClaims(claims);
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.codes.set(code, { code, claims: validated, expiresAt, used: false });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Validate and consume a pairing code, returning the {@link PairingCodeClaims}
   * it was minted with. Throws {@link PairingCodeInvalidError} if the code is
   * unknown, expired, or already used — callers (the HTTP handler) map that to
   * a 401. Single-use is what makes the caller's "redeem, then register the
   * device row with these claims" sequence safe: a second redeem of the same
   * code can never reach the registration step at all.
   */
  redeemPairingCode(code: string): PairingCodeClaims {
    const record = this.codes.get(code);
    if (!record) {
      throw new PairingCodeInvalidError('unknown code');
    }
    if (record.used) {
      throw new PairingCodeInvalidError('code already used');
    }
    if (Date.now() > record.expiresAt) {
      throw new PairingCodeInvalidError('code expired');
    }
    record.used = true;
    return record.claims;
  }
}

/**
 * Reject anything that isn't a complete claims pair, and return a copy so a
 * later mutation of the caller's object cannot retroactively change which
 * tenant a already-minted code redeems into.
 */
function validatePairingCodeClaims(claims: PairingCodeClaims): PairingCodeClaims {
  if (typeof claims !== 'object' || claims === null) {
    throw new TypeError('createPairingCode requires { tenantId, productId } claims');
  }
  const { tenantId, productId } = claims;
  const tenantResult = PairResponseTenantIdSchema.safeParse(tenantId);
  if (!tenantResult.success) {
    throw new TypeError('createPairingCode requires a valid bounded tenantId');
  }
  if (typeof productId !== 'string' || productId.length === 0) {
    throw new TypeError('createPairingCode requires a non-empty productId');
  }
  return { tenantId: tenantResult.data, productId };
}
