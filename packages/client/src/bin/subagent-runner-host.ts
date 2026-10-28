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
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { runSubagentRunnerEntry } from '../subagents/runner-bridge.js';
import { assertSubagentProviderCredential } from '../subagents/credential-guard';
import { readToolAuthorizationGateEnv } from '../tool-authorization-ipc';

export async function runSubagentRunner(configPath: string): Promise<void> {
  try {
    // Before the vendored runner reads its config or starts a child (#385).
    assertSubagentProviderCredential(getAgentDir());
    // Fails closed on a malformed inherited gate before any child starts.
    readToolAuthorizationGateEnv();
    await runSubagentRunnerEntry([configPath]);
  } catch (error: unknown) {
    process.stderr.write(`pi-subagent-runner: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
