import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir, type EnsureSecureDirOptions } from '../util/secure-dir';

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

  /**
   * `secureDirOptions` is a test-only DI seam (mirrors `EnsureSecureDirOptions`'s
   * own `run`/`platform` overrides) — every real caller omits it, getting
   * real `ensureSecureDir(storeDir)` behavior unchanged. It exists so
   * finding R4's fail-closed contract ("on win32, an `icacls` failure makes
   * `save()` — and thus `AuthManager.pair()` — reject with a clear typed
   * `SecureDirHardeningError` instead of silently persisting an
   * ACL-unprotected credential") is verifiable from a real `darwin`/`linux`
   * CI/dev machine, not just asserted.
   */
  constructor(
    storeDir: string,
    private readonly secureDirOptions?: EnsureSecureDirOptions,
  ) {
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
    const storeDir = path.dirname(this.filePath);
    // `mkdir`'s own `mode` only applies at CREATION time — a pre-existing
    // storeDir (predating this fix, or created by something else with a
    // more permissive mode) keeps whatever it already had until explicitly
    // chmod'd. Re-asserted on every save, best-effort — mirrors
    // `bin/audit-log.ts`'s `appendAuditEvent`, which has the identical gap
    // (and the identical fix) for the same reason: a failure here (e.g. a
    // storeDir owned by a different user) must never block the save itself.
    // Finding F7: on win32, `ensureSecureDir` ALSO applies a restrictive
    // DACL via `icacls` — POSIX modes alone restrict nothing there. See
    // `util/secure-dir.ts`'s own doc comment. Finding R4: this now THROWS
    // (`SecureDirHardeningError`) on a win32 `icacls` failure instead of
    // warning and continuing — propagates straight out of `save()` (and so
    // out of `AuthManager.pair()`, since nothing here catches it), before
    // `device.json` is ever written.
    await ensureSecureDir(storeDir, this.secureDirOptions);
    // Atomic (temp file + rename) so a concurrent reader never observes a
    // torn/partial file and a crash mid-write never corrupts the existing
    // one — see `util/atomic-write.ts`. This file holds the device private
    // key, so both the atomicity and the 0600 mode are load-bearing, not
    // cosmetic; `{ mode: 0o600 }` is re-asserted on every save (not just the
    // one that first creates the file).
    await atomicWriteFile(this.filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
