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
  attempt?: PairingAttempt;
}

/** Immutable facts supplied by one first-pair HTTP request. */
export interface PairingAttemptBinding {
  deviceName: string;
  devicePublicKey: string;
}

/** The recoverable enrollment fact created exactly once for one pairing code. */
export interface PairingCompletion {
  deviceId: string;
  tenantId: TenantId;
  productId: string;
  deviceName: string;
  devicePublicKey: string;
}

interface PairingAttempt {
  binding: PairingAttemptBinding;
  completion?: PairingCompletion;
}

/** Thrown when a pairing code is missing, expired, or already used. */
export class PairingCodeInvalidError extends Error {
  constructor(reason: string) {
    super(`invalid pairing code: ${reason}`);
    this.name = 'PairingCodeInvalidError';
  }
}

/** A spent code may be replayed only with the immutable request that spent it. */
export class PairingAttemptConflictError extends Error {
  constructor() {
    super('pairing code is already bound to a different pairing attempt');
    this.name = 'PairingAttemptConflictError';
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

  /**
   * Bind a code to one exact pairing request, returning any completion that a
   * prior response/token failure left recoverable. This mutation is entirely
   * synchronous: the HTTP route cannot yield between binding, registration,
   * and completion recording, so concurrent requests have one winner.
   */
  beginPairingAttempt(code: string, binding: PairingAttemptBinding): { claims: PairingCodeClaims; completion?: PairingCompletion } {
    const record = this.codes.get(code);
    if (!record) throw new PairingCodeInvalidError('unknown code');
    if (Date.now() > record.expiresAt) throw new PairingCodeInvalidError('code expired');
    validatePairingAttemptBinding(binding);

    if (record.attempt !== undefined) {
      if (!samePairingAttemptBinding(record.attempt.binding, binding)) throw new PairingAttemptConflictError();
      return { claims: record.claims, completion: record.attempt.completion };
    }
    if (record.used) throw new PairingCodeInvalidError('code already used');

    record.used = true;
    record.attempt = { binding: { ...binding } };
    return { claims: record.claims };
  }

  /** Record the one device identity a bound pairing attempt completed as. */
  completePairingAttempt(code: string, binding: PairingAttemptBinding, completion: PairingCompletion): PairingCompletion {
    const record = this.codes.get(code);
    if (!record?.attempt || !samePairingAttemptBinding(record.attempt.binding, binding)) {
      throw new PairingAttemptConflictError();
    }
    const expected: PairingCompletion = {
      deviceId: completion.deviceId,
      tenantId: record.claims.tenantId,
      productId: record.claims.productId,
      deviceName: binding.deviceName,
      devicePublicKey: binding.devicePublicKey,
    };
    if (record.attempt.completion !== undefined) {
      if (!samePairingCompletion(record.attempt.completion, expected)) throw new PairingAttemptConflictError();
      return record.attempt.completion;
    }
    record.attempt.completion = expected;
    return expected;
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

function validatePairingAttemptBinding(binding: PairingAttemptBinding): void {
  if (
    typeof binding !== 'object' || binding === null ||
    typeof binding.deviceName !== 'string' || binding.deviceName.length === 0 ||
    typeof binding.devicePublicKey !== 'string' || binding.devicePublicKey.length === 0
  ) {
    throw new TypeError('pairing attempt requires a non-empty deviceName and devicePublicKey');
  }
}

function samePairingAttemptBinding(left: PairingAttemptBinding, right: PairingAttemptBinding): boolean {
  return left.deviceName === right.deviceName && left.devicePublicKey === right.devicePublicKey;
}

function samePairingCompletion(left: PairingCompletion, right: PairingCompletion): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.tenantId === right.tenantId &&
    left.productId === right.productId &&
    left.deviceName === right.deviceName &&
    left.devicePublicKey === right.devicePublicKey
  );
}
