/**
 * Payload probe for `custody-external-cli-admission.test.ts`: invokes the
 * REAL SDK runner payload (`runPiSubagentRunnerPayload`) in a fresh process
 * with `BYOK_SDK_CUSTODY_RUNNER_CONFIG` pointing at whatever config the test
 * wrote. The N1 admission gate must exit(1) with the typed refusal on stderr
 * BEFORE the `#byok-pi-runtime-host` import ever happens — so this probe both
 * proves the refusal and proves the vendored runner closure never loads for
 * a refused config.
 *
 * Usage: bun <this file> (environment carries the config commitment)
 */
import { runPiSubagentRunnerPayload } from '../../custody/pi-subagent-runner-payload';

runPiSubagentRunnerPayload();
