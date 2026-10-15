/** Test-owned enrollment backend. Never imported by product source or selected by the environment. */
export class InMemoryDeviceCredentialStore {
  #authority;
  async read() {
    return this.#authority?.kind === 'first-pairing-attempt-v1' || this.#authority === undefined
      ? undefined : Object.freeze({ ...this.#authority });
  }
  async readFirstPairingAttempt() {
    return this.#authority?.kind === 'first-pairing-attempt-v1' ? Object.freeze({ ...this.#authority }) : undefined;
  }
  async saveFirstPairingAttempt(attempt) { this.#authority = Object.freeze({ ...attempt }); }
  async replace(record) { this.#authority = Object.freeze({ ...record }); }
  async clear() { const existed = this.#authority !== undefined; this.#authority = undefined; return existed; }
}
