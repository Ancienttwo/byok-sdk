import { sealedZeroHitSuite } from '../../hosted-bot-collaboration/src/sealed-zero-hit.test-support';
import { openWorkerCanary } from './sealed-zero-hit.test-support';
import { RUN } from './worker.test-support';

// E2EE needs OS credential custody. Enabling this in CI also needs a reviewed Secret Service wrapper.
const RUN_CANARY = RUN && process.env.BYOK_TEST_WORKER_SEALED_CANARY === '1';
if (process.env.BYOK_REQUIRE_WORKER_SEALED_CANARY === '1' && !RUN_CANARY) {
  throw new Error('BYOK_REQUIRE_WORKER_SEALED_CANARY=1 requires BYOK_TEST_WORKER_SEALED_CANARY=1 and the Worker dataplane substrate');
}
sealedZeroHitSuite('sealed zero-hit on local workerd + Hyperdrive (#654 d)', !RUN_CANARY, openWorkerCanary);
