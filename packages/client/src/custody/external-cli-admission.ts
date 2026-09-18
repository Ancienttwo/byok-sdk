/**
 * N1 external-CLI admission gate (`custody/external-cli-admission.ts`, plan
 * 20260918-2052). Owner ruling 2026-09-18: the external-CLI lane's terminal
 * state is B — the last delegation hop becomes the sixth custody edge. Until
 * that edge is minted, the lane must not be reachable: `runs/shared/
 * external-cli-runner.ts` spawns an external CLI process tree with no
 * DescendantLaunchV1, no cap slot and no launch record, which makes it the
 * one vendored delegation edge that leaves SDK custody entirely.
 *
 * Every external-cli execution is async-only (the vendored foreground
 * executor refuses `runner.type='external-cli'` outside the background lane),
 * and every background runner child is minted by the custody dispatcher with
 * the parent-written runner config traveling as the runner config path
 * commitment. The runner config's serialized steps therefore carry the kind
 * exactly once, at the boundary the SDK owns — this module scans that shape
 * (sequential steps, `parallel` arrays, dynamic `parallel` objects — the same
 * three `RunnerStep` variants the vendored runner executes) and both custody
 * surfaces consult it:
 *
 *   dispatcher admission   custody-dispatcher.ts dispatchCustodyPiSubagentSpawn
 *   runner payload handoff pi-subagent-runner-payload.ts runPiSubagentRunnerPayload
 *
 * The scan is kind-based, never name-based: no agent registry is consulted,
 * so a renamed or hand-constructed definition cannot dodge it, and no second
 * name→kind authority is introduced. Unreadable or unparseable configs also
 * refuse — the admission is fail-closed with no fallback lane.
 */
import { readFileSync } from 'node:fs';

/**
 * Stable refusal prefix. The dispatcher and the payload both embed it; tests
 * and consumers assert on this string, not on prose around it.
 */
export const EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX =
  'external-cli delegation edge is not under custody (owner ruling 2026-09-18: external-cli terminal state B, sixth custody edge not yet minted)';

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
  return `${EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX}: runner config ${configPath} declares runner.type 'external-cli' at ${finding.location}${finding.adapter !== undefined ? ` with adapter '${finding.adapter}'` : ''}`;
}

/**
 * The admission verdict for one runner config path: undefined when the config
 * admits, or the fail-closed refusal reason (unreadable file, invalid JSON,
 * or a located external-cli runner step). Both custody surfaces refuse on a
 * non-undefined verdict before any state exists.
 */
export function externalCliAdmissionRefusal(configPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    return `runner config ${configPath} is unreadable at external-cli admission: ${(error as Error).message}`;
  }
  let config: unknown;
  try {
    config = JSON.parse(text) as unknown;
  } catch (error) {
    return `runner config ${configPath} is not valid JSON at external-cli admission: ${(error as Error).message}`;
  }
  const finding = findExternalCliRunnerStep(config);
  if (finding !== undefined) return externalCliCustodyRefusalReason(configPath, finding);
  return undefined;
}
