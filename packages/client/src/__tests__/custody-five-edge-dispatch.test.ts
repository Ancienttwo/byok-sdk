import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  descendantTemplateDigest,
  parseDescendantLaunch,
  type DescendantLaunchV1,
} from '@byok-sdk/implementation-identity';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
} from '../custody/custody-commitments';

// WP4 five-edge enablement tests (plan 2155, D7): every physical subagent
// spawn site in the vendored runtime must dispatch through the SDK custody
// dispatcher with the helper direct-connect argv shape, mint a per-launch
// descendant record on disk under the run's fan-out budget directory, and
// carry the frozen counting table's depth commitment. The drivers are the
// real vendored pipelines — `runSync` (foreground print lane),
// `executeAsyncSingle` (background runner lane) and the un-pruned runner
// entry (`runSubagentRunnerEntry`) — and the capture stub IS the spawned
// child: the dispatcher attests the driver file as the entry, so every
// dispatched child re-enters it with the `__byok_sdk_helper <kind>` argv
// and records its own exec evidence next to the minted record. No edge is
// skipped and no case needs a platform skip: the children exit immediately,
// so no real pi session ever starts.
//
// Charge table under test (owner ruling 2026-09-17): every edge charges
// one; only runner->print (the bootstrap edge) charges zero.
//
// The flows execute in `fixtures/custody-five-edge-driver.ts`, a real child
// process: the vendored graph, the custody bridge, and the dispatcher must
// be ONE module instance graph (the child permit is a WeakMap-backed opaque
// object), and only the runtime's own loader guarantees that identity. The
// driver records evidence; every assertion lives here.

const clientRoot = path.resolve(import.meta.dirname, '../..');
const driverPath = path.join(import.meta.dirname, 'fixtures/custody-five-edge-driver.ts');

interface Evidence {
  argv: string[];
  execArgv: string[];
  pid: number;
  ppid: number;
  cwd: string;
  env: Record<string, string>;
  kind: string;
}

interface ForgeOutcome {
  rejected: boolean;
  message: string;
  execed: boolean;
}

interface CaseResult {
  evidence?: Evidence[];
  records?: DescendantLaunchV1[];
  transported?: DescendantLaunchV1;
  transportedPath?: string;
  parentDepth?: number;
  runnerDepth?: number;
  asyncResult?: { isError?: boolean; content?: Array<{ text?: string }> };
  forged?: ForgeOutcome;
  parseError?: string;
  /** Gate F1 cases: the refusal shape plus post-refusal state listings. */
  cap?: {
    refused: boolean;
    errorName: string;
    reason: string;
    records: string[];
    launches: string[];
    sessionSlots: string[];
    parallelSlots: string[];
    claims: string[];
  };
  /** Gate F2a case: stale-claim reclamation evidence. */
  reclaim?: {
    deadPidConfirmed: boolean;
    staleLaunchId: string;
    staleGone: { record: boolean; sidecar: boolean; ledger: boolean };
    staleSlotsReclaimed: { session: boolean; parallel: boolean };
    recordFiles: string[];
    evidence: number;
    newLedgerLauncherPidIsDriver: boolean;
  };
  /** Gate F2b cases: admission refusals leave zero state. */
  refusal?: {
    refused: boolean;
    errorName: string;
    reason: string;
    before?: string[];
    after?: string[];
    budgetListing?: string[];
  };
}

let results: Record<string, CaseResult> = {};
let driverPid = -1;
let driverStderr = '';
let driverStatus: number | null = null;

beforeAll(() => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'wp4-five-edge-results-'));
  const resultsPath = path.join(scratch, 'results.json');
  try {
    // The test worker may be Node (the vitest bin's shebang wins over bun
    // run); the driver needs the runtime's native TS loader, so prefer the
    // running bun binary and fall back to `bun` from PATH.
    const bunExecutable = path.basename(process.execPath) === 'bun' ? process.execPath : 'bun';
    const run = spawnSync(bunExecutable, [driverPath, resultsPath], {
      encoding: 'utf8',
      timeout: 180_000,
      cwd: clientRoot,
    });
    driverStatus = run.status;
    driverStderr = run.stderr ?? '';
    if (!existsSync(resultsPath)) {
      throw new Error(`driver produced no results (status ${run.status}): ${driverStderr.slice(0, 4000) || run.stdout?.slice(0, 1000)}`);
    }
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as Record<string, unknown>;
    driverPid = (parsed.__meta as { driverPid: number }).driverPid;
    delete parsed.__meta;
    results = parsed as Record<string, CaseResult>;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 200_000);

function requireCase(name: string): CaseResult {
  const result = results[name];
  if (!result) {
    throw new Error(
      `driver produced no '${name}' case result (status ${driverStatus}): ${driverStderr.slice(0, 2000) || JSON.stringify(Object.keys(results))}`,
    );
  }
  return result;
}

/**
 * (a) The physical spawn used the dispatcher's helper direct-connect shape,
 * re-entering the attested entry file, and the evidence came from a REAL
 * separate process (own pid, the driver as its parent).
 */
function expectHelperDirectConnect(evidence: Evidence, kind: string): void {
  expect(evidence.argv[evidence.argv.length - 2]).toBe('__byok_sdk_helper');
  expect(evidence.argv[evidence.argv.length - 1]).toBe(kind);
  expect(evidence.argv[1]).toBe(driverPath);
  expect(evidence.pid).not.toBe(driverPid);
  expect(evidence.ppid).toBe(driverPid);
}

/** (b) The minted record: format, digest binding, edge identity, charge. */
function expectAttestedRecord(record: DescendantLaunchV1, edge: { parent: string; child: string }, depth: number): void {
  expect(record.format).toBe('byok.descendant-launch');
  expect(record.templateDigest).toBe(descendantTemplateDigest(record.template));
  expect(record.perLaunch.edge).toEqual(edge);
  expect(record.perLaunch.depth).toBe(depth);
  expect(record.perLaunch.remainingDepth).toBe(record.policy.maxDepth - depth);
  expect(record.template.fixedArgv[record.template.fixedArgv.length - 1]).toBe(edge.child);
}

describe('custody five-edge dispatch: every spawn edge routes through the attested dispatcher', () => {
  it('rpc -> print: the foreground pipeline dispatches a depth-1 print child over the helper direct-connect shape', () => {
    const result = requireCase('rpc-print');
    expect(result.evidence?.length, `expected a print dispatch: ${driverStderr.slice(0, 2000)}`).toBeGreaterThan(0);
    const evidence = result.evidence!.at(-1)!;
    expectHelperDirectConnect(evidence, 'pi-subagent-print');
    // (b) the minted record on disk: shape, digest, edge identity, charge.
    const record = parseDescendantLaunch(result.records!.find((entry) => entry.perLaunch.templateKind === 'pi-subagent-print') as unknown);
    expectAttestedRecord(record, { parent: 'pi-rpc', child: 'pi-subagent-print' }, 1);
    // (c) depth commitment chain: the child's exec env carries its own
    // depth, the transport carries the attested record, no ambient leak.
    expect(evidence.env.PI_SUBAGENT_DEPTH).toBe('1');
    expect(evidence.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBe('0');
    const transportedPath = evidence.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]!;
    expect(transportedPath).toContain('custody-records');
    const transported = parseDescendantLaunch(result.transported as unknown);
    expect(transported.templateDigest).toBe(record.templateDigest);
    expect(evidence.env.PI_SUBAGENT_MAX_DEPTH).toBe('3');
  });

  it('rpc -> runner: the background pipeline dispatches a depth-1 runner over the helper direct-connect shape', () => {
    const result = requireCase('rpc-runner');
    expect(
      result.asyncResult?.isError,
      `executeAsyncSingle refused: ${JSON.stringify(result.asyncResult?.content)}`,
    ).toBeFalsy();
    expect(result.evidence?.length, 'the vendored background lane must dispatch its runner child').toBeGreaterThan(0);
    const evidence = result.evidence!.at(-1)!;
    expectHelperDirectConnect(evidence, 'pi-subagent-runner');
    const record = parseDescendantLaunch(result.records!.find((entry) => entry.perLaunch.templateKind === 'pi-subagent-runner') as unknown);
    expectAttestedRecord(record, { parent: 'pi-rpc', child: 'pi-subagent-runner' }, 1);
    // The runner lane transports the runner config path commitment.
    expect(evidence.env.BYOK_SDK_CUSTODY_RUNNER_CONFIG).toBeTruthy();
    expect(evidence.env.PI_SUBAGENT_DEPTH).toBe('1');
    expect(evidence.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBe('0');
  });

  it('print -> print: a dispatched print parent dispatches a depth+1 print child (edge charge one)', () => {
    const result = requireCase('print-print');
    expect(result.evidence?.length, 'the print parent must dispatch its print child').toBe(2);
    // Parent and child evidence carry different depth commitments; readdir
    // order is not mint order, so select the child by its own depth.
    const parentDepth = result.parentDepth!;
    const childEvidence = result.evidence!.find((entry) => entry.env.PI_SUBAGENT_DEPTH === String(parentDepth + 1))!;
    expectHelperDirectConnect(childEvidence, 'pi-subagent-print');
    const record = parseDescendantLaunch(
      result.records!.find((entry) => entry.perLaunch.templateKind === 'pi-subagent-print' && entry.perLaunch.edge.parent === 'pi-subagent-print') as unknown,
    );
    // print -> print charges one: depth = parent depth + 1.
    expectAttestedRecord(record, { parent: 'pi-subagent-print', child: 'pi-subagent-print' }, parentDepth + 1);
    expect(childEvidence.env.PI_SUBAGENT_DEPTH).toBe(String(parentDepth + 1));
    // The transport's parent-depth commitment is the parent's contract depth.
    expect(childEvidence.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBe(String(parentDepth));
  });

  it('print -> runner: a dispatched print parent dispatches a depth+1 runner (edge charge one)', () => {
    const result = requireCase('print-runner');
    expect(result.evidence?.length, 'the print parent must dispatch its runner child').toBeGreaterThan(0);
    const evidence = result.evidence!.at(-1)!;
    expectHelperDirectConnect(evidence, 'pi-subagent-runner');
    const record = parseDescendantLaunch(
      result.records!.find((entry) => entry.perLaunch.templateKind === 'pi-subagent-runner' && entry.perLaunch.edge.parent === 'pi-subagent-print') as unknown,
    );
    const parentDepth = result.parentDepth!;
    // print -> runner charges one.
    expectAttestedRecord(record, { parent: 'pi-subagent-print', child: 'pi-subagent-runner' }, parentDepth + 1);
    expect(evidence.env.PI_SUBAGENT_DEPTH).toBe(String(parentDepth + 1));
  });

  it('runner -> print (bootstrap): the runner entry dispatches an equal-depth print child (edge charge zero)', () => {
    const result = requireCase('runner-print');
    expect(
      result.asyncResult?.isError,
      `executeAsyncSingle refused: ${JSON.stringify(result.asyncResult?.content)}`,
    ).toBeFalsy();
    expect(result.evidence?.length, 'the runner entry must dispatch its print child').toBeGreaterThan(0);
    const evidence = result.evidence!.at(-1)!;
    expectHelperDirectConnect(evidence, 'pi-subagent-print');
    const record = parseDescendantLaunch(
      result.records!.find((entry) => entry.perLaunch.templateKind === 'pi-subagent-print' && entry.perLaunch.edge.parent === 'pi-subagent-runner') as unknown,
    );
    const runnerDepth = result.runnerDepth!;
    // THE bootstrap edge: runner -> print charges ZERO — the print child's
    // contract depth equals the runner's own contract depth.
    expectAttestedRecord(record, { parent: 'pi-subagent-runner', child: 'pi-subagent-print' }, runnerDepth);
    expect(evidence.env.PI_SUBAGENT_DEPTH).toBe(String(runnerDepth));
    expect(evidence.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV]).toBe(String(runnerDepth));
  });
});

describe('custody five-edge dispatch: forged records refuse at the attested entries', () => {
  it('a double-charged print record refuses at the print entry', () => {
    const result = requireCase('forge-double-charge');
    expect(result.forged?.rejected, `expected refusal, got exec path: ${result.forged?.message}`).toBe(true);
    expect(result.forged?.execed, 'a double-charged record must not exec').toBe(false);
    expect(result.forged?.message).toContain('depth');
  });

  it('a charge-skipped runner record refuses at the runner entry', () => {
    const result = requireCase('forge-skip-charge');
    expect(result.asyncResult?.isError, `executeAsyncSingle refused: ${JSON.stringify(result.asyncResult?.content)}`).toBeFalsy();
    expect(result.forged?.rejected, `expected refusal, got exec path: ${result.forged?.message}`).toBe(true);
    expect(result.forged?.execed, 'a charge-skipped record must not exec').toBe(false);
    expect(result.forged?.message).toContain('depth');
  });

  it('a record whose attested template bytes were tampered refuses to parse', () => {
    const result = requireCase('forge-template');
    expect(result.parseError, 'the tampered record must refuse to parse').toBeTruthy();
  });
});

// Gate findings F1/F2 (acceptance review 4de4dcb0): the cap-enforcement and
// crash-stage-sweep branches of the dispatcher had no coverage. The driver
// forges the on-disk state a second dispatcher process would leave (slot
// files, admission ledger, sidecar) and runs real dispatches against it.
describe('custody five-edge dispatch: cross-process cap enforcement refuses fail-closed (F1)', () => {
  it('a second dispatcher session full of slot files refuses the next dispatch without minting anything', () => {
    const result = requireCase('cap-session').cap!;
    expect(result.refused, `expected a refusal, got success: ${result.reason}`).toBe(true);
    expect(result.errorName).toBe('CustodyDispatchRefusalError');
    expect(result.reason).toContain('session cap exhausted: 2 live dispatched children for this session');
    // Fail-closed: the refusal mints no record or ledger, claims no new
    // slot, and leaves no fanout claim behind — only the forged slots exist.
    expect(result.records).toEqual([]);
    expect(result.launches).toEqual([]);
    expect(result.sessionSlots).toEqual(['000000.json', '000001.json']);
    expect(result.parallelSlots).toEqual([]);
    expect(result.claims).toEqual([]);
  });

  it('a full parallel-cap slot set for this root task refuses the next dispatch without minting anything', () => {
    const result = requireCase('cap-parallel').cap!;
    expect(result.refused, `expected a refusal, got success: ${result.reason}`).toBe(true);
    expect(result.errorName).toBe('CustodyDispatchRefusalError');
    expect(result.reason).toContain('parallel cap exhausted: 4 live dispatched children for this root task');
    expect(result.records).toEqual([]);
    expect(result.launches).toEqual([]);
    expect(result.sessionSlots).toEqual([]);
    expect(result.parallelSlots).toEqual(['000000.json', '000001.json', '000002.json', '000003.json']);
    expect(result.claims).toEqual([]);
  });
});

describe('custody five-edge dispatch: crash-stage sweep and refusal leave no state (F2)', () => {
  it('the admission sweep reclaims a dead-launcher stale claim before the next real launch proceeds', () => {
    const result = requireCase('stale-reclaim').reclaim!;
    expect(result.deadPidConfirmed, 'the forged launcher pid must be genuinely dead').toBe(true);
    // Precondition: the full 已准入未spawn state existed on disk (real
    // dispatcher-written record, sidecar, ledger, both cap slots).
    // The sweep removed the stale record, sidecar and ledger (launchId-keyed,
    // never recreated by the new launch).
    expect(result.staleGone).toEqual({ record: true, sidecar: true, ledger: true });
    // The new launch proceeded through the real foreground pipeline: a real
    // child re-entered and left evidence, a new record was minted, and the
    // live ledger names the driver as its (alive) launcher.
    expect(result.evidence).toBeGreaterThan(0);
    expect(result.recordFiles).not.toContain(`${result.staleLaunchId}.json`);
    expect(result.newLedgerLauncherPidIsDriver).toBe(true);
    // The stale slot claims were reclaimed inside the same admission: the
    // surviving slot files at the stale paths now belong to the live new
    // launcher (the forged content carried the dead pid).
    expect(result.staleSlotsReclaimed).toEqual({ session: true, parallel: true });
  });

  it('an invalid-edge refusal (runner -> runner) leaves the budget tree byte-for-byte unchanged', () => {
    const result = requireCase('refuse-edge').refusal!;
    expect(result.refused, `expected a refusal, got success: ${result.reason}`).toBe(true);
    expect(result.errorName).toBe('CustodyDispatchRefusalError');
    expect(result.reason).toContain('not in the frozen runtime edge vocabulary');
    expect(result.after).toEqual(result.before);
  });

  it('a missing-budget refusal leaves custody-records/, custody-launches/ and custody-caps/ absent', () => {
    const result = requireCase('refuse-no-budget').refusal!;
    expect(result.refused, `expected a refusal, got success: ${result.reason}`).toBe(true);
    expect(result.reason).toContain('no SDK dispatch context');
    const custodyEntries = (result.budgetListing ?? []).filter((entry) => entry.startsWith('custody-'));
    expect(custodyEntries, `unexpected custody state in the untouched budget: ${JSON.stringify(result.budgetListing)}`).toEqual([]);
  });
});
