/**
 * The auth plane: everything the three pre-tenant routes (`/byok/pair`,
 * `/byok/challenge`, `/byok/token`) need, and nothing else.
 *
 * Those three routes cannot take a {@link TenantStores} facade — they run
 * BEFORE a principal exists, which is exactly why they are the surface where a
 * tenant boundary is easiest to lose. So instead of handing them naked stores
 * and trusting each handler to pass the right tenant, this module owns every
 * tenant-carrying call they make and hands back operations that name no tenant
 * at all:
 *
 * - a pairing code redeems into a REGISTERED device row in one step, so the
 *   claims never sit in handler scope as a tenant a handler could substitute;
 * - a device resolves to a row (the pre-tenant lookup, §6.2's pinned wire
 *   contract), and unknown/revoked collapse to one answer;
 * - nonce issue/atomic-consume and token minting take that ROW, so the
 *   tenant they act on is the row's, by construction.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import { PairResponseSchema } from '@byok-sdk/protocol';
import type { CloudCrypto } from '../crypto/port.js';
import type { CloudStores, DeviceRecord, PairingCodeInfo, PairingEnrollmentResult } from '../stores/ports.js';
import { ACCESS_TOKEN_TTL_SECONDS, type TokenSigner } from './tokens.js';
import { verifyNonceSignature } from './verify.js';

/** ~10min, matching the reference server's pairing-code lifetime. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

const PAIRING_CODE_LENGTH = 8;

/**
 * The longest `productId` a pairing code may carry. The device keys its
 * enrollment and every `pairDeviceDigest` by it, so it is bounded where it
 * enters the system: at the mint.
 */
export const PAIRING_CODE_PRODUCT_ID_MAX_LENGTH = 64;

/** The paired identity key is the first and only proof key in S6. */
export const DEVICE_IDENTITY_PROOF_KEY_ID = 'identity';
export const DEVICE_IDENTITY_PROOF_KEY_EPOCH = 0;

export interface PairInput {
  readonly pairingCode: string;
  readonly deviceName: string;
  readonly devicePublicKey: string;
  /** Optional client-hashed machine identity (protocol §6.1). Carried into registration verbatim; it is never a tenant or product authority. */
  readonly machineId?: string;
  /** The registration fence (#2045, protocol §6.1), carried into enrollment verbatim. */
  readonly expectedDeviceDigest: string | null;
}

export interface MintedAccessToken {
  readonly accessToken: string;
  /** Lifetime in seconds, relative to the response (#1114): the device's lifetime authority. */
  readonly expiresIn: number;
}

export interface AuthPlane {
  /**
   * Host control plane: mint a single-use code carrying the tenant/product a
   * device will land in. The caller bounds `productId` by
   * {@link PAIRING_CODE_PRODUCT_ID_MAX_LENGTH} (`ByokCloud.createPairingCode`).
   */
  createPairingCode(tenant: TenantId, input: { readonly productId: string; readonly ttlMs?: number }): Promise<PairingCodeInfo>;
  /**
   * Redeem a code and register the device it pairs, in one step. `code_invalid`
   * for a code that is unknown, expired, or already used — one answer for all
   * three — and `conflict` when the fence does not name the machine's current
   * device, which consumes nothing. Single-use redemption is what makes this
   * exclusive: a second redeem never reaches the row write.
   */
  redeemAndRegister(input: PairInput): Promise<PairingEnrollmentResult>;
  /** The pre-tenant device lookup §6.2's wire contract forces. `undefined` for unknown AND revoked alike — no existence oracle. */
  resolveDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  issueNonce(device: DeviceRecord): Promise<string>;
  /** Atomically consume the nonce after signature verification (§6.2). */
  consumeNonceIfValid(device: DeviceRecord, nonce: string): Promise<boolean>;
  /** Domain-separated (`byok-nonce-v1\n`) — see `verify.ts`. A raw signature over the bare nonce is invalid, with no second accepted form. */
  verifySignature(device: DeviceRecord, nonce: string, signature: string): Promise<boolean>;
  mintAccessToken(device: DeviceRecord): Promise<MintedAccessToken>;
}

export interface AuthPlaneDeps {
  readonly stores: CloudStores;
  readonly crypto: CloudCrypto;
  readonly clock: Clock;
  readonly tokenSigner: TokenSigner;
  readonly accessTokenTtlSeconds?: number;
}

export function createAuthPlane(deps: AuthPlaneDeps): AuthPlane {
  const { stores, crypto, clock, tokenSigner } = deps;
  const ttlSeconds = deps.accessTokenTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  // The TTL goes on the wire as `expiresIn`, a positive integer of seconds.
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('accessTokenTtlSeconds must be a positive safe integer');
  }

  return {
    async createPairingCode(tenant, input) {
      const expiresAt = new Date(clock.now().getTime() + (input.ttlMs ?? PAIRING_CODE_TTL_MS)).toISOString();
      return stores.pairingCodes.issue(tenant, {
        code: crypto.randomPairingCode(PAIRING_CODE_LENGTH),
        productId: input.productId,
        expiresAt,
      });
    },

    async redeemAndRegister(input) {
      // The enrollment composition alone reads the guarded code claims, so a
      // handler never holds a tenant/product it could substitute. It consumes
      // the code only if this registration succeeds.
      const deviceId = `dev_${crypto.randomUuid()}`;
      // Checked against the response's own rule before redemption: an id the
      // response may not carry must not become a registered row or a spent code.
      if (!PairResponseSchema.shape.deviceId.safeParse(deviceId).success) {
        throw new TypeError('CloudCrypto.randomUuid minted a device id PairResponse cannot carry');
      }
      return stores.pairing.redeemAndRegister({
        pairingCode: input.pairingCode,
        deviceId,
        deviceName: input.deviceName,
        devicePublicKey: input.devicePublicKey,
        proofKeyId: DEVICE_IDENTITY_PROOF_KEY_ID,
        proofKeyEpoch: DEVICE_IDENTITY_PROOF_KEY_EPOCH,
        expectedDeviceDigest: input.expectedDeviceDigest,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      });
    },

    async resolveDevice(deviceId) {
      const device = await stores.devices.resolveByDeviceId(deviceId);
      if (device === undefined || device.revoked) return undefined;
      return device;
    },

    issueNonce(device) {
      return stores.nonces.issue(device.tenantId, device.deviceId);
    },

    consumeNonceIfValid(device, nonce) {
      return stores.nonces.consumeIfValid(device.tenantId, device.deviceId, nonce);
    },

    verifySignature(device, nonce, signature) {
      return verifyNonceSignature(crypto, device.devicePublicKey, nonce, signature);
    },

    async mintAccessToken(device) {
      const accessToken = await tokenSigner.sign(
        { deviceId: device.deviceId, tenantId: device.tenantId, productId: device.productId },
        ttlSeconds,
      );
      return {
        accessToken,
        expiresIn: ttlSeconds,
      };
    },
  };
}
