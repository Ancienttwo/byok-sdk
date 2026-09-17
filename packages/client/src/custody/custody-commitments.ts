/**
 * Shared custody commitment core for the pi-subagent preset entries
 * (`pi-subagent-print`, `pi-subagent-runner`).
 *
 * Both entries receive the same parent-minted inputs and enforce the same
 * fail-closed shape on them: the runner/parent contract depth travels as the
 * `BYOK_SDK_CUSTODY_PARENT_DEPTH` environment commitment, and the per-launch
 * descendant record (`byok.descendant-launch`) travels as the
 * `BYOK_SDK_CUSTODY_LAUNCH_RECORD` path commitment. Both names are minted by
 * the SDK custody dispatcher between resolve and spawn, are registered launch
 * lifecycle names (`TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES`), and are
 * never part of the attested exec env — the entries re-project only the
 * record's declared `exactNames`.
 *
 * Moved verbatim from `pi-subagent-print-entry.ts` when the runner entry
 * arrived (WP4, contract 20260917-2002): one authority for the commitment
 * parsing, the refusal shape and the expectation derivation, consumed by both
 * entries. The depth arithmetic stays per-entry, because the frozen counting
 * table charges each bootstrap edge differently (print +0, runner +1).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  RUNTIME_DESCENDANT_EDGES,
  type DescendantLaunchV1,
  type DescendantSpawnExpectationV1,
} from '@byok-sdk/implementation-identity';

/** Parent-minted commitment carrying the dispatching parent's contract depth. */
export const BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV = 'BYOK_SDK_CUSTODY_PARENT_DEPTH';
/** Parent-minted commitment naming the per-launch descendant record file. */
export const BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV = 'BYOK_SDK_CUSTODY_LAUNCH_RECORD';
/**
 * Parent-minted commitment naming the per-launch background runner config
 * file (WP4): the dispatcher writes the runner config exactly where the old
 * jiti spawn wrote it and hands the absolute path to the runner payload
 * through this transport commitment. Like the other two custody commitments
 * it is transport-only — never part of the attested exec env projection.
 */
export const BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV = 'BYOK_SDK_CUSTODY_RUNNER_CONFIG';

/**
 * A custody refusal: the entry stops without execing instead of guessing.
 * Shared by every pi-subagent preset entry; each entry's name appears in the
 * refusal reason, not in the error class.
 */
export class PiSubagentCustodyRefusalError extends Error {
  constructor(readonly reason: string) {
    super(`custody preset entry refused: ${reason}`);
    this.name = 'PiSubagentCustodyRefusalError';
  }
}

export function refusal(reason: string): never {
  throw new PiSubagentCustodyRefusalError(reason);
}

/**
 * Parse the parent depth commitment. Missing, empty or non-integer values
 * refuse; the vendor-computed depth is never consulted.
 */
export function parseCustodyParentDepthCommitment(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV];
  if (raw === undefined || raw === '') {
    refusal(`${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} missing: the runner contract depth commitment is required`);
  }
  if (!/^[0-9]+$/u.test(raw)) {
    refusal(`${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const depth = Number(raw);
  if (!Number.isSafeInteger(depth)) {
    refusal(`${BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV} is not a safe integer`);
  }
  return depth;
}

/** Read and shape-check the parent-minted per-launch record path commitment. */
export function loadCustodyLaunchRecord(env: Readonly<Record<string, string | undefined>>): unknown {
  const recordPath = env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV];
  if (recordPath === undefined || recordPath === '' || !path.isAbsolute(recordPath) || /[\u0000\r\n]/u.test(recordPath)) {
    refusal(`${BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV} must be an absolute path to the parent-minted launch record`);
  }
  let text: string;
  try {
    text = readFileSync(recordPath, 'utf8');
  } catch (error) {
    refusal(`${BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV} unreadable at ${recordPath}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    refusal(`launch record at ${recordPath} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Read and shape-check the parent-minted runner config path commitment. */
export function loadCustodyRunnerConfigPath(env: Readonly<Record<string, string | undefined>>): string {
  const configPath = env[BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV];
  if (configPath === undefined || configPath === '' || !path.isAbsolute(configPath) || /[\u0000\r\n]/u.test(configPath)) {
    refusal(`${BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV} must be an absolute path to the parent-written runner config`);
  }
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    refusal(`${BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV} unreadable at ${configPath}: ${(error as Error).message}`);
  }
  try {
    JSON.parse(text) as unknown;
  } catch (error) {
    refusal(`runner config at ${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  return configPath;
}

/**
 * The expectation is the frozen module vocabulary plus the parent's own
 * commitment: the parent charge comes from the environment commitment, so a
 * record forged with a different parent depth cannot self-consistently pass.
 */
export function deriveCustodyExpectation(launch: DescendantLaunchV1, parentDepth: number): DescendantSpawnExpectationV1 {
  return {
    template: launch.template,
    policy: launch.policy,
    edges: RUNTIME_DESCENDANT_EDGES,
    inheritedCredentialNames: [],
    parent: {
      kind: launch.perLaunch.edge.parent,
      rootTaskId: launch.perLaunch.rootTaskId,
      instancePath: launch.perLaunch.parentInstancePath,
      depth: parentDepth,
      effectiveLimits: launch.perLaunch.effectiveLimits,
    },
  };
}
