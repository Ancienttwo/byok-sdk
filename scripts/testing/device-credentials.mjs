/** Test-owned enrollment backend. Never imported by product source or selected by the environment. */
export class InMemoryDeviceCredentialStore {
  #authority;
  async read() {
    if (this.#authority === undefined || this.#authority.kind === 'first-pairing-attempt-v1') return undefined;
    const record = this.#authority.kind === 'replacement-pairing-attempt-v1' ? this.#authority.record : this.#authority;
    return Object.freeze({ ...record });
  }
  async readFirstPairingAttempt() {
    if (this.#authority?.kind === 'replacement-pairing-attempt-v1') return Object.freeze({ ...this.#authority.attempt });
    return this.#authority?.kind === 'first-pairing-attempt-v1' ? Object.freeze({ ...this.#authority }) : undefined;
  }
  async saveFirstPairingAttempt(attempt) {
    const record = await this.read();
    this.#authority = record === undefined ? Object.freeze({ ...attempt })
      : Object.freeze({ kind: 'replacement-pairing-attempt-v1', record, attempt: Object.freeze({ ...attempt }) });
  }
  async replace(record) {
    const prior = this.#authority;
    this.#authority = prior?.kind === 'replacement-pairing-attempt-v1' &&
      prior.record.deviceId === record.deviceId && prior.record.tenantId === record.tenantId &&
      prior.record.devicePublicKey === record.devicePublicKey
      ? Object.freeze({ kind: 'replacement-pairing-attempt-v1', record: Object.freeze({ ...record }), attempt: prior.attempt })
      : Object.freeze({ ...record });
  }
  async clear() { const existed = this.#authority !== undefined; this.#authority = undefined; return existed; }
}
