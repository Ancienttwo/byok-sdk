/**
 * In-memory {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Enrollment answers `code_invalid` for unknown, expired, and already-used
 * alike: the code is a bearer credential addressable across every tenant, and
 * "already used" versus "never existed" is exactly the difference an attacker
 * enumerating codes would pay for.
 *
 * Code issuance and enrollment project this one authority into separate ports.
 * The enrollment path serializes each code through registration and flips
 * `used` only after its shared device directory has accepted the row; a fence
 * `conflict` from the directory leaves the code unused (#2045).
 */
import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult, type Clock, type TenantId } from '@byok-sdk/core';
import type {
  DeviceDirectory,
  DeviceRecord,
  PairingEnrollment,
  PairingEnrollmentInput,
  PairingEnrollmentResult,
  PairingCodeClaims,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
} from '../ports.js';

interface PairingCodeRecord {
  readonly claims: PairingCodeClaims;
  readonly expiresAtMs: number;
  used: boolean;
  completion?: {
    readonly device: DeviceRecord;
    readonly binding: PairingBinding;
  };
}

/** The completion binding: every input field except the code, the route-minted id and the fence. */
type PairingBinding = Omit<PairingEnrollmentInput, 'pairingCode' | 'deviceId' | 'expectedDeviceDigest'>;

const CODE_INVALID: PairingEnrollmentResult = { outcome: 'code_invalid' };

function bindingOf(input: PairingEnrollmentInput): PairingBinding {
  return {
    deviceName: input.deviceName,
    devicePublicKey: input.devicePublicKey,
    proofKeyId: input.proofKeyId,
    proofKeyEpoch: input.proofKeyEpoch,
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
  };
}

function sameBinding(left: PairingBinding, right: PairingBinding): boolean {
  return left.deviceName === right.deviceName &&
    left.devicePublicKey === right.devicePublicKey &&
    left.proofKeyId === right.proofKeyId &&
    left.proofKeyEpoch === right.proofKeyEpoch &&
    left.machineId === right.machineId;
}

export class InMemoryPairingCodeStore implements PairingCodeStore, PairingEnrollment {
  readonly #codes = new Map<string, PairingCodeRecord>();
  readonly #enrollmentTails = new Map<string, Promise<void>>();
  readonly #clock: Clock;
  readonly #devices: DeviceDirectory;

  constructor(clock: Clock, devices: DeviceDirectory) {
    this.#clock = clock;
    this.#devices = devices;
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    let removed = 0;
    let more = false;
    for (const [code, record] of this.#codes) {
      // A redeemed code is the only route to its protected completion fence.
      if (record.claims.tenantId !== tenant || record.used || record.expiresAtMs >= Date.parse(input.now) || this.#enrollmentTails.has(code)) continue;
      if (removed === input.limit) { more = true; break; }
      this.#codes.delete(code);
      removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }

  async issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo> {
    this.#codes.set(input.code, {
      claims: { tenantId: tenant, productId: input.productId },
      expiresAtMs: new Date(input.expiresAt).getTime(),
      used: false,
    });
    return { code: input.code, expiresAt: input.expiresAt };
  }

  async redeemAndRegister(input: PairingEnrollmentInput): Promise<PairingEnrollmentResult> {
    // JavaScript runs synchronous map updates without interleaving, but device
    // registration awaits. Queue only the exact bearer code so an unrelated
    // enrollment never waits behind it while competing redemption observes the
    // final used state rather than a mid-registration half-state.
    const previous = this.#enrollmentTails.get(input.pairingCode) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#enrollmentTails.set(input.pairingCode, current);
    await previous;

    try {
      const record = this.#codes.get(input.pairingCode);
      if (record === undefined) return CODE_INVALID;
      if (record.used) {
        // Replay answers before the fence is read: a same-code retry after a
        // lost response succeeds even when the fence has since moved.
        const completion = record.completion;
        if (completion === undefined || !sameBinding(completion.binding, bindingOf(input))) return CODE_INVALID;
        const active = await this.#devices.get(completion.device.tenantId, completion.device.deviceId);
        return active === undefined ? CODE_INVALID : { outcome: 'registered', device: completion.device };
      }
      if (this.#clock.now().getTime() > record.expiresAtMs) return CODE_INVALID;

      const registered = await this.#devices.register(record.claims.tenantId, {
        productId: record.claims.productId,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        devicePublicKey: input.devicePublicKey,
        proofKeyId: input.proofKeyId,
        proofKeyEpoch: input.proofKeyEpoch,
        expectedDeviceDigest: input.expectedDeviceDigest,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      });
      if (registered.outcome === 'conflict') return registered;
      record.used = true;
      record.completion = { device: registered.device, binding: bindingOf(input) };
      return registered;
    } finally {
      release!();
      if (this.#enrollmentTails.get(input.pairingCode) === current) {
        this.#enrollmentTails.delete(input.pairingCode);
      }
    }
  }
}
