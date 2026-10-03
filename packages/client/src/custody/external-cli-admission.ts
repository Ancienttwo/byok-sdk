/** Sixth-edge input authority. Initial config, helper payload and append share
 * a finite request grammar; installation/policy come from the verified SDK parent.
 * An input verdict is never a spawn permit. Physical execution is gated by
 * external-cli-custody.ts after independent target and auth verification. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isOfficialExternalCliAdapter, type AttestedOfficialExternalCliV2, parseDescendantLaunch } from '@byok-sdk/implementation-identity';
import { custodyExternalInstallations, verifiedCustodyRunner } from './external-cli-authority';
import { externalCliCommitment } from '@byok-sdk/implementation-identity';
import { loadCustodyLaunchRecord, BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV } from './custody-commitments';

/** Shared typed refusal at initial dispatch and running-chain admission. */
export class CustodyDispatchRefusalError extends Error {
  constructor(readonly reason: string) {
    super(`custody dispatch refused: ${reason}`);
    this.name = 'CustodyDispatchRefusalError';
  }
}

/**
 * Stable refusal prefix. The dispatcher and the payload both embed it; tests
 * and consumers assert on this string, not on prose around it.
 */
export const EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX =
  'official external-cli admission refused';

/** Where an external-cli runner step was found inside a runner config. */
export interface ExternalCliRunnerStepFinding {
  /** Step location inside the config, e.g. `steps[0].parallel[1]`. */
  readonly location: string;
  /** The code-owned adapter id when the step declares one (`codex-exec`, …). */
  readonly adapter?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Serialized runner/append envelopes. The SDK owns this finite grammar;
// extending vendor config does not silently extend the custody input authority.
const CONFIG_KEYS = new Set([
  'id','createdAt','steps','resultPath','cwd','placeholder','taskIndex','totalTasks','maxOutput','artifactsDir','artifactConfig',
  'share','sessionDir','asyncDir','sessionId','completionOwnerId','piPackageRoot','piArgv1','worktreeSetupHook',
  'worktreeSetupHookTimeoutMs','worktreeBaseDir','controlConfig','controlIntercomTarget','childIntercomTargets',
  'resultMode','mode','dynamicFanoutMaxItems','workflowGraph','nestedRoute','nestedSelf','timeoutMs','deadlineAt',
  'toolTimeoutMs','toolBudget','usageBudget','revivalLease','revivalLeaseToken','globalConcurrencyLimit',
  'capabilityCeiling','runFanoutBudget','launchContractDigest','launchResolvedExtensions','runtimeAcknowledgedExtensions',
  'runnerProcessInstanceId','launchBarrierToken','parentWorkflowRunId','workflowKey','lane',
]);
const EXTERNAL_STEP_KEYS = new Set([
  'parentSessionId','permissionRules','externalJobFollowUp','agent','task','runner','agentSource','sessionName','context','forkContext','importAsyncRoot','phase','label','outputName',
  'structured','cwd','requestedCwd','model','contextLimit','fast','thinking','thinkingCeiling','modelCandidates',
  'skipPrimaryModelVerification','modelVerificationRegistry','tools','allowNestedSubagents','extensions','subagentOnlyExtensions',
  'mcpDirectTools','mcpConfig','runtimeServerNames','mutationTools','completionGuard','systemPrompt','systemPromptMode',
  'inheritProjectContext','inheritGlobalContext','inheritSkills','skills','outputPath','outputClaimPath','namespaceOutputPath',
  'outputMode','sessionFile','maxSubagentDepth','timeoutMs','toolTimeoutMs','waitToolEnabled','waitToolDefaultTimeoutMs',
  'structuredOutput','structuredOutputSchema','agentContract','definitionDigest','launchBindingTask','launchContractDigest',
  'extensionBindings','launchResolvedExtensions','runtimeAcknowledgedExtensions','effectiveAcceptance','acceptanceInput',
  'acceptanceRole','gateOn','toolBudget','capabilityCeiling','capabilityAudit','runFanoutPath','worktree','lane',
]);

/**
 * Scan one serialized step (and, recursively, its parallel members) for an
 * external-cli runner declaration. Mirrors the vendored `RunnerStep` union
 * exactly: a sequential step, a `{ parallel: [...] }` group, or a dynamic
 * `{ parallel: {...} }` group — the three shapes the vendored runner
 * executes, and nothing else.
 */
function scanStepForExternalCli(step: Record<string, unknown>, location: string): ExternalCliRunnerStepFinding | undefined {
  const runner = step.runner;
  if (isRecord(runner) && runner.type === 'external-cli') {
    return {
      location,
      ...(typeof runner.adapter === 'string' ? { adapter: runner.adapter } : {}),
    };
  }
  const parallel = step.parallel;
  if (Array.isArray(parallel)) {
    for (const [taskIndex, task] of parallel.entries()) {
      if (!isRecord(task)) continue;
      const finding = scanStepForExternalCli(task, `${location}.parallel[${taskIndex}]`);
      if (finding !== undefined) return finding;
    }
    return undefined;
  }
  if (isRecord(parallel)) {
    return scanStepForExternalCli(parallel, `${location}.parallel`);
  }
  return undefined;
}

/**
 * Find the first external-cli runner step in a parsed runner config. Pure:
 * no I/O, no agent-name resolution. Returns undefined when the config admits
 * (including configs with no steps array at all — shape validation is the
 * vendored runner's own failure, not this gate's).
 */
export function findExternalCliRunnerStep(config: unknown): ExternalCliRunnerStepFinding | undefined {
  if (!isRecord(config) || !Array.isArray(config.steps)) return undefined;
  for (const [index, step] of config.steps.entries()) {
    if (!isRecord(step)) continue;
    const finding = scanStepForExternalCli(step, `steps[${index}]`);
    if (finding !== undefined) return finding;
  }
  return undefined;
}

/** The typed refusal reason for a located external-cli runner step. */
export function externalCliCustodyRefusalReason(configPath: string, finding: ExternalCliRunnerStepFinding): string {
  return `${EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX}: runner config ${configPath} declares runner.type 'external-cli' at ${finding.location}${isOfficialExternalCliAdapter(finding.adapter) ? ` with adapter '${finding.adapter}'` : ''}`;
}

/**
 * The admission verdict for one runner config path: undefined when the config
 * admits, or the fail-closed refusal reason (unreadable file, invalid JSON,
 * or a located external-cli runner step). Both custody surfaces refuse on a
 * non-undefined verdict before any state exists.
 */
export function externalCliAdmissionRefusal(configPath: string): string | undefined {
  try { admittedRunnerConfigSnapshot(configPath); return undefined; }
  catch (error) { if (error instanceof CustodyDispatchRefusalError) return error.reason; throw error; }
}
export function admittedRunnerConfigSnapshot(configPath: string): { config: unknown; digest: string } {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new CustodyDispatchRefusalError(`runner config ${configPath} is unreadable at external-cli admission`);
  }
  if (Buffer.byteLength(text) > 1024 * 1024) throw new CustodyDispatchRefusalError('external_cli_input_too_large');
  let config: unknown;
  try {
    config = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CustodyDispatchRefusalError(`runner config ${configPath} is not valid JSON at external-cli admission`);
  }
  const reason = externalCliConfigRefusal(config, configPath);
  if (reason) throw new CustodyDispatchRefusalError(reason);
  return {config,digest:runnerConfigDigest(text)};
}

/** One input authority for initial, payload and append. Never issues a spawn permit. */
export function externalCliConfigRefusal(
  config: unknown, label: string, installations: readonly AttestedOfficialExternalCliV2[] = custodyExternalInstallations(),
): string | undefined {
  if (!isRecord(config) || !Array.isArray(config.steps)) return 'external_cli_input_invalid';
  if (Object.keys(config).some(k => !CONFIG_KEYS.has(k))) return 'external_cli_input_unknown_key';
  let count = 0;
  const walk = (steps: unknown[], location: string, depth = 0): string | undefined => {
    if (depth > 32) return 'external_cli_input_too_deep';
    for (const [index, step] of steps.entries()) {
      if (++count > 4096) return 'external_cli_input_too_large';
      if (!isRecord(step)) return 'external_cli_input_invalid';
      const at = `${location}[${index}]`;
      if (step.runner !== undefined) {
        if (!isRecord(step.runner)) return 'external_cli_input_invalid';
        const runner = step.runner;
        if (runner.type !== 'pi' && runner.type !== 'external-cli') return 'external_cli_runner_unknown';
        if (runner.type === 'external-cli') {
          const finding = { location: at, ...(typeof runner.adapter === 'string' ? { adapter: runner.adapter } : {}) };
          if (!isOfficialExternalCliAdapter(runner.adapter)) return externalCliCustodyRefusalReason(label, finding);
          // No caller argv, config, key helper, env, endpoint or auth override surface.
          if (Object.keys(runner).some(k => !['type','adapter','command','args','promptDelivery','capabilities'].includes(k))
            || (runner.args !== undefined && (!Array.isArray(runner.args) || runner.args.length !== 0))
            || (runner.promptDelivery !== undefined && runner.promptDelivery !== 'stdin')
            || (runner.capabilities !== undefined && (!isRecord(runner.capabilities) || Object.values(runner.capabilities).some(v => v !== false)))) {
            return 'external_cli_override_forbidden';
          }
          const install = installations.find(v => v.adapter === runner.adapter);
          if (!install) return externalCliCustodyRefusalReason(label, finding);
          const expectedCommand = install.identity.interpreter?.path ?? install.identity.installPath;
          const alias = install.adapter.startsWith('codex-') ? 'codex' : 'claude';
          if (runner.command !== expectedCommand && runner.command !== alias) return 'external_cli_command_mismatch';
          // Known request keys only. Secrets/config flags cannot hide in extra step fields.
          if (Object.keys(step).some(k => !EXTERNAL_STEP_KEYS.has(k)
            || /auth|credential|api.?key|endpoint|config|env/iu.test(k))) return 'external_cli_override_forbidden';
        }
      }
      if (step.parallel !== undefined) {
        const members = Array.isArray(step.parallel) ? step.parallel : isRecord(step.parallel) ? [step.parallel] : undefined;
        if (!members) return 'external_cli_input_invalid';
        const refused = walk(members, `${at}.parallel`,depth+1);
        if (refused) return refused;
      }
    }
    return undefined;
  };
  return walk(config.steps, 'steps');
}

export function runnerConfigDigest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function externalCliAppendRefusal(config: unknown, label: string): string | undefined {
  const reason = externalCliConfigRefusal(config,label);
  if (reason) return reason;
  if (findExternalCliRunnerStep(config)) {
    const verified = verifiedCustodyRunner();
    if (!verified) return 'external_cli_verified_runner_required';
    try {
      if (externalCliCommitment(loadCustodyLaunchRecord(process.env)) !== externalCliCommitment(verified)) return 'external_cli_parent_record_changed';
    } catch { return 'external_cli_parent_record_changed'; }
  }
  return undefined;
}
export function readAdmittedRunnerConfig(configPath: string): unknown {
  const {config,digest} = admittedRunnerConfigSnapshot(configPath);
  if (process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]) {
    const parent = parseDescendantLaunch(loadCustodyLaunchRecord(process.env));
    const committed = parent.perLaunch.mcp.metadata['byok.custody.runnerConfigDigest'];
    if (parent.perLaunch.templateKind !== 'pi-subagent-runner' || committed !== digest) {
      throw new CustodyDispatchRefusalError('external_cli_config_commitment_mismatch');
    }
  }
  return config;
}
