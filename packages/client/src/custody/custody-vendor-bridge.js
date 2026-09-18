/**
 * JS bridge between the type-checked client sources and the vendored
 * pi-subagents TypeScript tree — the same boundary pattern as
 * `bin/pi-extension-factories.js`: the vendored sources publish TS with no
 * consumable declarations and are included in no tsc pass, so client `.ts`
 * modules must never import them directly. This module is the only static
 * import surface for the two vendored primitives the custody dispatcher
 * consumes (the run-fanout budget lock and the workflow child permit); the
 * heavy background-runner closure stays behind `pi-subagent-runner-bridge.js`
 * so the dispatcher's import graph never pulls it in. Types live in the
 * adjacent `.d.ts`.
 */
import {
	RUN_FANOUT_BUDGET_ENV,
	claimRunFanoutBatchWithCommit,
	createRunFanoutBudget,
	decodeRunFanoutBudgetDescriptor,
	encodeRunFanoutBudgetDescriptor,
} from '../../vendor/pi-subagents/0.60.0/src/runs/shared/run-fanout-budget.ts';
import { claimWorkflowChildPermit, createWorkflowChildPermit } from '../../vendor/pi-subagents/0.60.0/src/shared/workflow-child-permit.ts';

export {
	RUN_FANOUT_BUDGET_ENV,
	claimRunFanoutBatchWithCommit,
	createRunFanoutBudget,
	decodeRunFanoutBudgetDescriptor,
	encodeRunFanoutBudgetDescriptor,
	claimWorkflowChildPermit,
	createWorkflowChildPermit,
};
