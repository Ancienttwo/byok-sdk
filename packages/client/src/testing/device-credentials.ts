import type { DeviceCredentialBackend, DeviceRecord, PairingAttempt } from '../daemon/device-credential-store.js';

interface Slot {
  readonly record: DeviceRecord | undefined;
  readonly attempt: PairingAttempt | undefined;
}

const EMPTY: Slot = { record: undefined, attempt: undefined };

/**
 * A `DeviceCredentialBackend` held in memory, so a test never reaches the
 * operating system's credential store. Product source never imports it and
 * the environment never selects it; a test injects it as `deviceCredentials`.
 */
export class InMemoryDeviceCredentialBackend implements DeviceCredentialBackend {
  #slot: Slot = EMPTY;
  async read(): Promise<DeviceRecord | undefined> {
    const { record } = this.#slot;
    return record === undefined ? undefined : Object.freeze({ ...record });
  }
  async readPairingAttempt(): Promise<PairingAttempt | undefined> {
    const { attempt } = this.#slot;
    return attempt === undefined ? undefined : Object.freeze({ ...attempt });
  }
  async savePairingAttempt(attempt: PairingAttempt): Promise<void> {
    this.#slot = { record: this.#slot.record, attempt: Object.freeze({ ...attempt }) };
  }
  async replace(record: DeviceRecord): Promise<void> {
    const prior = this.#slot.record;
    const renewal = prior !== undefined && prior.deviceId === record.deviceId &&
      prior.tenantId === record.tenantId && prior.devicePublicKey === record.devicePublicKey;
    this.#slot = { record: Object.freeze({ ...record }), attempt: renewal ? this.#slot.attempt : undefined };
  }
  async clear(): Promise<boolean> {
    const existed = this.#slot.record !== undefined || this.#slot.attempt !== undefined;
    this.#slot = EMPTY;
    return existed;
  }
}
