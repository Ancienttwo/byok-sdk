/**
 * WP4 runner payload host (`custody-runner-payload-host`) — the in-bundle
 * execution of the vendored background runner, replacing the old
 * `node jiti subagent-runner.ts <cfg>` child (design freeze D2). Like the
 * print payload host, this module lives behind the `#byok-pi-runtime-host`
 * seam so the vendored runner closure joins the runtime-host artifact only —
 * never the library root chunk (see `custody-print-payload-host.ts` for the
 * chunk rationale).
 *
 * The runner logic itself is the un-pruned vendored
 * `runs/background/subagent-runner.ts` reached through the JS bridge; the
 * only change against upstream is where the config path comes from: the
 * parent-written runner config file travels as the
 * `BYOK_SDK_CUSTODY_RUNNER_CONFIG` transport commitment (validated by the
 * caller), instead of `process.argv[2]` of a jiti child.
 *
 * The runner entry is fire-and-forget exactly as upstream: the config is read
 * and deleted inside the vendored entry, `startConfiguredSubagent` keeps the
 * process alive through its own child handles and watchers, and the process
 * exits when the run completes — the same lifetime the jiti child had.
 */
import { runSubagentRunnerEntry } from '../custody/pi-subagent-runner-bridge.js';

export function runCustodyRunnerPayload(configPath: string): void {
  try {
    runSubagentRunnerEntry([configPath]);
  } catch (error: unknown) {
    process.stderr.write(`pi-subagent-runner payload: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
