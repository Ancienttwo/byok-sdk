import { generatePairingCode } from './ids';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // ~10min, per spec

export interface PairingCodeInfo {
  code: string;
  expiresAt: string;
}

interface PairingCodeRecord {
  code: string;
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
 * Auth v2 (docs/protocol.md §6) — this class no longer knows about devices
 * at all, only about the codes themselves.
 */
export class PairingManager {
  private readonly codes = new Map<string, PairingCodeRecord>();

  createPairingCode(): PairingCodeInfo {
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.codes.set(code, { code, expiresAt, used: false });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Validate and consume a pairing code. Throws {@link PairingCodeInvalidError}
   * if the code is unknown, expired, or already used — callers (the HTTP
   * handler) map that to a 401. Does not itself know anything about the
   * device being paired; the caller registers device identity separately
   * (see `auth.ts`'s `DeviceRegistry`) once the code checks out.
   */
  redeemPairingCode(code: string): void {
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
  }
}
