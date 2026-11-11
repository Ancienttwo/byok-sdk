import type { DeviceCredentialBackend, DeviceRecord, FirstPairingAttempt } from '../daemon/device-credential-store.js';

interface ReplacementPairingAttempt {
  readonly kind: 'replacement-pairing-attempt-v1';
  readonly record: DeviceRecord;
  readonly attempt: FirstPairingAttempt;
}

type Authority = DeviceRecord | FirstPairingAttempt | ReplacementPairingAttempt;

const isFirst = (a: Authority): a is FirstPairingAttempt => 'kind' in a && a.kind === 'first-pairing-attempt-v1';
const isReplacement = (a: Authority): a is ReplacementPairingAttempt => 'kind' in a && a.kind === 'replacement-pairing-attempt-v1';

/**
 * A `DeviceCredentialBackend` held in memory, so a test never reaches the
 * operating system's credential store. Product source never imports it and
 * the environment never selects it; a test injects it as `deviceCredentials`.
 */
export class InMemoryDeviceCredentialBackend implements DeviceCredentialBackend {
  #authority: Authority | undefined;
  async read(): Promise<DeviceRecord | undefined> {
    const authority = this.#authority;
    if (authority === undefined || isFirst(authority)) return undefined;
    const record = isReplacement(authority) ? authority.record : authority;
    return Object.freeze({ ...record });
  }
  async readFirstPairingAttempt(): Promise<FirstPairingAttempt | undefined> {
    const authority = this.#authority;
    if (authority === undefined) return undefined;
    if (isReplacement(authority)) return Object.freeze({ ...authority.attempt });
    return isFirst(authority) ? Object.freeze({ ...authority }) : undefined;
  }
  async saveFirstPairingAttempt(attempt: FirstPairingAttempt): Promise<void> {
    const record = await this.read();
    this.#authority = record === undefined ? Object.freeze({ ...attempt })
      : Object.freeze({ kind: 'replacement-pairing-attempt-v1', record, attempt: Object.freeze({ ...attempt }) });
  }
  async replace(record: DeviceRecord): Promise<void> {
    const prior = this.#authority;
    this.#authority = prior !== undefined && isReplacement(prior) &&
      prior.record.deviceId === record.deviceId && prior.record.tenantId === record.tenantId &&
      prior.record.devicePublicKey === record.devicePublicKey
      ? Object.freeze({ kind: 'replacement-pairing-attempt-v1', record: Object.freeze({ ...record }), attempt: prior.attempt })
      : Object.freeze({ ...record });
  }
  async clear(): Promise<boolean> {
    const existed = this.#authority !== undefined;
    this.#authority = undefined;
    return existed;
  }
}
