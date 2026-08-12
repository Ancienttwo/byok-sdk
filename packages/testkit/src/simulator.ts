/**
 * `createDeviceSimulator` — one device, driven over the real device wire.
 *
 * The problem this exists to remove: a host integrating the SDK writes a smoke
 * test, and to write it has to re-implement the device end of docs/protocol.md
 * §6 by hand — generate an Ed25519 key, export the JWK `x`, know that a nonce
 * is signed under a domain prefix, know the exact literal, know the three auth
 * route shapes. Every one of those is upstream knowledge living downstream, so
 * when upstream changes the domain or the pairing schema, every host's smoke
 * test keeps passing against nothing.
 *
 * So this package owns the device end, and owns *nothing else*:
 *
 * - The bytes signed for a challenge come from `@byok-sdk/core`'s
 *   `nonceSigningBytes`. There is no domain literal in this package — a
 *   simulator carrying its own copy would be the fourth copy of the drift this
 *   slice removed.
 * - The request/response DTOs are parsed with `@byok-sdk/protocol`'s schemas,
 *   fail-closed. A response this package cannot parse is an error, never a
 *   partially-trusted object.
 * - The paths are the hosted surface's real ones (`POST /byok/pair`,
 *   `POST /byok/challenge`, `POST /byok/token`, `PUT /byok/presence`).
 *
 * What it deliberately does NOT own is the host control plane. The SDK mounts
 * no admin route: minting a pairing code, listing presence, and revoking a
 * device are in-process calls on `ByokCloud`/`ByokServer`, and a deployment
 * that exposes them over HTTP defines those paths and their credential itself.
 * Inventing `/byok/admin/...` here would be publishing a wire contract that
 * does not exist, so the host surface arrives as a {@link SimulatorHost}
 * adapter the caller supplies — three methods, in-process or HTTP, its choice.
 */
import type { PresenceHint, PresenceLevel } from '@byok-sdk/core';
import {
  BYOK_CHALLENGE_PATH,
  BYOK_PAIR_PATH,
  BYOK_PRESENCE_PATH,
  BYOK_TOKEN_PATH,
  ChallengeResponseSchema,
  PairResponseSchema,
  TokenResponseSchema,
} from '@byok-sdk/protocol';
import { createDeviceIdentity, type DeviceIdentity } from './identity';

/** The device-surface routes this simulator drives (docs/protocol.md §6, §12.3). */
export const DEVICE_ROUTES = {
  pair: BYOK_PAIR_PATH,
  challenge: BYOK_CHALLENGE_PATH,
  token: BYOK_TOKEN_PATH,
  presence: BYOK_PRESENCE_PATH,
} as const;

export const DEFAULT_DEVICE_NAME = 'byok-testkit-device';

/**
 * The host control plane, supplied by the caller.
 *
 * In-process (`cloud.listPresence(tenant)`) and over HTTP (the host's own admin
 * route plus whatever credential guards it) are both one small adapter. What
 * this package will not do is guess either the path or the credential.
 */
export interface SimulatorHost {
  /** Every live presence hint the host can see for the tenant under test. */
  listPresence(): Promise<readonly PresenceHint[]>;
  /** Revoke a device. After this, its next challenge/token/authed call is a 401 (§6.3). */
  revokeDevice(deviceId: string): Promise<void>;
}

export interface DeviceSimulatorOptions {
  /** Origin the device surface is mounted at, e.g. `https://cloud.example.com`. */
  readonly baseUrl: string;
  /** Defaults to `globalThis.fetch`. A composition with no socket passes its own `cloud.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Host control plane. Absent is legal; `readHostPresence`/`revoke` then throw rather than guess. */
  readonly host?: SimulatorHost;
  /** Device name sent at pairing time. */
  readonly deviceName?: string;
}

/** What `POST /byok/pair` handed back — the device's identity on this deployment. */
export interface DeviceSession {
  readonly deviceId: string;
  readonly accessToken: string;
}

export type Credential = 'device' | 'none';

export interface SimulatorRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  /** `'device'` sends the current access token; `'none'` sends no Authorization header. */
  readonly credential?: Credential;
}

export interface SimulatorResponse {
  readonly status: number;
  /** The response body verbatim. */
  readonly text: string;
  /**
   * `text` parsed as JSON, or `undefined` when it is empty or is not JSON at
   * all — a 404 from a router that answers in plain text is a real answer, and
   * the status is what an assertion is asking about. Absent means "no JSON
   * here", never "here is what it probably meant": every caller that needs a
   * DTO runs it through a `@byok-sdk/protocol` schema, which refuses
   * `undefined` outright.
   */
  readonly body: unknown;
}

/** A request that did not get the status this call requires. Carries the response, not a summary of it. */
export class DeviceSimulatorError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;

  constructor(message: string, response: SimulatorResponse) {
    super(`${message} (HTTP ${response.status}): ${response.text || '<empty body>'}`);
    this.name = 'DeviceSimulatorError';
    this.status = response.status;
    this.body = response.body;
    this.text = response.text;
  }
}

export interface DeviceSimulator {
  readonly identity: DeviceIdentity;
  /** The paired session, or `undefined` before `pair()`. */
  readonly session: DeviceSession | undefined;

  /** §6.1 — redeem a one-time pairing code and register this device's public key. */
  pair(pairingCode: string, deviceName?: string): Promise<DeviceSession>;
  /** §6.2 — ask for a one-time nonce to sign. */
  challenge(deviceId?: string): Promise<string>;
  /** §6.2 — trade a signed nonce for a fresh access token. The signature is supplied, never assumed. */
  token(request: { deviceId: string; nonce: string; signature: string }): Promise<string>;
  /** `challenge()` → sign with the domain-separated bytes → `token()`, adopting the new access token. */
  renewAccessToken(): Promise<string>;
  /** §12.3 — publish a presence hint under the device bearer. */
  publishPresence(level: PresenceLevel, detail?: string): Promise<void>;
  /** Read presence back the way a host does, through the supplied {@link SimulatorHost}. */
  readHostPresence(): Promise<readonly PresenceHint[]>;
  /** §6.3 — revoke this device through the supplied {@link SimulatorHost}. */
  revoke(): Promise<void>;

  /**
   * The raw request primitive every call above is built from. Exposed because a
   * host's own extra assertions should not have to re-derive base URL joining,
   * bearer injection, and JSON parsing to make one off-path request.
   */
  request(input: SimulatorRequest): Promise<SimulatorResponse>;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function createDeviceSimulator(
  options: DeviceSimulatorOptions,
): Promise<DeviceSimulator> {
  const identity = await createDeviceIdentity();
  const doFetch = options.fetch ?? globalThis.fetch;
  const origin = options.baseUrl.replace(/\/+$/, '');
  const defaultDeviceName = options.deviceName ?? DEFAULT_DEVICE_NAME;
  let session: DeviceSession | undefined;

  function requireSession(action: string): DeviceSession {
    if (session === undefined) {
      throw new Error(`${action} needs a paired device: call pair(pairingCode) first.`);
    }
    return session;
  }

  function requireHost(action: string): SimulatorHost {
    if (options.host === undefined) {
      throw new Error(
        `${action} is a host control-plane operation and the SDK mounts no admin route for it: pass a SimulatorHost to createDeviceSimulator.`,
      );
    }
    return options.host;
  }

  async function request(input: SimulatorRequest): Promise<SimulatorResponse> {
    const headers = new Headers();
    if (input.body !== undefined) headers.set('content-type', 'application/json');
    if ((input.credential ?? 'device') === 'device' && session !== undefined) {
      headers.set('authorization', `Bearer ${session.accessToken}`);
    }

    const response = await doFetch(
      new Request(`${origin}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, text, body: parseJson(text) };
  }

  function expectOk(what: string, response: SimulatorResponse): SimulatorResponse {
    if (response.status !== 200) throw new DeviceSimulatorError(what, response);
    return response;
  }

  async function pair(pairingCode: string, deviceName = defaultDeviceName): Promise<DeviceSession> {
    const response = expectOk(
      'pairing rejected',
      await request({
        method: 'POST',
        path: DEVICE_ROUTES.pair,
        credential: 'none',
        body: {
          pairingCode,
          deviceName,
          devicePublicKey: identity.publicKeyBase64Url,
        },
      }),
    );
    const parsed = PairResponseSchema.parse(response.body);
    session = { deviceId: parsed.deviceId, accessToken: parsed.accessToken };
    return session;
  }

  async function challenge(deviceId?: string): Promise<string> {
    const response = expectOk(
      'challenge rejected',
      await request({
        method: 'POST',
        path: DEVICE_ROUTES.challenge,
        credential: 'none',
        body: { deviceId: deviceId ?? requireSession('challenge()').deviceId },
      }),
    );
    return ChallengeResponseSchema.parse(response.body).nonce;
  }

  async function token(input: {
    deviceId: string;
    nonce: string;
    signature: string;
  }): Promise<string> {
    const response = expectOk(
      'token exchange rejected',
      await request({
        method: 'POST',
        path: DEVICE_ROUTES.token,
        credential: 'none',
        body: input,
      }),
    );
    return TokenResponseSchema.parse(response.body).accessToken;
  }

  async function renewAccessToken(): Promise<string> {
    const current = requireSession('renewAccessToken()');
    const nonce = await challenge(current.deviceId);
    const accessToken = await token({
      deviceId: current.deviceId,
      nonce,
      signature: await identity.signNonce(nonce),
    });
    session = { deviceId: current.deviceId, accessToken };
    return accessToken;
  }

  return {
    identity,
    get session() {
      return session;
    },

    pair,
    challenge,
    token,
    renewAccessToken,

    async publishPresence(level, detail) {
      requireSession('publishPresence()');
      expectOk(
        'presence publication rejected',
        await request({
          method: 'PUT',
          path: DEVICE_ROUTES.presence,
          body: { level, ...(detail === undefined ? {} : { detail }) },
        }),
      );
    },

    readHostPresence() {
      return requireHost('readHostPresence()').listPresence();
    },

    revoke() {
      return requireHost('revoke()').revokeDevice(requireSession('revoke()').deviceId);
    },

    request,
  };
}
