import { generateDeviceId, generateDeviceToken, generatePairingCode } from './ids';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // ~10min, per M0 spec

export interface PairingCodeInfo {
  code: string;
  expiresAt: string;
}

interface PairingCodeRecord {
  code: string;
  expiresAt: number;
  used: boolean;
}

interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  token: string;
}

/** Thrown when a pairing code is missing, expired, or already used. */
export class PairingCodeInvalidError extends Error {
  constructor(reason: string) {
    super(`invalid pairing code: ${reason}`);
    this.name = 'PairingCodeInvalidError';
  }
}

/**
 * In-memory device pairing: single-use, ~10min TTL pairing codes exchanged
 * for an opaque bearer device token (M0 simplification — no device
 * keypairs/JWT until M1). Also holds the device identity directory
 * (deviceId/deviceName) so the connection hub can join it against live
 * connection state for `machines.list()`.
 */
export class PairingManager {
  private readonly codes = new Map<string, PairingCodeRecord>();
  private readonly devicesByToken = new Map<string, DeviceIdentity>();
  private readonly devicesById = new Map<string, DeviceIdentity>();

  createPairingCode(): PairingCodeInfo {
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.codes.set(code, { code, expiresAt, used: false });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Redeem a pairing code for a new device identity. Throws
   * {@link PairingCodeInvalidError} if the code is unknown, expired, or
   * already used — callers (the HTTP handler) map that to a 401.
   */
  redeemPairingCode(code: string, deviceName: string): { deviceId: string; deviceToken: string } {
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

    const deviceId = generateDeviceId();
    const token = generateDeviceToken();
    const identity: DeviceIdentity = { deviceId, deviceName, token };
    this.devicesByToken.set(token, identity);
    this.devicesById.set(deviceId, identity);
    return { deviceId, deviceToken: token };
  }

  /** Resolve a bearer token (from the WS upgrade `Authorization` header) to a deviceId. */
  deviceIdForToken(token: string): string | undefined {
    return this.devicesByToken.get(token)?.deviceId;
  }

  getDeviceName(deviceId: string): string | undefined {
    return this.devicesById.get(deviceId)?.deviceName;
  }

  listDeviceIds(): string[] {
    return [...this.devicesById.keys()];
  }
}
