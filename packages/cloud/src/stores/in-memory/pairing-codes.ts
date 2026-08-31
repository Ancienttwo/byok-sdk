/**
 * In-memory {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Enrollment answers `undefined` for unknown, expired, and already-used alike.
 * The reference server distinguishes those three in its 401 text; a hosted,
 * multi-tenant surface deliberately does not — the code is a bearer credential
 * addressable across every tenant, and "already used" versus "never existed"
 * is exactly the difference an attacker enumerating codes would pay for.
 *
 * Code issuance and enrollment project this one authority into separate ports.
 * The enrollment path serializes each code through registration and flips
 * `used` only after its shared device directory has accepted the row.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  DeviceDirectory,
  DeviceRecord,
  PairingEnrollment,
  PairingEnrollmentInput,
  PairingCodeClaims,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
} from '../ports';

interface PairingCodeRecord {
  readonly claims: PairingCodeClaims;
  readonly expiresAtMs: number;
  used: boolean;
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

  async issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo> {
    this.#codes.set(input.code, {
      claims: { tenantId: tenant, productId: input.productId },
      expiresAtMs: new Date(input.expiresAt).getTime(),
      used: false,
    });
    return { code: input.code, expiresAt: input.expiresAt };
  }

  async redeemAndRegister(input: PairingEnrollmentInput): Promise<DeviceRecord | undefined> {
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
      if (record === undefined) return undefined;
      if (record.used) return undefined;
      if (this.#clock.now().getTime() > record.expiresAtMs) return undefined;

      const device = await this.#devices.register(record.claims.tenantId, {
        productId: record.claims.productId,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        devicePublicKey: input.devicePublicKey,
        proofKeyId: input.proofKeyId,
        proofKeyEpoch: input.proofKeyEpoch,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      });
      record.used = true;
      return device;
    } finally {
      release!();
      if (this.#enrollmentTails.get(input.pairingCode) === current) {
        this.#enrollmentTails.delete(input.pairingCode);
      }
    }
  }
}
