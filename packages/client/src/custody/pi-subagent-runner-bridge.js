/**
 * JS bridge for the vendored background-runner entry — the same boundary
 * pattern as `bin/pi-extension-factories.js` (see `custody-vendor-bridge.js`
 * for the full rationale). This bridge is deliberately separate so the heavy
 * `runs/background/subagent-runner.ts` closure (the old jiti child's import
 * graph) joins only the runtime-host artifact through
 * `bin/custody-runner-payload-host.ts` — never the library root chunk and
 * never the custody dispatcher's own import graph. Types live in the
 * adjacent `.d.ts`.
 */
import { runSubagentRunnerEntry } from '../../vendor/pi-subagents/0.60.0/src/runs/background/subagent-runner.ts';

export { runSubagentRunnerEntry };
