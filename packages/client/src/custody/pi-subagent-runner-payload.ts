/**
 * WP4 runner payload (`custody/pi-subagent-runner-payload.ts`) — the
 * re-entry point the runner entry invokes on a self-reentrant dispatch.
 * Deliberately THIN: the vendored background-runner closure lives behind the
 * `#byok-pi-runtime-host` seam (`bin/custody-runner-payload-host.ts`), for
 * the same chunk-hygiene reason as the print payload — this module is in the
 * library root's bundle graph, and only an external-dynamic import keeps
 * the runner closure (and its external imports) out of every consumer's
 * eager load.
 */
import { loadCustodyRunnerConfigPath } from './custody-commitments';

export function runPiSubagentRunnerPayload(): void {
  const configPath = loadCustodyRunnerConfigPath(process.env);
  void import('#byok-pi-runtime-host')
    .then((host) => host.runCustodyRunnerPayload(configPath))
    .catch((error: unknown) => {
      process.stderr.write(`pi-subagent-runner payload: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
