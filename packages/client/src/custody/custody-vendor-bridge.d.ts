/**
 * Type surface for `custody-vendor-bridge.js`: the vendored pi-subagents
 * primitives the custody dispatcher consumes. Declared by hand because the
 * vendored sources publish TS with no consumable declarations; the shapes
 * mirror `vendor/pi-subagents/0.60.0/src` exactly (budget descriptor,
 * claim/decode signatures, opaque in-memory child permit).
 */

export interface RunFanoutBudgetDescriptor {
	version: 1;
	rootRunId: string;
	directory: string;
	limit: number;
	parentPath?: string;
}

export declare const RUN_FANOUT_BUDGET_ENV: string;

export declare function decodeRunFanoutBudgetDescriptor(encoded: string | undefined): RunFanoutBudgetDescriptor | undefined;

export declare function encodeRunFanoutBudgetDescriptor(descriptor: RunFanoutBudgetDescriptor): string;

export declare function createRunFanoutBudget(rootRunId: string, limit: number): RunFanoutBudgetDescriptor;
export declare function validateRunFanoutBudgetDescriptor(value: unknown): RunFanoutBudgetDescriptor;

export declare function claimRunFanoutBatchWithCommit<T>(descriptor: RunFanoutBudgetDescriptor, paths: string[], commit: () => T): T;

declare const workflowChildPermit: unique symbol;

/** Opaque, in-memory, non-serializable workflow child permit (vendored authority). */
export interface WorkflowChildPermit {
	readonly [workflowChildPermit]: unknown;
}

export interface WorkflowChildPermitInput {
	issuerPackage: string;
	workflowRunId: string;
	childKey: string;
	agent: string;
	launchContractDigest: string;
	context: 'fresh' | 'fork';
	runner?: 'pi' | 'official-external-cli';
}

export declare function createWorkflowChildPermit(input: WorkflowChildPermitInput): WorkflowChildPermit;

/** Claim the first distinct launch attempt (vendored authority; must precede the consume site). */
export declare function claimWorkflowChildPermit(permit: WorkflowChildPermit, workflowRunId: string, childKey: string): string | undefined;
export declare function consumeWorkflowChildPermit(permit: WorkflowChildPermit, launch: Omit<WorkflowChildPermitInput, 'issuerPackage'> & { runner: 'pi' | 'official-external-cli' }): string | undefined;
export type CustodyProcessTreeTerminal =
  | { state: 'observed'; mechanism: 'posix-process-group'; processGroupId: number; verifiedAt: number }
  | { state: 'unknown'; reason: 'unsupported-platform' | 'signal-failed' | 'verification-failed'; diagnostic?: string };
export interface CustodyProcessTreeController {
  terminate(): Promise<CustodyProcessTreeTerminal>;
  finishAfterWriterClose(): Promise<CustodyProcessTreeTerminal>;
}
export declare function createOwnedProcessTreeController(pid: number, options?: { termGraceMs?: number; killVerifyMs?: number; observation?: 'kernel-presence' }): CustodyProcessTreeController;
