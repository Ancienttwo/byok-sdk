import { OFFER_ADMISSION_MAX_DURATION_MS, type OfferAdmissionTimings } from '@byok-sdk/protocol';

type OfferAdmissionPhase = Exclude<keyof OfferAdmissionTimings, 'totalMs'>;

/**
 * One offer's admission clock (#1014), from the `task.offer` dispatch to the
 * claim or decline that ends admission. Whole milliseconds rounded down, so
 * the phases never sum past the total. A total past the wire cap drops the
 * whole block: a clamped value is one this device did not measure.
 */
export class OfferAdmissionTiming {
  private readonly startedAt: number;
  private readonly phases: Partial<Record<OfferAdmissionPhase, number>> = {};

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  /** Runs one phase; its time counts whether it succeeds or throws. */
  async time<T>(phase: OfferAdmissionPhase, run: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await run();
    } finally {
      this.phases[phase] = this.now() - started;
    }
  }

  snapshot(): OfferAdmissionTimings | undefined {
    const totalMs = Math.floor(this.now() - this.startedAt);
    if (totalMs > OFFER_ADMISSION_MAX_DURATION_MS) return undefined;
    const timings: OfferAdmissionTimings = { totalMs };
    for (const [phase, ms] of Object.entries(this.phases)) timings[phase as OfferAdmissionPhase] = Math.floor(ms);
    return timings;
  }
}
