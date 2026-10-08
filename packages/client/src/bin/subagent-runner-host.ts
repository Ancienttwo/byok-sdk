/**
 * The in-bundle execution of the vendored background runner, in place of the
 * upstream `node jiti subagent-runner.ts <cfg>` child. Like the print host,
 * this module lives behind the `#byok-pi-runtime-host` seam so the vendored
 * runner closure joins the runtime-host artifact only, never the library root
 * chunk.
 *
 * The config is read and deleted inside the vendored entry. The returned
 * promise settles when the configured run has finished, so a product that
 * exits after `runSdkReservedHelperCommand` resolves does not cut the run short.
 */
import { runSubagentRunnerEntry } from '../subagents/runner-bridge.js';

export async function runSubagentRunner(configPath: string): Promise<void> {
  try {
    await runSubagentRunnerEntry([configPath]);
  } catch (error: unknown) {
    process.stderr.write(`pi-subagent-runner: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
