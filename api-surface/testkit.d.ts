// ==== @byok-sdk/testkit dist/identity.d.ts ====
/** Length of a base64url-encoded raw 32-byte Ed25519 public key, unpadded. */
export declare const DEVICE_PUBLIC_KEY_LENGTH = 43;
export interface DeviceIdentity {
    /** JWK `x` — raw 32-byte Ed25519 public key, base64url, 43 characters. */
    readonly publicKeyBase64Url: string;
    /** Raw 64-byte Ed25519 signature over `message`, base64url. */
    sign(message: Uint8Array): Promise<string>;
    /**
     * Signature over the domain-separated challenge bytes — core's
     * {@link nonceSigningBytes}, never a local re-spelling of the domain. This is
     * the only signing shape any real device produces.
     */
    signNonce(nonce: string): Promise<string>;
}
/**
 * Generate a fresh device keypair. The private key stays a non-extractable
 * `CryptoKey` inside this object — a simulator has no reason to hand one out,
 * and a test that cannot leak a key cannot accidentally assert on one.
 */
export declare function createDeviceIdentity(): Promise<DeviceIdentity>;
// ==== @byok-sdk/testkit dist/index.d.ts ====
/**
 * `@byok-sdk/testkit` — the device end of docs/protocol.md §6, headless.
 *
 * A host integrating the SDK needs a smoke test that proves a real device can
 * pair, renew a token, publish presence, and be revoked. Written by hand, that
 * test carries upstream knowledge downstream — the JWK export shape, the nonce
 * signing domain, the three auth route DTOs — and goes quietly green against
 * nothing when upstream changes any of them. This package is that knowledge,
 * shipped from the same repo it belongs to.
 *
 * Runtime dependencies are `@byok-sdk/core` (the signing bytes) and
 * `@byok-sdk/protocol` (the wire DTOs), and nothing else. In particular there
 * is no test framework here: the negative assertions are async functions
 * returning structured results, so the same four checks run under vitest, under
 * a plain CI script, and inside a Worker.
 */
export { DEVICE_PUBLIC_KEY_LENGTH, createDeviceIdentity } from './identity';
export type { DeviceIdentity } from './identity';
export { DEFAULT_DEVICE_NAME, DEVICE_ROUTES, DeviceSimulatorError, createDeviceSimulator } from './simulator';
export type { Credential, DeviceSession, DeviceSimulator, DeviceSimulatorOptions, SimulatorHost, SimulatorRequest, SimulatorResponse, } from './simulator';
export { assertPairingCodeSingleUse, assertRevokedDeviceChallengeRejected, assertUnauthenticatedRejected, assertUndomainedSignatureRejected, failedAssertions, runNegativeAssertions, } from './negatives';
export type { NegativeAssertionResult, NegativeSuiteInput } from './negatives';
// ==== @byok-sdk/testkit dist/negatives.d.ts ====
/**
 * The four negative assertions a host's pairing smoke test hand-writes.
 *
 * These are plain async functions on purpose. A negative assertion belongs to
 * the protocol, not to a test runner: the same four have to be runnable from
 * vitest, from a CI script, from a deployment gate, and from a Worker. So each
 * returns a structured {@link NegativeAssertionResult} instead of throwing —
 * the caller decides what a failure means, and a vitest consumer writes
 * `expect(result.ok).toBe(true)` and gets the observed status in the diff.
 *
 * Each one names a defense that must hold, and each is written so that pointing
 * it at the wrong input makes it FAIL. An assertion that cannot go red proves
 * nothing, and the ones here are checked that way in
 * `@byok-sdk/conformance`'s `pairing-simulator` suite before they are trusted
 * green: unauthenticated against a public route, single-use against an unused
 * code, undomained against a properly domained signature, revoked against a
 * device that was never revoked.
 */
import type { DeviceSimulator, SimulatorRequest, SimulatorResponse } from './simulator';
export interface NegativeAssertionResult {
    /** Stable identifier — safe to use as a test name or a CI check id. */
    readonly name: string;
    readonly ok: boolean;
    /** What the protocol requires. */
    readonly expected: string;
    /** What the deployment actually did. */
    readonly actual: string;
    /** The response that decided it, when one status decided it. */
    readonly response?: SimulatorResponse;
}
/**
 * A credentialed route answers 401 when the credential is absent.
 *
 * Defaults to `PUT /byok/presence` — the SDK's own credentialed HTTP surface is
 * device-class, because the host control plane (pairing-code mint, presence
 * read, revoke) is in-process and mounts no route. A deployment that publishes
 * its own admin routes passes one here and gets the same assertion against it.
 */
export declare function assertUnauthenticatedRejected(simulator: DeviceSimulator, target?: Omit<SimulatorRequest, 'credential'>): Promise<NegativeAssertionResult>;
/**
 * A pairing code is single-use (§6.1): redeeming an already-redeemed code is a
 * 401, indistinguishable from an unknown or expired one.
 *
 * Pass the code THIS simulator (or another one) already paired with. Pointing
 * it at a fresh code pairs a second device and returns `ok: false` — that is
 * the red form.
 */
export declare function assertPairingCodeSingleUse(simulator: DeviceSimulator, redeemedPairingCode: string, deviceName?: string): Promise<NegativeAssertionResult>;
/**
 * A signature over the BARE nonce does not renew a token (§6.2, GAP-004).
 *
 * This is the one place in the package that signs something other than
 * `nonceSigningBytes` — and it signs *less*, never a second domain of its own.
 * The whole point is that the undomained encoding has no accepted form
 * anywhere, so there is no dual mode to accidentally validate.
 *
 * Set `domainSeparated: true` to get the red form: the correctly domained
 * signature renews the token, 200, and the assertion reports failure.
 */
export declare function assertUndomainedSignatureRejected(simulator: DeviceSimulator, options?: {
    readonly domainSeparated?: boolean;
}): Promise<NegativeAssertionResult>;
/**
 * A revoked device cannot start a renewal (§6.3): its next `/byok/challenge` is
 * a 401, indistinguishable from an unknown device.
 *
 * Does NOT revoke anything itself — revocation is the host's act, so the caller
 * revokes and then asserts. Calling it before revoking is the red form.
 */
export declare function assertRevokedDeviceChallengeRejected(simulator: DeviceSimulator): Promise<NegativeAssertionResult>;
export interface NegativeSuiteInput {
    /** A pairing code this simulator has already redeemed. */
    readonly redeemedPairingCode: string;
    /** Optional non-default target for the unauthenticated check (e.g. a host admin route). */
    readonly unauthenticatedTarget?: Omit<SimulatorRequest, 'credential'>;
}
/**
 * All four, in the only order they can run in: revocation is terminal for this
 * device, so the checks that need a live session go first.
 */
export declare function runNegativeAssertions(simulator: DeviceSimulator, input: NegativeSuiteInput): Promise<readonly NegativeAssertionResult[]>;
/** Every failed assertion in `results`, for a caller that wants one error instead of four booleans. */
export declare function failedAssertions(results: readonly NegativeAssertionResult[]): readonly NegativeAssertionResult[];
// ==== @byok-sdk/testkit dist/simulator.d.ts ====
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
import { type ToolsetId } from '@byok-sdk/protocol';
import { type DeviceIdentity } from './identity';
/** The device-surface routes this simulator drives (docs/protocol.md §6, §12.3). */
export declare const DEVICE_ROUTES: {
    readonly pair: "/byok/pair";
    readonly challenge: "/byok/challenge";
    readonly token: "/byok/token";
    readonly presence: "/byok/presence";
};
export declare const DEFAULT_DEVICE_NAME = "byok-testkit-device";
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
export declare class DeviceSimulatorError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly text: string;
    constructor(message: string, response: SimulatorResponse);
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
    token(request: {
        deviceId: string;
        nonce: string;
        signature: string;
    }): Promise<string>;
    /** `challenge()` → sign with the domain-separated bytes → `token()`, adopting the new access token. */
    renewAccessToken(): Promise<string>;
    /** §12.3 — publish a presence hint under the device bearer. */
    publishPresence(level: PresenceLevel, detail?: string, configuredToolsets?: readonly ToolsetId[]): Promise<void>;
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
export declare function createDeviceSimulator(options: DeviceSimulatorOptions): Promise<DeviceSimulator>;
