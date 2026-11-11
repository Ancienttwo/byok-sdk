import type { ByokCloud, ByokCloudOptions } from '../cloud.js';
import { type resolveProofReceiptRetention, runMaintenanceSteps } from '../maintenance.js';

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
