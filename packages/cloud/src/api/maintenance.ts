import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { type resolveProofReceiptRetention, runMaintenanceSteps } from '../maintenance';

interface Dependencies {
  options: ByokCloudOptions;
  proofReceiptRetention: ReturnType<typeof resolveProofReceiptRetention>;
}

export function createMaintenanceApi({ options, proofReceiptRetention }: Dependencies): Pick<ByokCloud,
  'runMaintenance'
> {
  return {
    async runMaintenance(input) {
      const report = await runMaintenanceSteps({ core: options.core, cloud: options.cloud, clock: options.clock, crypto: options.crypto,
        ...(options.deviceAssertionReplay === undefined ? {} : { deviceAssertionReplay: options.deviceAssertionReplay }),
        proofReceiptRetention }, input);
      try { options.observer?.onMaintenance?.(report); } catch { /* Observers cannot change committed maintenance. */ }
      return report;
    },
  };
}
