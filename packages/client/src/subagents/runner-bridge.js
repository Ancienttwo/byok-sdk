/**
 * JS bridge for the vendored background-runner entry — the same boundary
 * pattern as `bin/pi-extension-factories.js`: the vendored sources publish TS
 * with no consumable declarations and are included in no tsc pass, so client
 * `.ts` modules never import them directly. The heavy
 * `runs/background/subagent-runner.ts` closure joins only the runtime-host
 * artifact through `bin/subagent-runner-host.ts`, never the library root
 * chunk. Types live in the adjacent `.d.ts`.
 */
import { runSubagentRunnerEntry } from '../../vendor/pi-subagents/0.60.0/src/runs/background/subagent-runner.ts';

export { runSubagentRunnerEntry };
