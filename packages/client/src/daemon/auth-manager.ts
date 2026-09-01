import os from 'node:os';
import { BYOK_CHALLENGE_PATH, BYOK_PAIR_PATH, BYOK_TOKEN_PATH, PairResponseSchema } from '@byok-sdk/protocol';
import type { ChallengeResponse, TokenResponse } from '@byok-sdk/protocol';
import { DeviceRecordRePairRequiredError, DeviceStore, type DeviceMetadata, type DeviceRecord } from './store';
import type { DeviceCredentialStore, InMemoryDeviceCredentialStore } from './device-credential-store';
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
 * Thrown when the local AuthManager deadline or shutdown cancels its own
 * in-flight request. This is deliberately distinct from `DeviceRevokedError`:
 * only an actual challenge/token HTTP 401 is server authority for revocation.
 */
export class AuthRequestAbortedError extends Error {
  constructor(readonly reason: 'deadline' | 'stopped') {
    super(reason === 'deadline' ? 'authentication request exceeded its deadline' : 'authentication request was cancelled during shutdown');
    this.name = 'AuthRequestAbortedError';
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
/** A bounded default for every device-auth HTTP exchange, including response-body reads. */
const DEFAULT_AUTH_REQUEST_DEADLINE_MS = 15_000;

export interface AuthManagerOptions {
  serverUrl: string;
  store: DeviceStore;
  /** Internal-only credential custody seam. Product construction uses store.credentials. */
  credentials?: DeviceCredentialStore | InMemoryDeviceCredentialStore;
  deviceName?: string;
  /**
   * Optional resolver for the client-hashed physical machine identity sent
   * with `POST /byok/pair` (protocol §6.1). Resolved once per pair attempt; a
   * resolver that yields `undefined` omits the field entirely rather than
   * sending a placeholder, because the server treats its presence as
   * permission to supersede this machine's prior active device rows.
   */
  machineId?: () => Promise<string | undefined>;
  /** Upper bound for one pair/challenge/token fetch plus its response-body read. */
  authRequestDeadlineMs?: number;
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
  /** The sole cancellation authority for the request currently inside the serialized credential mutation. */
  private activeRequest: AbortController | undefined;

  private readonly credentials: DeviceCredentialStore | InMemoryDeviceCredentialStore;
  private readonly requestDeadlineMs: number;

  constructor(private readonly opts: AuthManagerOptions) {
    this.credentials = opts.credentials ?? opts.store.credentials;
    this.requestDeadlineMs = resolveRequestDeadlineMs(opts.authRequestDeadlineMs);
  }

  get deviceId(): string | undefined {
    return this.record?.deviceId;
  }

  isRevoked(): boolean {
    return this.revoked;
  }

  /** Internal signer read: always recompose metadata with the current OS secret authority. */
  async readCurrent(): Promise<DeviceRecord | undefined> {
    return this.loadRecord();
  }

  /** Load a previously-paired device record from disk, if any (idempotent — a second call is a no-op once loaded). */
  async loadExisting(): Promise<DeviceRecord | undefined> {
    this.stopped = false;
    if (!this.record) {
      this.record = await this.loadRecord();
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
            existing = await this.loadRecord();
          } catch (error) {
            // Explicit pairing is the one authorized replacement path for a
            // legacy/tampered enrollment file. It never reads through it: a
            // fresh keypair and complete authenticated PairResponse replace
            // the record atomically below.
            if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
          }
        }
        // These request facts join the key as one immutable first-pair
        // attempt. A retry after process restart must not silently change its
        // server-side binding because hostname/config or machine observation
        // changed after the registration commit.
        const observedDeviceName = this.opts.deviceName ?? os.hostname();
        const observedMachineId = await this.opts.machineId?.();
        let keyPair: ReturnType<typeof generateDeviceKeyPair>;
        let pairingDeviceName = observedDeviceName;
        let pairingMachineId = observedMachineId;
        if (existing) {
          keyPair = { privateKey: importPrivateKeyPem(existing.devicePrivateKeyPem), publicKeyBase64Url: existing.devicePublicKey };
        } else {
          const firstAttempt = await this.credentials.readFirstPairingAttempt();
          if (firstAttempt) {
            keyPair = {
              privateKey: importPrivateKeyPem(firstAttempt.devicePrivateKeyPem),
              publicKeyBase64Url: firstAttempt.devicePublicKey,
            };
            pairingDeviceName = firstAttempt.deviceName;
            pairingMachineId = firstAttempt.machineId;
          } else {
            keyPair = generateDeviceKeyPair();
            // Persist before the first network request. If the server commits
            // while its response is lost, the explicit retry uses this exact key.
            await this.credentials.saveFirstPairingAttempt({
              kind: 'first-pairing-attempt-v1',
              deviceName: pairingDeviceName,
              devicePublicKey: keyPair.publicKeyBase64Url,
              devicePrivateKeyPem: exportPrivateKeyPem(keyPair.privateKey),
              ...(pairingMachineId === undefined ? {} : { machineId: pairingMachineId }),
            });
          }
        }

        const url = new URL(BYOK_PAIR_PATH, toHttpBase(this.opts.serverUrl));
        // Best-effort and optional: an unresolvable machine identity omits the
        // field, which is the documented "no supersession" case — it never
        // becomes an empty string or any other placeholder the server would
        // then treat as a real machine shared by every unidentifiable device.
        const body = await this.runRequest(async (signal) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              pairingCode,
              deviceName: pairingDeviceName,
              devicePublicKey: keyPair.publicKeyBase64Url,
              ...(pairingMachineId === undefined ? {} : { machineId: pairingMachineId }),
            }),
            signal,
          });
          if (!res.ok) {
            throw new Error(`pairing failed: HTTP ${res.status} ${await safeErrorText(res)}`.trimEnd());
          }
          // Pairing is the only time an authenticated tenant binding may enter
          // local state. Parse the required wire contract before building the
          // one atomic DeviceRecord; no token claim or host configuration is an
          // alternate tenant authority.
          return PairResponseSchema.parse(await res.json());
        });

        const metadata: DeviceMetadata = {
          deviceId: body.deviceId,
          tenantId: body.tenantId,
          devicePublicKey: keyPair.publicKeyBase64Url,
        };
        const record: DeviceRecord = {
          ...metadata,
          accessToken: body.accessToken,
          expiresAt: resolvePairExpiry(body.refreshHint),
          devicePrivateKeyPem: exportPrivateKeyPem(keyPair.privateKey),
        };
        // device.json is a deterministic non-secret projection. Write it
        // first, then atomically replace the complete OS enrollment authority.
        // If the authoritative replace fails, a restart repairs the projection
        // from the still-current OS record; no mixed identity/key can load.
        await this.opts.store.save(metadata);
        await this.credentials.replace(record);
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
    // Abort before waiting on the writer tail: a timer may already have entered
    // pair/renew and be blocked in fetch or a response-body read. The same tail
    // remains the sole credential persistence barrier, so shutdown cannot
    // release daemon ownership until that operation has observed cancellation.
    this.activeRequest?.abort();
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

    const { nonce } = await this.runRequest(async (signal) => {
      const challengeRes = await fetch(new URL(BYOK_CHALLENGE_PATH, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: record.deviceId }),
        signal,
      });
      if (challengeRes.status === 401) this.markRevoked();
      if (!challengeRes.ok) {
        throw new Error(
          `token renewal (challenge) failed: HTTP ${challengeRes.status} ${await safeErrorText(challengeRes)}`.trimEnd(),
        );
      }
      return (await challengeRes.json()) as ChallengeResponse;
    });
    const signature = signNonce(privateKey, nonce);

    const body = await this.runRequest(async (signal) => {
      const tokenRes = await fetch(new URL(BYOK_TOKEN_PATH, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: record.deviceId, nonce, signature }),
        signal,
      });
      if (tokenRes.status === 401) this.markRevoked();
      if (!tokenRes.ok) {
        throw new Error(`token renewal (token) failed: HTTP ${tokenRes.status} ${await safeErrorText(tokenRes)}`.trimEnd());
      }
      return (await tokenRes.json()) as TokenResponse;
    });
    const updated: DeviceRecord = {
      ...record,
      accessToken: body.accessToken,
      expiresAt: body.expiresAt,
    };
    // Renewal atomically replaces the complete enrollment authority; identity
    // and key cannot drift from the new token/expiry.
    await this.credentials.replace(updated);
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

  /**
   * Bounds one complete auth exchange rather than fetch alone. Keeping the
   * controller active through `json()`/`text()` makes a non-cooperative or
   * partial response body cancellable by the same authority that owns fetch.
   */
  private async runRequest<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped) throw new AuthRequestAbortedError('stopped');
    const controller = new AbortController();
    this.activeRequest = controller;
    let deadlineElapsed = false;
    const deadline = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort();
    }, this.requestDeadlineMs);
    let rejectOnAbort!: (error: AuthRequestAbortedError) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = () => rejectOnAbort(new AuthRequestAbortedError(deadlineElapsed ? 'deadline' : 'stopped'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (controller.signal.aborted) throw new AuthRequestAbortedError(deadlineElapsed ? 'deadline' : 'stopped');
      throw error;
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
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

  /** Read the current paired authority afresh; metadata without its OS secret is re-pair required. */
  private async loadRecord(): Promise<DeviceRecord | undefined> {
    const authority = await this.credentials.read();
    if (authority === undefined) {
      // Distinguish a genuinely unpaired machine from a partial/legacy file.
      if ((await this.opts.store.load()) === undefined) return undefined;
      throw new DeviceRecordRePairRequiredError();
    }

    const projection: DeviceMetadata = {
      deviceId: authority.deviceId,
      tenantId: authority.tenantId,
      devicePublicKey: authority.devicePublicKey,
    };
    // Missing or valid-but-stale non-secret projection is repairable. A
    // legacy secret-bearing, malformed or tampered projection throws and may
    // only be replaced by explicit authenticated pair(), never steady state.
    const current = await this.opts.store.load();
    if (
      current === undefined ||
      current.deviceId !== projection.deviceId ||
      current.tenantId !== projection.tenantId ||
      current.devicePublicKey !== projection.devicePublicKey
    ) {
      await this.opts.store.save(projection);
    }
    return Object.freeze({ ...authority });
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

function resolveRequestDeadlineMs(value: number | undefined): number {
  const deadline = value ?? DEFAULT_AUTH_REQUEST_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error('authRequestDeadlineMs must be a positive safe integer');
  }
  return deadline;
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
