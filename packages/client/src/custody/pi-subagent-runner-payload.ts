/**
 * WP4 runner payload (`custody/pi-subagent-runner-payload.ts`) — the
 * re-entry point the runner entry invokes on a self-reentrant dispatch.
 * Deliberately THIN: the vendored background-runner closure lives behind the
 * `#byok-pi-runtime-host` seam (`bin/custody-runner-payload-host.ts`), for
 * the same chunk-hygiene reason as the print payload — this module is in the
 * library root's bundle graph, and only an external-dynamic import keeps
 * the runner closure (and its external imports) out of every consumer's
 * eager load.
 *
 * N1 external-CLI admission gate (plan 20260918-2052): before the vendored
 * runner closure loads, the transported runner config passes the same
 * external-cli admission scan the dispatcher enforced at mint time
 * (`external-cli-admission.ts`). This is the second custody surface the
 * config crosses — it catches a config rewritten after admission and any
 * hand-driven payload invocation — and it refuses with the same typed
 * reason, fail-closed, before the vendored runner can spawn anything.
 */
import { loadCustodyRunnerConfigPath } from './custody-commitments';
import { externalCliAdmissionRefusal } from './external-cli-admission';

export function runPiSubagentRunnerPayload(): void {
  const configPath = loadCustodyRunnerConfigPath(process.env);
  const externalCliRefusal = externalCliAdmissionRefusal(configPath);
  if (externalCliRefusal !== undefined) {
    process.stderr.write(`pi-subagent-runner payload: ${externalCliRefusal}\n`);
    process.exit(1);
  }
  void import('#byok-pi-runtime-host')
    .then((host) => host.runCustodyRunnerPayload(configPath))
    .catch((error: unknown) => {
      process.stderr.write(`pi-subagent-runner payload: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
