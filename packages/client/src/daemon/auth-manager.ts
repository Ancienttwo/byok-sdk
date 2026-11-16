import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import {
  BYOK_CHALLENGE_PATH,
  BYOK_PAIR_PATH,
  BYOK_TOKEN_PATH,
  ChallengeResponseSchema,
  DeviceNotRegisteredResponseSchema,
  PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH,
  PairingCodeInvalidResponseSchema,
  PairResponseSchema,
  PairSupersededResponseSchema,
  pairDeviceDigest,
  TokenResponseSchema,
  type PairRequest,
  type PairResponse,
} from '@byok-sdk/protocol';
import {
  assertStoreBound,
  DeviceRecordRePairRequiredError,
  DeviceStore,
  type DeviceMetadata,
  type DeviceRecord,
} from './store.js';
import { DeviceCredentialLegacyEntryError, type DeviceCredentialBackend, type PairingAttempt } from './device-credential-store.js';
import { acquireEnrollmentGate, registerMemberWrites } from './enrollment-gate.js';
import {
  DeviceStoreBindingMismatchError,
  PairingAttemptRefusedError,
  PairingBusyError,
  PairingCodeRejectedError,
  PairingInputInvalidError,
  PairingSupersededError,
} from './daemon-errors.js';
import { generateDeviceKeyPair, exportPrivateKeyPem, importPrivateKeyPem, publicKeyOfPrivateKeyPem, signNonce } from './device-keys.js';
import { toHttpBase } from './url.js';
import { MAX_TIMER_DELAY_MS } from '../util/timer-delay.js';

/**
 * Thrown when the server has revoked this device (protocol §6.3): a
 * `/byok/challenge` or `/byok/token` 401 with the typed
 * `device_not_registered` body, or an untyped 401 that one rechecked exchange
 * met again. The only recourse is a fresh `/byok/pair` — callers must surface
 * a clear "re-pair needed" state and must NOT retry the renewal in a loop.
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
 * Thrown when a successful `/byok/challenge` or `/byok/token` response body
 * is not valid JSON or does not satisfy its protocol schema
 * (`ChallengeResponseSchema` / `TokenResponseSchema`, #386) — for example a
 * truncated body or a missing field such as `expiresIn` (#1114). The renewal or pairing fails and the prior credential
 * is kept unchanged; nothing is inferred from the malformed body. The JSON
 * `SyntaxError` or the schema failure rides in `cause`. Not a revocation.
 */
export class AuthResponseInvalidError extends Error {
  constructor(
    readonly route: 'challenge' | 'token' | 'pair',
    options?: { cause: unknown },
  ) {
    super(`${route === 'pair' ? 'pairing' : `token renewal (${route})`} failed: the server response does not match the protocol schema`, options);
    this.name = 'AuthResponseInvalidError';
  }
}

/**
 * The access token, held only in memory (#2045). `expiresAt` is device-local
 * (#1114): this device's receipt time plus the server's relative `expiresIn`,
 * compared only with this device's clock.
 */
interface AccessToken {
  readonly accessToken: string;
  readonly expiresAt: string;
}

type RenewedToken = AccessToken & {
  readonly clockSkew: ClockSkewObservation | undefined;
};

/** One answer of `POST /byok/pair` that decides the pairing; anything else throws. */
type PairOutcome =
  | { readonly kind: 'paired'; readonly body: PairResponse & { readonly expiresAt: string; readonly clockSkew: ClockSkewObservation | undefined } }
  | { readonly kind: 'conflict'; readonly currentDeviceDigest: string | null };

const PAIRING_CODE_DIGEST_NAMESPACE = 'byok-pairing-code-v1';

/** The local name of a pairing code in a staged attempt: a retry with the same code resumes it. The code itself is never stored. */
function pairingCodeDigest(pairingCode: string): string {
  return createHash('sha256').update(JSON.stringify([PAIRING_CODE_DIGEST_NAMESPACE, pairingCode]), 'utf8').digest('base64url');
}

/**
 * Reads a successful renewal body as JSON. A body read failure (abort,
 * network) propagates unchanged so `runRequest` still classifies it; only a
 * body that is not JSON becomes {@link AuthResponseInvalidError}.
 */
async function readAuthResponseJson(response: Response, route: 'challenge' | 'token' | 'pair'): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's message quotes the body; no server text enters an error.
    throw new AuthResponseInvalidError(route);
  }
}

/** Renew this long before a token's recorded expiry — both proactively (background timer) and as the "already close enough to expiry, renew now" reactive threshold. */
const RENEW_MARGIN_MS = 60 * 1000;
/**
 * Floor between two renewals that no server 401 forced (#1114). A fresh token
 * can already sit inside {@link RENEW_MARGIN_MS} when the server TTL is
 * shorter than the margin; without a floor every such renewal re-armed itself
 * at delay 0 and rewrote the OS credential entry in a tight loop. The floor stays at 30s after the first
 * such renewal and doubles from the second consecutive one, up to
 * {@link MAX_RENEW_INTERVAL_MS}.
 */
const MIN_RENEW_INTERVAL_MS = 30 * 1000;
const MAX_RENEW_INTERVAL_MS = 30 * 60 * 1000;
/** A bounded default for every device-auth HTTP exchange, including response-body reads. */
const DEFAULT_AUTH_REQUEST_DEADLINE_MS = 15_000;
/** Back-off before the one exchange that confirms an untyped renewal 401 (#1117). */
const UNTYPED_401_RECHECK_DELAY_MS = 1_000;

/**
 * One measurement of this device's clock against the server's HTTP `Date`
 * header (#1114). It is reported only (`byok-agent doctor`); token lifetime never
 * reads it.
 */
export interface ClockSkewObservation {
  /** Positive when the device clock is ahead of the server's. */
  readonly deviceAheadMs: number;
  /** Half the request round trip plus the header's one-second resolution. */
  readonly uncertaintyMs: number;
  /** ISO time the response arrived on the device clock. */
  readonly observedAt: string;
}

export interface AuthManagerOptions {
  serverUrl: string;
  store: DeviceStore;
  /** Internal-only credential custody seam. Product construction uses store.credentials. */
  credentials?: DeviceCredentialBackend;
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
  /** Called once a renewal finds the OS entry no longer holds this store's enrollment (#2034); the daemon halts with that reason. */
  onBindingLost?: (reason: 'store_not_bound' | 're_pair_required') => void;
}

/** Under the enrollment gate: the OS entry still holds `record`, or the binding is lost. Set by {@link AuthManager}'s static block. */
let checkBinding: (auth: AuthManager, record: DeviceRecord | undefined, signal: AbortSignal) => Promise<void>;

/** `predecessor`, or `cancel`'s reason once it aborts first. */
function queuedBehind(predecessor: Promise<void>, cancel: AbortSignal | undefined): Promise<void> {
  if (cancel === undefined) return predecessor;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(cancel.reason);
    if (cancel.aborted) return onAbort();
    cancel.addEventListener('abort', onAbort, { once: true });
    void predecessor.then(() => {
      cancel.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * Owns device pairing and the access token lifecycle (protocol §6):
 * generates/reuses the device Ed25519 keypair, pairs, and renews the access
 * token both proactively (before expiry) and reactively (on a 401 from any
 * caller). This is the single source of truth for "the current valid JWT"
 * that WS connects, blob HTTP calls, and the long-poll fallback all use.
 */
export class AuthManager {
  static {
    checkBinding = async (auth: AuthManager, record: DeviceRecord | undefined, signal: AbortSignal): Promise<void> => {
      let current: DeviceRecord | undefined;
      try {
        current = await auth.loadRecord(signal);
      } catch (error) {
        if (error instanceof DeviceStoreBindingMismatchError || error instanceof DeviceRecordRePairRequiredError) auth.loseBinding(error);
        if (error instanceof DeviceCredentialLegacyEntryError) auth.loseBinding(new DeviceRecordRePairRequiredError());
        throw error;
      }
      if (current === undefined || record === undefined) auth.loseBinding(new DeviceRecordRePairRequiredError());
      if (current.deviceId !== record.deviceId || current.tenantId !== record.tenantId || current.devicePublicKey !== record.devicePublicKey) {
        auth.loseBinding(new DeviceStoreBindingMismatchError(current, record));
      }
    };
    registerMemberWrites(<T>(auth: AuthManager, write: () => Promise<T>, signal: AbortSignal) => auth.runCredentialMutation((mutationSignal) => {
      const both = AbortSignal.any([mutationSignal, signal]);
      return auth.underEnrollmentGate(both, async () => {
        await checkBinding(auth, auth.record, both);
        return write();
      });
    }, signal));
  }

  private record: DeviceRecord | undefined;
  /**
   * Never persisted: the device key exchanges a new one whenever none is held,
   * so a daemon's first request after start runs `/byok/challenge` and
   * `/byok/token` (#2045).
   */
  private token: AccessToken | undefined;
  private renewing: Promise<string> | undefined;
  private proactiveTimer: ReturnType<typeof setTimeout> | undefined;
  private revoked = false;
  private stopped = false;
  private pairing = false;
  private credentialMutationTail: Promise<void> = Promise.resolve();
  /**
   * The sole cancellation authority for the serialized credential mutation
   * now running: its HTTP requests, back-off and OS credential commands all
   * take this signal.
   */
  private activeMutation: AbortController | undefined;
  // performance.now() of the last successful renewal, and how many renewals in
  // a row returned a token already inside the renewal margin.
  private lastRenewedAt: number | undefined;
  private nearExpiryRenewals = 0;
  // The exchange that produced the stored credential; undefined when its
  // response carried no parseable Date or the device clock was set back during
  // the request, so a stale or meaningless measurement is never shown.
  private lastClockSkew: ClockSkewObservation | undefined;

  private readonly credentials: DeviceCredentialBackend;
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

  /** The skew measured by the last successful pair or renewal, if its response carried a parseable `Date` and the device clock did not go back mid-request. */
  clockSkew(): ClockSkewObservation | undefined {
    return this.lastClockSkew;
  }

  /**
   * Internal signer read: always recompose metadata with the current OS
   * secret authority. Like every OS read here it is a credential mutation, so
   * {@link stop} cancels it.
   */
  async readCurrent(): Promise<DeviceRecord | undefined> {
    return this.runCredentialMutation((signal) => this.loadRecord(signal));
  }

  /**
   * Re-arm after {@link stop}. The daemon calls it inside a start or pair's
   * lifecycle slot, after checking that no later stop cancelled the request.
   */
  resume(): void {
    this.stopped = false;
  }

  /**
   * Load the paired device record for a daemon run. Every call rereads the
   * OS authority and revalidates this storeDir's binding (#1094), including
   * on an instance that already holds a record: another store may have
   * replaced the enrollment since. The read runs as a credential mutation,
   * so {@link stop} cancels a read hung on a locked keychain.
   */
  async loadExisting(): Promise<DeviceRecord | undefined> {
    const prior = this.record;
    this.record = undefined;
    this.record = await this.runCredentialMutation(async (signal) => {
      try {
        return await this.loadRecord(signal);
      } catch (error) {
        if (!(error instanceof DeviceCredentialLegacyEntryError)) throw error;
        // A wire v6 entry is void on a v7 cloud: delete it, then answer from
        // what remains, which is re-pair-required while device.json is there.
        await this.underEnrollmentGate(signal, () => this.deleteLegacyEntry(signal));
        return this.loadRecord(signal);
      }
    });
    // A token is kept only for the enrollment it was issued to.
    if (!sameEnrollment(prior, this.record)) this.token = undefined;
    if (this.record) this.scheduleProactiveRenewal();
    return this.record;
  }

  /**
   * `POST /byok/pair` (v2) with the registration fence (#2045). It refuses
   * with {@link DeviceStoreBindingMismatchError} while the OS entry holds an
   * enrollment this storeDir did not pair, unless `replaceOtherStore` states
   * the operator's intent to replace it, and with
   * {@link PairingAttemptRefusedError} while another storeDir's attempt is
   * staged, unless `replaceOtherStore` discards it (#2033).
   *
   * The enrollment gate is never held across the network:
   * 1. Under the gate it rereads the slot and stages an attempt: a retry with
   *    the same code resumes this store's staged attempt unchanged (#1767);
   *    any other pairing stages a new one, keyed by this store's enrollment
   *    key on a re-pair of its own enrollment and by a fresh key otherwise,
   *    with the fence digest of the slot's current enrollment.
   * 2. It sends the request.
   * 3. On a typed `409` it adopts the server's current device digest and
   *    resends once, only while the slot still holds exactly its attempt; a
   *    second `409` is {@link PairingBusyError}.
   * 4. On success it persists the enrollment under the gate, only while the
   *    slot still holds exactly its attempt, else {@link PairingSupersededError}.
   * A request that ends without a decisive answer leaves the attempt staged
   * for an exact retry with the same code.
   */
  async pair(pairingCode: string, options?: { readonly replaceOtherStore?: boolean }): Promise<DeviceRecord> {
    this.pairing = true;
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = undefined;
    try {
      return await this.runCredentialMutation(async (signal) => {
        const replaceOtherStore = options?.replaceOtherStore === true;
        const observedDeviceName = this.opts.deviceName ?? os.hostname();
        const observedMachineId = await this.opts.machineId?.();
        // The wire bounds both, and the staged attempt stores both.
        if (observedDeviceName.length === 0 || observedDeviceName.length > PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH) {
          throw new PairingInputInvalidError('deviceName');
        }
        if (observedMachineId !== undefined && !/^[0-9a-f]{64}$/u.test(observedMachineId)) throw new PairingInputInvalidError('machineId');
        const attempt = await this.underEnrollmentGate(signal, () =>
          this.stagePairingAttempt(signal, pairingCode, replaceOtherStore, observedDeviceName, observedMachineId));
        const devicePublicKey = publicKeyOfPrivateKeyPem(attempt.devicePrivateKeyPem);
        let outcome = await this.sendPairRequest(signal, pairingCode, attempt, devicePublicKey, attempt.expectedDeviceDigest);
        if (outcome.kind === 'conflict') {
          // Adopted only inside this invocation, never persisted: a later
          // invocation starts again from the staged digest.
          const adopted = outcome.currentDeviceDigest;
          await this.underEnrollmentGate(signal, () => this.assertOwnsAttempt(signal, attempt));
          outcome = await this.sendPairRequest(signal, pairingCode, attempt, devicePublicKey, adopted);
          if (outcome.kind === 'conflict') throw new PairingBusyError();
        }
        const { body } = outcome;
        const metadata: DeviceMetadata = {
          deviceId: body.deviceId,
          tenantId: body.tenantId,
          devicePublicKey,
        };
        const record: DeviceRecord = { ...metadata, devicePrivateKeyPem: attempt.devicePrivateKeyPem };
        await this.underEnrollmentGate(signal, async () => {
          await this.assertOwnsAttempt(signal, attempt);
          // device.json is this store's pair-time binding and a non-secret
          // projection. Write it first, then atomically replace the complete
          // OS enrollment authority, which consumes the attempt. If the
          // replace fails, the next load reports the binding mismatch; no
          // mixed identity/key can load.
          await this.opts.store.save(metadata);
          await this.credentials.replace(record, signal);
        });
        this.record = record;
        this.token = { accessToken: body.accessToken, expiresAt: body.expiresAt };
        this.lastClockSkew = body.clockSkew;
        this.revoked = false;
        return record;
      });
    } finally {
      // Pairing is a short-lived credential mutation, not the start of the
      // daemon lifecycle. loadExisting() is the only place that arms a timer.
      this.pairing = false;
    }
  }

  /**
   * One `POST /byok/pair`. A typed `401` is {@link PairingCodeRejectedError}
   * and a typed `409` a conflict. Any other answer, including an untyped
   * `409`, leaves the outcome unknown and throws a fixed message: no server
   * text enters an error.
   */
  private async sendPairRequest(
    signal: AbortSignal,
    pairingCode: string,
    attempt: PairingAttempt,
    devicePublicKey: string,
    expectedDeviceDigest: string | null,
  ): Promise<PairOutcome> {
    const url = new URL(BYOK_PAIR_PATH, toHttpBase(this.opts.serverUrl));
    const request: PairRequest = {
      pairingCode,
      deviceName: attempt.deviceName,
      devicePublicKey,
      // An unresolvable machine identity omits the field, the documented "no
      // supersession" case, never a placeholder shared by every device.
      ...(attempt.machineId === undefined ? {} : { machineId: attempt.machineId }),
      expectedDeviceDigest,
    };
    return this.runRequest(signal, async (requestSignal) => {
      const sentAt = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: requestSignal,
      });
      const receivedAt = Date.now();
      if (res.status === 401 && PairingCodeInvalidResponseSchema.safeParse(await readJsonOrUndefined(res)).success) {
        throw new PairingCodeRejectedError();
      }
      if (res.status === 409) {
        const conflict = PairSupersededResponseSchema.safeParse(await readJsonOrUndefined(res));
        if (conflict.success) return { kind: 'conflict', currentDeviceDigest: conflict.data.currentDeviceDigest };
      }
      if (!res.ok) throw new Error(`pairing failed: HTTP ${res.status}`);
      // Pairing is the only time an authenticated tenant binding may enter
      // local state. Parse the required wire contract before building the
      // one atomic DeviceRecord; no token claim or host configuration is an
      // alternate tenant authority.
      const paired = PairResponseSchema.safeParse(await readAuthResponseJson(res, 'pair'));
      if (!paired.success) throw new AuthResponseInvalidError('pair', { cause: paired.error });
      return {
        kind: 'paired',
        body: {
          ...paired.data,
          expiresAt: deviceLocalExpiry(receivedAt, paired.data.expiresIn),
          clockSkew: observeClockSkew(sentAt, receivedAt, res),
        },
      };
    });
  }

  /** The current, non-expired access token — renews first if it's expired or close to it. Throws {@link DeviceRevokedError} if the device has been revoked. */
  async getValidAccessToken(): Promise<string> {
    if (!this.record) throw new Error('device is not paired yet; call pair(pairingCode) first');
    if (this.revoked) throw new DeviceRevokedError();
    // A reactive 401 renewal is already the authority for the next token.
    // Returning the still-long-lived cached token here lets WS reconnect race
    // that renewal and present the same rejected bearer again.
    if (this.renewing) return this.renewing;
    const token = this.token;
    if (token === undefined) return this.renew();
    if (msUntilExpiry(token.expiresAt) > RENEW_MARGIN_MS) return token.accessToken;
    // Inside the renewal floor the cached token is the newest the server has
    // issued; the proactive timer renews when the floor ends, and a server 401
    // still renews at once through handleUnauthorized().
    if (this.msUntilRenewAllowed() > 0) return token.accessToken;
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
    // pair/renew and be blocked in fetch, a response-body read, the 401
    // back-off, or an OS credential command. The same tail remains the sole
    // credential persistence barrier, so shutdown cannot release daemon
    // ownership until that operation has observed cancellation.
    this.activeMutation?.abort();
    await this.credentialMutationTail;
  }

  private async renew(): Promise<string> {
    if (this.stopped) throw new Error('auth manager is stopped; load existing credentials before renewing');
    if (!this.renewing) {
      this.renewing = this.runCredentialMutation((signal) => this.doRenew(signal)).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  private async doRenew(signal: AbortSignal): Promise<string> {
    if (!this.record) throw new Error('device is not paired yet; call pair(pairingCode) first');
    const record = this.record;
    let body = await this.exchangeToken(record, signal);
    if (body === undefined) {
      // An untyped 401 is no revocation authority: a bad signature, a lost
      // nonce race, or a proxy answer looks the same. Back off, run one fresh
      // exchange, and halt only when the server rejects that one too.
      await this.backOff(signal);
      body = await this.exchangeToken(record, signal);
      if (body === undefined) this.markRevoked();
    }
    // The token is used only while this store still holds the enrollment it
    // was issued to (#2034); otherwise it is discarded and the binding is lost.
    await this.underEnrollmentGate(signal, () => checkBinding(this, record, signal));
    this.token = { accessToken: body.accessToken, expiresAt: body.expiresAt };
    this.lastClockSkew = body.clockSkew;
    this.lastRenewedAt = performance.now();
    this.nearExpiryRenewals = msUntilExpiry(body.expiresAt) > RENEW_MARGIN_MS ? 0 : this.nearExpiryRenewals + 1;
    this.scheduleProactiveRenewal();
    return body.accessToken;
  }

  /**
   * One challenge → token exchange. Resolves `undefined` when either step
   * answered an untyped 401; a typed revocation 401 halts inside.
   */
  private async exchangeToken(record: DeviceRecord, signal: AbortSignal): Promise<RenewedToken | undefined> {
    const base = toHttpBase(this.opts.serverUrl);
    const challenge = await this.runRequest(signal, async (requestSignal) => {
      const challengeRes = await fetch(new URL(BYOK_CHALLENGE_PATH, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: record.deviceId }),
        signal: requestSignal,
      });
      if (challengeRes.status === 401) return this.readUnauthorized(challengeRes);
      if (!challengeRes.ok) {
        throw new Error(`token renewal (challenge) failed: HTTP ${challengeRes.status}`);
      }
      const parsed = ChallengeResponseSchema.safeParse(await readAuthResponseJson(challengeRes, 'challenge'));
      if (!parsed.success) throw new AuthResponseInvalidError('challenge', { cause: parsed.error });
      return parsed.data;
    });
    if (challenge === undefined) return undefined;
    const signature = signNonce(importPrivateKeyPem(record.devicePrivateKeyPem), challenge.nonce);

    return this.runRequest(signal, async (requestSignal) => {
      const sentAt = Date.now();
      const tokenRes = await fetch(new URL(BYOK_TOKEN_PATH, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: record.deviceId, nonce: challenge.nonce, signature }),
        signal: requestSignal,
      });
      const receivedAt = Date.now();
      if (tokenRes.status === 401) return this.readUnauthorized(tokenRes);
      if (!tokenRes.ok) {
        throw new Error(`token renewal (token) failed: HTTP ${tokenRes.status}`);
      }
      const token = TokenResponseSchema.safeParse(await readAuthResponseJson(tokenRes, 'token'));
      if (!token.success) throw new AuthResponseInvalidError('token', { cause: token.error });
      return {
        accessToken: token.data.accessToken,
        expiresAt: deviceLocalExpiry(receivedAt, token.data.expiresIn),
        clockSkew: observeClockSkew(sentAt, receivedAt, tokenRes),
      };
    });
  }

  /** A typed revocation 401 halts now; any other 401 resolves `undefined` for the one recheck. */
  private async readUnauthorized(response: Response): Promise<undefined> {
    if (isDeviceNotRegistered(await response.text())) this.markRevoked();
    return undefined;
  }

  private backOff(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AuthRequestAbortedError('stopped'));
        return;
      }
      const onStop = () => {
        clearTimeout(timer);
        reject(new AuthRequestAbortedError('stopped'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onStop);
        resolve();
      }, UNTYPED_401_RECHECK_DELAY_MS);
      signal.addEventListener('abort', onStop, { once: true });
    });
  }

  /** The OS entry no longer holds this store's enrollment: drop the cached record, stop renewing and report it. Always throws `error`. */
  private loseBinding(error: DeviceStoreBindingMismatchError | DeviceRecordRePairRequiredError): never {
    this.record = undefined;
    this.token = undefined;
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = undefined;
    this.opts.onBindingLost?.(error instanceof DeviceStoreBindingMismatchError ? 'store_not_bound' : 're_pair_required');
    throw error;
  }

  private async underEnrollmentGate<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const gate = await acquireEnrollmentGate(this.opts.store.productId, signal);
    try {
      return await operation();
    } finally {
      await gate.release();
    }
  }

  /** Under the enrollment gate: this store's attempt for `pairingCode`, resumed or newly staged. */
  private async stagePairingAttempt(
    signal: AbortSignal,
    pairingCode: string,
    replaceOtherStore: boolean,
    observedDeviceName: string,
    observedMachineId: string | undefined,
  ): Promise<PairingAttempt> {
    const { existing, attempt: staged } = await this.pairingAuthority(signal, replaceOtherStore);
    const codeDigest = pairingCodeDigest(pairingCode);
    if (staged !== undefined && staged.codeDigest === codeDigest) return staged;
    // The fence names the slot's current enrollment, whichever store paired it.
    const current = await this.credentials.read(signal);
    const attempt: PairingAttempt = {
      kind: 'pairing-attempt-v2',
      attemptId: randomBytes(16).toString('base64url'),
      codeDigest,
      storeIdentity: this.opts.store.identity,
      deviceName: observedDeviceName,
      ...(observedMachineId === undefined ? {} : { machineId: observedMachineId }),
      devicePrivateKeyPem: existing?.devicePrivateKeyPem ?? exportPrivateKeyPem(generateDeviceKeyPair().privateKey),
      expectedDeviceDigest: current === undefined
        ? null
        : await pairDeviceDigest({ tenantId: current.tenantId, productId: this.opts.store.productId, deviceId: current.deviceId }),
    };
    // Persisted before the first request: if the server commits while its
    // response is lost, the retry with the same code sends this exact request.
    await this.credentials.savePairingAttempt(attempt, signal);
    return attempt;
  }

  /**
   * Under the enrollment gate: the slot still holds exactly `attempt`, the
   * one this invocation staged or resumed. Otherwise another pairing replaced
   * it, and this one must neither resend nor persist.
   */
  private async assertOwnsAttempt(signal: AbortSignal, attempt: PairingAttempt): Promise<void> {
    const current = await this.credentials.readPairingAttempt(signal);
    if (
      current === undefined ||
      current.storeIdentity !== attempt.storeIdentity ||
      current.attemptId !== attempt.attemptId ||
      current.codeDigest !== attempt.codeDigest ||
      current.devicePrivateKeyPem !== attempt.devicePrivateKeyPem
    ) {
      throw new PairingSupersededError();
    }
  }

  /** Under the enrollment gate: deletes the OS entry only while it still holds the wire v6 format. */
  private async deleteLegacyEntry(signal: AbortSignal): Promise<void> {
    try {
      await this.credentials.read(signal);
    } catch (error) {
      if (!(error instanceof DeviceCredentialLegacyEntryError)) throw error;
      await this.credentials.clear(signal);
    }
  }

  /**
   * Under the enrollment gate, reread from the OS entry and `device.json`:
   * this store's bound enrollment, and its own staged attempt (undefined when
   * none, or when `replaceOtherStore` discards another store's). A wire v6
   * entry is deleted first, so the store pairs as a first pairing. Another
   * store's enrollment or attempt is refused, also beside this store's
   * enrollment: the pairing would consume that attempt (#2033, #2030 F1).
   */
  private async pairingAuthority(
    signal: AbortSignal,
    replaceOtherStore: boolean,
  ): Promise<{ readonly existing: DeviceRecord | undefined; readonly attempt: PairingAttempt | undefined }> {
    await this.deleteLegacyEntry(signal);
    let existing: DeviceRecord | undefined;
    try {
      existing = await this.loadRecord(signal);
    } catch (error) {
      // Explicit pairing is the one authorized replacement path for a
      // legacy/tampered enrollment file. It never reads through it: a fresh
      // keypair and complete authenticated PairResponse replace the record
      // atomically. Another store's enrollment is replaced only on the
      // operator's explicit request.
      const replaceable = error instanceof DeviceRecordRePairRequiredError ||
        (error instanceof DeviceStoreBindingMismatchError && replaceOtherStore);
      if (!replaceable) throw error;
    }
    const staged = await this.credentials.readPairingAttempt(signal);
    if (staged !== undefined && staged.storeIdentity !== this.opts.store.identity) {
      if (!replaceOtherStore) throw new PairingAttemptRefusedError();
      return { existing, attempt: undefined };
    }
    return { existing, attempt: staged };
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
    // Without a token there is nothing to keep fresh: the next request exchanges one.
    if (!this.record || !this.token || this.revoked || this.stopped || this.pairing) return;
    const delay = Math.max(0, msUntilExpiry(this.token.expiresAt) - RENEW_MARGIN_MS, this.msUntilRenewAllowed());
    // A far-future expiry exceeds what one timer can hold (it would fire at
    // 1 ms). Arm a capped step and re-derive the delay from `expiresAt` when
    // it elapses; renewal only runs once the real renewal point is reached.
    const capped = delay > MAX_TIMER_DELAY_MS;
    const timer = setTimeout(() => {
      if (capped) {
        this.scheduleProactiveRenewal();
        return;
      }
      this.renew().catch(() => {
        // Best-effort background renewal; a real failure (including
        // DeviceRevokedError) surfaces to whoever next calls
        // getValidAccessToken()/handleUnauthorized() instead of being lost here.
      });
    }, capped ? MAX_TIMER_DELAY_MS : delay);
    timer.unref?.();
    this.proactiveTimer = timer;
  }

  private msUntilRenewAllowed(): number {
    if (this.lastRenewedAt === undefined) return 0;
    const interval = Math.min(MAX_RENEW_INTERVAL_MS, MIN_RENEW_INTERVAL_MS * 2 ** Math.max(0, this.nearExpiryRenewals - 1));
    return Math.max(0, this.lastRenewedAt + interval - performance.now());
  }

  /**
   * Bounds one complete auth exchange rather than fetch alone. Keeping the
   * controller active through `json()`/`text()` makes a non-cooperative or
   * partial response body cancellable by the same authority that owns fetch.
   */
  private async runRequest<T>(mutation: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (mutation.aborted) throw new AuthRequestAbortedError('stopped');
    const controller = new AbortController();
    let deadlineElapsed = false;
    const deadline = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort();
    }, this.requestDeadlineMs);
    const onStop = () => controller.abort();
    mutation.addEventListener('abort', onStop, { once: true });
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
      mutation.removeEventListener('abort', onStop);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async runCredentialMutation<T>(operation: (signal: AbortSignal) => Promise<T>, cancel?: AbortSignal): Promise<T> {
    const predecessor = this.credentialMutationTail;
    let release!: () => void;
    this.credentialMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await queuedBehind(predecessor, cancel);
    } catch (error) {
      // A cancelled waiter leaves the queue now and runs nothing; its successors still wait for the predecessor.
      void predecessor.then(release);
      throw error;
    }
    const controller = new AbortController();
    // A stop() that landed while this mutation queued already cancelled it.
    if (this.stopped) controller.abort();
    this.activeMutation = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (this.activeMutation === controller) this.activeMutation = undefined;
      release();
    }
  }

  /**
   * Read the current paired authority afresh; metadata without its OS secret
   * is re-pair required, and an OS enrollment this storeDir's `device.json`
   * does not name is never adopted.
   */
  private async loadRecord(signal?: AbortSignal): Promise<DeviceRecord | undefined> {
    const authority = await this.credentials.read(signal);
    const projection = await this.opts.store.load();
    if (authority === undefined) {
      // Distinguish a genuinely unpaired machine from a partial/legacy file.
      if (projection === undefined) return undefined;
      throw new DeviceRecordRePairRequiredError();
    }
    assertStoreBound(projection, authority);
    return Object.freeze({ ...authority });
  }
}

function sameEnrollment(a: DeviceRecord | undefined, b: DeviceRecord | undefined): boolean {
  return a !== undefined && b !== undefined &&
    a.deviceId === b.deviceId && a.tenantId === b.tenantId && a.devicePublicKey === b.devicePublicKey;
}

function msUntilExpiry(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}

/**
 * `expiresAt` is device-local (#1114): this device's receipt time
 * plus the server's relative `expiresIn`, so {@link msUntilExpiry} compares it
 * only with the same device clock. `refreshHint` is never read for lifetime.
 */
function deviceLocalExpiry(receivedAt: number, expiresInSeconds: number): string {
  return new Date(receivedAt + expiresInSeconds * 1000).toISOString();
}

/**
 * Measures the device clock against the response's `Date` header, assuming the
 * server stamped it midway through the round trip. A missing or unparseable
 * header is unknown: no other field of the response is a server-time source.
 * So is a round trip that ends before it starts: the device clock was set back
 * mid-request, and neither the midpoint nor the uncertainty means anything.
 */
function observeClockSkew(sentAt: number, receivedAt: number, response: Response): ClockSkewObservation | undefined {
  if (receivedAt < sentAt) return undefined;
  const header = response.headers.get('date');
  if (header === null) return undefined;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return undefined;
  return {
    deviceAheadMs: (sentAt + receivedAt) / 2 - serverMs,
    uncertaintyMs: Math.ceil((receivedAt - sentAt) / 2) + 1000,
    observedAt: new Date(receivedAt).toISOString(),
  };
}

function resolveRequestDeadlineMs(value: number | undefined): number {
  const deadline = value ?? DEFAULT_AUTH_REQUEST_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error('authRequestDeadlineMs must be a positive safe integer');
  }
  return deadline;
}

/**
 * The one authority for "this renewal 401 is a revocation": the body parses
 * as {@link DeviceNotRegisteredResponseSchema}. Message text is never read.
 */
function isDeviceNotRegistered(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return DeviceNotRegisteredResponseSchema.safeParse(parsed).success;
}

/** A rejection body read only to match a typed schema; unreadable or non-JSON is no match. Its text never enters an error. */
async function readJsonOrUndefined(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
