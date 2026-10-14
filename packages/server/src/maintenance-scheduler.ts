import { ByokCloudError, type MaintenanceReport } from '@byok-sdk/cloud';

export const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
/** One tenant, one timer, one in-flight pass; manual calls join that pass. */
export class MaintenanceScheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<MaintenanceReport> | undefined;
  #closed = false;
  constructor(
    private readonly run: () => Promise<MaintenanceReport>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {
    assertMaintenanceInterval(intervalMs);
    this.#arm();
  }
  runNow(): Promise<MaintenanceReport> {
    if (this.#closed) return Promise.reject(new Error('Maintenance scheduler is closed.'));
    if (this.#inFlight !== undefined) return this.#inFlight;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const pass = Promise.resolve().then(this.run);
    this.#inFlight = pass;
    void pass.then(() => this.#finished(), () => this.#finished());
    return pass;
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    // The pass reports its failure to its caller or onError; close only waits.
    await this.#inFlight?.then(() => undefined, () => undefined);
  }
  #finished(): void {
    this.#inFlight = undefined;
    if (!this.#closed) this.#arm();
  }
  #arm(): void {
    this.#timer = setTimeout(() => { void this.runNow().catch(this.onError); }, Math.round(this.intervalMs * (0.8 + Math.random() * 0.4)));
    this.#timer.unref();
  }
}
export function assertMaintenanceInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2_147_483_647 / 1.2) {
    throw new ByokCloudError('maintenance_invalid_input', 'Maintenance interval must be an integer from 1000ms to the timer range.');
  }
}
