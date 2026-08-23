import os from 'node:os';
import { BYOK_CHALLENGE_PATH, BYOK_PAIR_PATH, BYOK_TOKEN_PATH, PairResponseSchema } from '@byok-sdk/protocol';
import type { ChallengeResponse, TokenResponse } from '@byok-sdk/protocol';
import { DeviceRecordRePairRequiredError, DeviceStore, type DeviceRecord } from './store';
import { generateDeviceKeyPair, exportPrivateKeyPem, importPrivateKeyPem, signNonce } from './device-keys';
import { toHttpBase } from './url';

/**
 * Thrown when the server has revoked this device: a 401 on `/byok/challenge`
 * or `/byok/token` (protocol §6.3). The only recourse is a fresh
 * `/byok/pair` — callers must surface a clear "re-pair needed" state and
 * must NOT retry the renewal in a loop.
 */
export class DeviceRevokedError extends Error {
  constructor(message = 'device has been revoked by the server; re-pair required') {
    super(message);
    this.name = 'DeviceRevokedError';
  }
}

/**
 * Conservative assumed lifetime for the token minted directly by
 * `/byok/pair`, which — unlike `/byok/token` — reports no explicit
 * `expiresAt` (only an opaque `refreshHint`). docs/protocol.md §6.1
 * documents a "~1h lifetime"; renewing proactively well before that leaves a
 * comfortable margin regardless of what `refreshHint` turns out to mean.
 */
const ASSUMED_PAIR_TOKEN_TTL_MS = 45 * 60 * 1000;
/** Renew this long before a token's recorded expiry — both proactively (background timer) and as the "already close enough to expiry, renew now" reactive threshold. */
const RENEW_MARGIN_MS = 60 * 1000;

export interface AuthManagerOptions {
  serverUrl: string;
  store: DeviceStore;
  deviceName?: string;
  /** Called once revocation is detected, so a caller (ConnectionManager) can stop retrying and surface the state instead of looping. */
  onRevoked?: () => void;
}

/**
 * Owns device pairing and the access token lifecycle (protocol §6):
 * generates/reuses the device Ed25519 keypair, pairs, and renews the access
 * token both proactively (before expiry) and reactively (on a 401 from any
 * caller). This is the single source of truth for "the current valid JWT"
 * that WS connects, blob HTTP calls, and the long-poll fallback all use.
 */
export class AuthManager {
  private record: DeviceRecord | undefined;
  private renewing: Promise<string> | undefined;
  private proactiveTimer: ReturnType<typeof setTimeout> | undefined;
  private revoked = false;
  private stopped = false;
  private pairing = false;
  private credentialMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: AuthManagerOptions) {}

  get deviceId(): string | undefined {
    return this.record?.deviceId;
  }

  isRevoked(): boolean {
    return this.revoked;
  }

  /** Load a previously-paired device record from disk, if any (idempotent — a second call is a no-op once loaded). */
  async loadExisting(): Promise<DeviceRecord | undefined> {
    this.stopped = false;
    if (!this.record) {
      this.record = await this.opts.store.load();
    }
    if (this.record) this.scheduleProactiveRenewal();
    return this.record;
  }

  /** `POST /byok/pair` (v2): generates a device keypair on first pair, reuses it on any subsequent (e.g. post-revocation) re-pair. */
  async pair(pairingCode: string): Promise<DeviceRecord> {
    this.stopped = false;
    this.pairing = true;
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = undefined;
    try {
      return await this.runCredentialMutation(async () => {
        let existing = this.record;
        if (!existing) {
          try {
            existing = await this.opts.store.load();
          } catch (error) {
            // Explicit pairing is the one authorized replacement path for a
            // legacy/tampered enrollment file. It never reads through it: a
            // fresh keypair and complete authenticated PairResponse replace
            // the record atomically below.
            if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
          }
        }
        const keyPair = existing
          ? { privateKey: importPrivateKeyPem(existing.devicePrivateKeyPem), publicKeyBase64Url: existing.devicePublicKey }
          : generateDeviceKeyPair();

        const url = new URL(BYOK_PAIR_PATH, toHttpBase(this.opts.serverUrl));
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pairingCode,
            deviceName: this.opts.deviceName ?? os.hostname(),
            devicePublicKey: keyPair.publicKeyBase64Url,
          }),
        });
        if (!res.ok) {
          throw new Error(`pairing failed: HTTP ${res.status} ${await safeErrorText(res)}`.trimEnd());
        }
        // Pairing is the only time an authenticated tenant binding may enter
        // local state. Parse the required wire contract before building the
        // one atomic DeviceRecord; no token claim or host configuration is an
        // alternate tenant authority.
        const body = PairResponseSchema.parse(await res.json());

        const record: DeviceRecord = {
          deviceId: body.deviceId,
          tenantId: body.tenantId,
          accessToken: body.accessToken,
          expiresAt: resolvePairExpiry(body.refreshHint),
          devicePrivateKeyPem: exportPrivateKeyPem(keyPair.privateKey),
          devicePublicKey: keyPair.publicKeyBase64Url,
        };
        await this.opts.store.save(record);
        this.record = record;
        this.revoked = false;
        return record;
      });
    } finally {
      this.pairing = false;
      // Pairing is a short-lived credential mutation, not the start of the
      // daemon lifecycle. loadExisting() is the only place that arms a timer.
    }
  }

  /** The current, non-expired access token — renews first if it's expired or close to it. Throws {@link DeviceRevokedError} if the device has been revoked. */
  async getValidAccessToken(): Promise<string> {
    if (!this.record) throw new Error('device is not paired yet; call pair(pairingCode) first');
    if (this.revoked) throw new DeviceRevokedError();
    // A reactive 401 renewal is already the authority for the next token.
    // Returning the still-long-lived cached token here lets WS reconnect race
    // that renewal and present the same rejected bearer again.
    if (this.renewing) return this.renewing;
    if (msUntilExpiry(this.record.expiresAt) > RENEW_MARGIN_MS) return this.record.accessToken;
    return this.renew();
  }

  /** Force a renewal regardless of the cached token's remaining lifetime — the reactive path, used after a caller sees a 401. */
  async handleUnauthorized(): Promise<string> {
    if (this.revoked) throw new DeviceRevokedError();
    return this.renew();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = undefined;
    // A timer may already have entered renew() before stop() cleared it. Its
    // final step persists device.json, so daemon ownership cannot be released
    // until that promise settles. Renewal failure is surfaced later by the
    // next token consumer; shutdown only needs the writer barrier here.
    await this.credentialMutationTail;
  }

  private async renew(): Promise<string> {
    if (this.stopped) throw new Error('auth manager is stopped; load existing credentials before renewing');
    if (!this.renewing) {
      this.renewing = this.runCredentialMutation(() => this.doRenew()).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  private async doRenew(): Promise<string> {
    if (!this.record) throw new Error('device is not paired yet; call pair(pairingCode) first');
    const record = this.record;
    const base = toHttpBase(this.opts.serverUrl);
    const privateKey = importPrivateKeyPem(record.devicePrivateKeyPem);

    const challengeRes = await fetch(new URL(BYOK_CHALLENGE_PATH, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: record.deviceId }),
    });
    if (challengeRes.status === 401) this.markRevoked();
    if (!challengeRes.ok) {
      throw new Error(
        `token renewal (challenge) failed: HTTP ${challengeRes.status} ${await safeErrorText(challengeRes)}`.trimEnd(),
      );
    }
    const { nonce } = (await challengeRes.json()) as ChallengeResponse;
    const signature = signNonce(privateKey, nonce);

    const tokenRes = await fetch(new URL(BYOK_TOKEN_PATH, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: record.deviceId, nonce, signature }),
    });
    if (tokenRes.status === 401) this.markRevoked();
    if (!tokenRes.ok) {
      throw new Error(`token renewal (token) failed: HTTP ${tokenRes.status} ${await safeErrorText(tokenRes)}`.trimEnd());
    }
    const body = (await tokenRes.json()) as TokenResponse;
    const updated: DeviceRecord = { ...record, accessToken: body.accessToken, expiresAt: body.expiresAt };
    await this.opts.store.save(updated);
    this.record = updated;
    this.scheduleProactiveRenewal();
    return updated.accessToken;
  }

  /** Always throws — `never` return type lets call sites use `if (x === 401) this.markRevoked();` without an explicit `return`/`throw` of their own. */
  private markRevoked(): never {
    this.revoked = true;
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.opts.onRevoked?.();
    throw new DeviceRevokedError();
  }

  private scheduleProactiveRenewal(): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = undefined;
    if (!this.record || this.revoked || this.stopped || this.pairing) return;
    const delay = Math.max(0, msUntilExpiry(this.record.expiresAt) - RENEW_MARGIN_MS);
    const timer = setTimeout(() => {
      this.renew().catch(() => {
        // Best-effort background renewal; a real failure (including
        // DeviceRevokedError) surfaces to whoever next calls
        // getValidAccessToken()/handleUnauthorized() instead of being lost here.
      });
    }, delay);
    timer.unref?.();
    this.proactiveTimer = timer;
  }

  private async runCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.credentialMutationTail;
    let release!: () => void;
    this.credentialMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function msUntilExpiry(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}

function resolvePairExpiry(refreshHint: string | undefined): string {
  if (refreshHint) {
    const parsed = new Date(refreshHint);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(Date.now() + ASSUMED_PAIR_TOKEN_TTL_MS).toISOString();
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
