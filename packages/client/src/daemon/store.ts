import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DeviceRecord {
  deviceId: string;
  /** Current access token (JWT), renewed via challenge/token without re-pairing (protocol §6.2). */
  accessToken: string;
  /** ISO-8601 expiry for `accessToken` (our best knowledge of it — see auth-manager.ts for how this is derived after `/byok/pair`, which reports no explicit expiry itself). */
  expiresAt: string;
  /** Ed25519 private key, PKCS8 PEM. Never leaves this device (0600 file fallback; OS keychain is M3). */
  devicePrivateKeyPem: string;
  /** Ed25519 public key, base64url — re-sent verbatim on a post-revocation re-pair (protocol §6.3). */
  devicePublicKey: string;
}

/**
 * Persists the device identity issued by `pair()` — deviceId, current
 * access token + its expiry, and the device's own Ed25519 keypair. This is
 * the ONLY credential material the daemon itself ever holds — never a
 * runtime's own credentials (see the credential-isolation rule on
 * `RuntimeAdapter`). Stored 0600 under `storeDir` (default
 * `~/.byok/<productId>/`); OS keychain storage is M3.
 */
export class DeviceStore {
  private readonly filePath: string;

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'device.json');
  }

  static defaultDir(productId: string): string {
    return path.join(os.homedir(), '.byok', productId);
  }

  async load(): Promise<DeviceRecord | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<DeviceRecord>;
    if (
      typeof parsed.deviceId === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.expiresAt === 'string' &&
      typeof parsed.devicePrivateKeyPem === 'string' &&
      typeof parsed.devicePublicKey === 'string'
    ) {
      return {
        deviceId: parsed.deviceId,
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
        devicePrivateKeyPem: parsed.devicePrivateKeyPem,
        devicePublicKey: parsed.devicePublicKey,
      };
    }
    return undefined;
  }

  async save(record: DeviceRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
    // `mode` on writeFile only applies when the file is created; force it in
    // case a previous, differently-permissioned file already existed. This
    // file holds the device private key, so 0600 is load-bearing, not cosmetic.
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
