/**
 * Fixture driver for `custody-five-edge-dispatch.test.ts`. The five-edge
 * tests drive the REAL vendored pipelines (foreground `runSync`, background
 * `executeAsyncSingle`, the un-pruned `runSubagentRunnerEntry`) and capture
 * at the PHYSICAL spawn. That requires two things only a real process
 * provides: the vendored graph, the custody bridge, and the dispatcher must
 * be ONE module instance graph (the child permit is WeakMap-backed), and
 * the dispatcher's spawn must be a real exec (Bun binds builtin imports
 * directly, so no in-process `child_process.spawn` property patch can
 * intercept them). The driver is therefore both the parent that runs the
 * flows AND the spawn stub itself: the dispatcher mints the running file as
 * the attested entry, so every dispatched child re-enters this file with
 * `__byok_sdk_helper <kind>` argv and records its own exec evidence next to
 * the minted record before exiting. The driver only executes the flows and
 * records evidence; every assertion lives in the test file.
 *
 * Usage: <this process> <results-json-path>
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
} from '../../custody/custody-commitments';

const clientRoot = path.resolve(import.meta.dirname, '../../..');

// Spawn-stub branch: the dispatcher attests THIS file as the child entry,
// so a dispatched child re-enters here with the helper direct-connect
// argv. It writes its exec evidence next to the transported record and
// exits — no pi session, no grandchild, which keeps the five edges
// platform-safe while the physical spawn stays real.
if (process.argv[2] === '__byok_sdk_helper') {
  const recordPath = process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV];
  const evidence = {
    argv: [...process.argv],
    execArgv: [...process.execArgv],
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    env: { ...process.env },
    kind: process.argv[process.argv.length - 1],
  };
  const evidencePath = recordPath
    ? `${recordPath}.evidence.json`
    : path.join(process.env.BYOK_SDK_CUSTODY_RUNNER_CONFIG ?? '.', `evidence-${process.pid}.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
  process.exit(0);
}

// The vendored tree's two store-only peers (pi-agent-core, pi-tui) exist
// only next to the installed pi-subagents in the store layout; link them
// into node_modules/@earendil-works so native resolution from the vendored
// sources works. Ephemeral, idempotent, and outside the tracked tree.
{
  const storeScope = path.join(realpathSync(path.join(clientRoot, 'node_modules/pi-subagents')), '..', '@earendil-works');
  const scopeDir = path.join(clientRoot, 'node_modules', '@earendil-works');
  mkdirSync(scopeDir, { recursive: true });
  for (const peer of ['pi-agent-core', 'pi-tui']) {
    const target = path.join(storeScope, peer);
    const link = path.join(scopeDir, peer);
    if (existsSync(target) && !existsSync(link)) symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

// Computed specifier: the vendored sources publish TS with no consumable
// declarations, so the driver must not reference them with literal
// type-checkable import specifiers. The runtime resolves them natively.
async function vendoredImport<T = Record<string, unknown>>(relative: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(clientRoot, relative)).href)) as T;
}

interface AgentConfigShape {
  name: string;
  description: string;
  systemPromptMode: string;
  inheritProjectContext: boolean;
  inheritGlobalContext: boolean;
  inheritSkills: boolean;
  systemPrompt: string;
  source: string;
  filePath: string;
}

function makeAgent(): AgentConfigShape {
  return {
    name: 'general',
    description: 'custody five-edge probe agent',
    systemPromptMode: 'append',
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    systemPrompt: 'You are a custody probe.',
    source: 'project',
    filePath: path.join(clientRoot, 'src/__tests__/fixtures/five-edge-general-agent.md'),
  };
}

interface Evidence {
  argv: string[];
  execArgv: string[];
  pid: number;
  ppid: number;
  cwd: string;
  env: Record<string, string>;
  kind: string;
}

function recordsDir(budgetDirectory: string): string {
  return path.join(budgetDirectory, 'custody-records');
}

function readRecords(budgetDirectory: string): unknown[] {
  try {
    return readdirSync(recordsDir(budgetDirectory))
      .filter((file) => file.endsWith('.json') && !file.includes('.evidence.') && !file.includes('.sidecar.'))
      .map((file) => JSON.parse(readFileSync(path.join(recordsDir(budgetDirectory), file), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function readEvidence(budgetDirectory: string): Evidence[] {
  try {
    return readdirSync(recordsDir(budgetDirectory))
      .filter((file) => file.endsWith('.evidence.json'))
      .map((file) => JSON.parse(readFileSync(path.join(recordsDir(budgetDirectory), file), 'utf8')) as Evidence);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Poll until a child of `kind` has re-entered and left evidence. */
async function waitForEvidence(budgetDirectory: string, kind: string, seen: number, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (readEvidence(budgetDirectory).filter((entry) => entry.kind === kind).length > seen) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for a '${kind}' child evidence`);
}

async function main(): Promise<void> {
  const resultsPath = process.argv[2];
  if (!resultsPath) throw new Error('usage: driver <results-json-path>');
  const results: Record<string, unknown> = { __meta: { driverPid: process.pid } };
  const flush = (): void => {
    try {
      writeFileSync(resultsPath, JSON.stringify(results, null, 1));
    } catch {
      // Last-resort flush; a crashed driver leaves what it recorded.
    }
  };
  process.on('exit', flush);
  // The runner entry is fire-and-forget; late rejections from flows we have
  // already recorded must not kill the process before the final flush.
  process.on('unhandledRejection', () => {});

  const bridge = await vendoredImport<{
    RUN_FANOUT_BUDGET_ENV: string;
    createRunFanoutBudget: (rootRunId: string, limit: number) => { rootRunId: string; directory: string; limit: number };
    encodeRunFanoutBudgetDescriptor: (descriptor: { rootRunId: string; directory: string; limit: number }) => string;
  }>('src/custody/custody-vendor-bridge.js');
  const RUN_FANOUT_BUDGET_ENV = bridge.RUN_FANOUT_BUDGET_ENV;

  const CUSTODY_ENV_KEYS = [
    RUN_FANOUT_BUDGET_ENV,
    'PI_SUBAGENT_MAX_DEPTH',
    'PI_CODING_AGENT_SESSION_DIR',
    BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
    BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
    'BYOK_SDK_CUSTODY_RUNNER_CONFIG',
  ];

  interface BudgetHarness {
    budget: { rootRunId: string; directory: string; limit: number };
    workspace: string;
    sessionsDir: string;
    dispose: () => void;
  }

  function makeBudgetHarness(label: string): BudgetHarness {
    const saved = new Map(CUSTODY_ENV_KEYS.map((key) => [key, process.env[key]]));
    const budget = bridge.createRunFanoutBudget(`wp4-five-edge-${label}-${randomUUID()}`, 8);
    process.env[RUN_FANOUT_BUDGET_ENV] = bridge.encodeRunFanoutBudgetDescriptor(budget);
    process.env.PI_SUBAGENT_MAX_DEPTH = '3';
    delete process.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV];
    delete process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV];
    delete process.env.BYOK_SDK_CUSTODY_RUNNER_CONFIG;
    const workspace = mkdtempSync(path.join(os.tmpdir(), `wp4-five-edge-${label}-`));
    const sessionsDir = path.join(workspace, 'sessions');
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
    return {
      budget,
      workspace,
      sessionsDir,
      dispose: () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(workspace, { recursive: true, force: true });
        rmSync(budget.directory, { recursive: true, force: true });
      },
    };
  }

  function adoptChildParentContext(record: { perLaunch: { depth: number } }, recordPath: string, runnerConfigPath?: string): void {
    process.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV] = String(record.perLaunch.depth);
    process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV] = recordPath;
    if (runnerConfigPath !== undefined) process.env.BYOK_SDK_CUSTODY_RUNNER_CONFIG = runnerConfigPath;
  }

  interface ForegroundExecution {
    runSync: (runtimeCwd: string, agents: unknown[], agentName: string, task: string, options: Record<string, unknown>) => Promise<unknown>;
  }
  interface BackgroundExecution {
    executeAsyncSingle: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  }
  interface RunnerEntryModule {
    runSubagentRunnerEntry: (argv?: readonly string[]) => void;
  }

  async function runForegroundOnce(workspace: string, sessionsDir: string, runId: string): Promise<unknown> {
    const execution = await vendoredImport<ForegroundExecution>('vendor/pi-subagents/0.60.0/src/runs/foreground/execution.ts');
    return await execution.runSync(workspace, [makeAgent()], 'general', 'Report the custody depth projection.', {
      runId,
      index: 0,
      context: 'fresh',
      cwd: workspace,
      sessionDir: sessionsDir,
      modelOverride: 'test/stub-model',
      modelOverrideFromParent: true,
    });
  }

  async function runBackgroundOnce(workspace: string, sessionsDir: string, id: string, budget: unknown): Promise<unknown> {
    const asyncExecution = await vendoredImport<BackgroundExecution>('vendor/pi-subagents/0.60.0/src/runs/background/async-execution.ts');
    return await asyncExecution.executeAsyncSingle(id, {
      agent: 'general',
      task: 'Report the custody depth projection.',
      agentConfig: makeAgent(),
      ctx: { pi: { events: { emit() {}, on() {} } }, cwd: workspace, currentSessionId: 'wp4-five-edge-session', interactive: false },
      cwd: workspace,
      artifactsDir: path.join(workspace, 'artifacts'),
      artifactConfig: {},
      shareEnabled: false,
      sessionRoot: sessionsDir,
      sessionDir: sessionsDir,
      maxSubagentDepth: 3,
      runFanoutBudget: budget,
    });
  }

  interface PrintEntryModule {
    launchAttestedPiSubagentPrint: (input: Record<string, unknown>) => Promise<number>;
  }
  interface RunnerEntryModule2 {
    launchAttestedPiSubagentRunner: (input: Record<string, unknown>) => Promise<number>;
  }
  const printEntry = await vendoredImport<PrintEntryModule>('src/custody/pi-subagent-print-entry.ts');
  const runnerEntry = await vendoredImport<RunnerEntryModule2>('src/custody/pi-subagent-runner-entry.ts');

  const cases: Array<() => Promise<void>> = [
    // 1. rpc -> print: the foreground pipeline dispatches its print child.
    async () => {
      const harness = makeBudgetHarness('rpc-print');
      try {
        const runResult = await runForegroundOnce(harness.workspace, harness.sessionsDir, 'wp4-five-edge-rpc-print');
        const payload: Record<string, unknown> = { runResult };
        results['rpc-print'] = payload as never;
        await waitForEvidence(harness.budget.directory, 'pi-subagent-print', 0);
        payload.evidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-print');
        payload.records = readRecords(harness.budget.directory);
        // The record file the dispatcher transported to the child, captured
        // before the budget directory is disposed.
        const transportedPath = (payload.evidence as Evidence[]).at(-1)!.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]!;
        payload.transportedPath = transportedPath;
        payload.transported = JSON.parse(readFileSync(transportedPath, 'utf8'));
      } finally {
        harness.dispose();
      }
    },
    // 2. rpc -> runner: the background pipeline dispatches its runner child.
    async () => {
      const harness = makeBudgetHarness('rpc-runner');
      try {
        const asyncResult = await runBackgroundOnce(harness.workspace, harness.sessionsDir, `wp4-five-edge-${randomUUID()}`, harness.budget);
        const payload: Record<string, unknown> = { asyncResult };
        results['rpc-runner'] = payload as never;
        await waitForEvidence(harness.budget.directory, 'pi-subagent-runner', 0);
        payload.evidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-runner');
        payload.records = readRecords(harness.budget.directory);
      } finally {
        harness.dispose();
      }
    },
    // 3. print -> print: a dispatched print parent dispatches a print child.
    async () => {
      const harness = makeBudgetHarness('print-print');
      try {
        await runForegroundOnce(harness.workspace, harness.sessionsDir, 'wp4-five-edge-print-print-parent');
        await waitForEvidence(harness.budget.directory, 'pi-subagent-print', 0);
        const parentEvidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-print').at(-1)!;
        const parentRecordPath = parentEvidence.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]!;
        const parentRecord = readRecords(harness.budget.directory)
          .map((entry) => entry as { perLaunch: { templateKind: string; depth: number } })
          .find((entry) => entry.perLaunch.templateKind === 'pi-subagent-print')!;
        const parentDepth = parentRecord.perLaunch.depth;
        // The print child process runs with the dispatcher's transport env:
        // its own record plus its own contract depth commitment.
        adoptChildParentContext(parentRecord, parentRecordPath);
        await runForegroundOnce(harness.workspace, harness.sessionsDir, 'wp4-five-edge-print-print-child');
        const payload: Record<string, unknown> = { parentDepth };
        results['print-print'] = payload as never;
        await waitForEvidence(harness.budget.directory, 'pi-subagent-print', 1);
        payload.evidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-print');
        payload.records = readRecords(harness.budget.directory);
      } finally {
        harness.dispose();
      }
    },
    // 4. print -> runner: a dispatched print parent dispatches a runner.
    async () => {
      const harness = makeBudgetHarness('print-runner');
      try {
        await runForegroundOnce(harness.workspace, harness.sessionsDir, 'wp4-five-edge-print-runner-parent');
        await waitForEvidence(harness.budget.directory, 'pi-subagent-print', 0);
        const parentEvidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-print').at(-1)!;
        const parentRecord = readRecords(harness.budget.directory)
          .map((entry) => entry as { perLaunch: { templateKind: string; depth: number } })
          .find((entry) => entry.perLaunch.templateKind === 'pi-subagent-print')!;
        const parentDepth = parentRecord.perLaunch.depth;
        adoptChildParentContext(parentRecord, parentEvidence.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]!);
        await runBackgroundOnce(harness.workspace, harness.sessionsDir, `wp4-five-edge-${randomUUID()}`, harness.budget);
        const payload: Record<string, unknown> = { parentDepth };
        results['print-runner'] = payload as never;
        await waitForEvidence(harness.budget.directory, 'pi-subagent-runner', 0);
        payload.evidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-runner');
        payload.records = readRecords(harness.budget.directory);
      } finally {
        harness.dispose();
      }
    },
    // 5. runner -> print (bootstrap): the un-pruned runner entry dispatches
    // an equal-depth print child.
    async () => {
      const harness = makeBudgetHarness('runner-print');
      try {
        const started = await runBackgroundOnce(harness.workspace, harness.sessionsDir, `wp4-five-edge-${randomUUID()}`, harness.budget);
        await waitForEvidence(harness.budget.directory, 'pi-subagent-runner', 0);
        const mintEvidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-runner').at(-1)!;
        const runnerRecord = readRecords(harness.budget.directory)
          .map((entry) => entry as { perLaunch: { templateKind: string; depth: number } })
          .find((entry) => entry.perLaunch.templateKind === 'pi-subagent-runner')!;
        const runnerDepth = runnerRecord.perLaunch.depth;
        const mintedConfigPath = mintEvidence.env.BYOK_SDK_CUSTODY_RUNNER_CONFIG!;
        adoptChildParentContext(runnerRecord, mintEvidence.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]!, mintedConfigPath);
        // The runner config spawnRunner wrote (the real child never saw it)
        // runs one step here: its print dispatch is the bootstrap edge.
        const config = JSON.parse(readFileSync(mintedConfigPath, 'utf8')) as Record<string, unknown>;
        config.sessionDir = harness.sessionsDir;
        const runnerConfigPath = path.join(harness.workspace, 'runner-config.json');
        writeFileSync(runnerConfigPath, JSON.stringify(config), { mode: 0o600 });
        process.env.BYOK_SDK_CUSTODY_RUNNER_CONFIG = runnerConfigPath;
        // The runner child waits at the startup barrier for its parent's
        // proceed control; release it up front so the entry reaches its step.
        writeFileSync(
          path.join(String(config.asyncDir), 'runner-startup-proceed.json'),
          JSON.stringify({ action: 'proceed', token: config.launchBarrierToken }),
          { mode: 0o600 },
        );
        const runnerEntryModule = await vendoredImport<RunnerEntryModule>('vendor/pi-subagents/0.60.0/src/runs/background/subagent-runner.ts');
        runnerEntryModule.runSubagentRunnerEntry([runnerConfigPath]);
        const payload: Record<string, unknown> = { asyncResult: started, runnerDepth };
        results['runner-print'] = payload as never;
        await waitForEvidence(harness.budget.directory, 'pi-subagent-print', 0);
        payload.evidence = readEvidence(harness.budget.directory).filter((entry) => entry.kind === 'pi-subagent-print');
        payload.records = readRecords(harness.budget.directory);
      } finally {
        harness.dispose();
      }
    },
    // 6. forged: a double-charged print record refuses at the print entry.
    async () => {
      const harness = makeBudgetHarness('forge-double-charge');
      try {
        await runForegroundOnce(harness.workspace, harness.sessionsDir, 'wp4-five-edge-forge-print');
        const record = readRecords(harness.budget.directory)
          .map((entry) => entry as { perLaunch: { templateKind: string; depth: number; remainingDepth: number; envValues: Record<string, string> } & Record<string, unknown> })
          .find((entry) => entry.perLaunch.templateKind === 'pi-subagent-print')!;
        const parentDepth = record.perLaunch.depth - 1;
        // Forge: declare the depth one HIGHER than the charge table allows,
        // as if this edge had been charged twice.
        const forged = structuredClone(record);
        forged.perLaunch.depth = parentDepth + 2;
        forged.perLaunch.remainingDepth = record.perLaunch.remainingDepth - 1;
        forged.perLaunch.envValues.PI_SUBAGENT_DEPTH = String(parentDepth + 2);
        let execed = false;
        let rejected = false;
        let message = '';
        try {
          await printEntry.launchAttestedPiSubagentPrint({
            launch: forged,
            parentDepth,
            // The full declared env (with the tampered depth inside), so the
            // refusal lands on the depth rule, not on env completeness.
            observedEnv: { ...(process.env as Record<string, string>), ...forged.perLaunch.envValues },
            spawnImpl: async () => {
              execed = true;
              return 0;
            },
          });
        } catch (error) {
          rejected = true;
          message = (error as Error).message;
        }
        results['forge-double-charge'] = { forged: { rejected, message, execed } };
      } finally {
        harness.dispose();
      }
    },
    // 7. forged: a charge-skipped runner record refuses at the runner entry.
    async () => {
      const harness = makeBudgetHarness('forge-skip-charge');
      try {
        const started = await runBackgroundOnce(harness.workspace, harness.sessionsDir, `wp4-five-edge-${randomUUID()}`, harness.budget);
        const record = readRecords(harness.budget.directory)
          .map((entry) => entry as { perLaunch: { templateKind: string; depth: number; remainingDepth: number; envValues: Record<string, string> } & Record<string, unknown> })
          .find((entry) => entry.perLaunch.templateKind === 'pi-subagent-runner')!;
        const parentDepth = record.perLaunch.depth - 1;
        // Forge: round the record's depth DOWN to the parent's contract
        // depth, dodging the +1 runner bootstrap charge.
        const forged = structuredClone(record);
        forged.perLaunch.depth = parentDepth;
        forged.perLaunch.remainingDepth = record.perLaunch.remainingDepth + 1;
        forged.perLaunch.envValues.PI_SUBAGENT_DEPTH = String(parentDepth);
        let execed = false;
        let rejected = false;
        let message = '';
        try {
          await runnerEntry.launchAttestedPiSubagentRunner({
            launch: forged,
            parentDepth,
            // The full declared env (with the tampered depth inside), so the
            // refusal lands on the depth rule, not on env completeness.
            observedEnv: { ...(process.env as Record<string, string>), ...forged.perLaunch.envValues },
            spawnImpl: async () => {
              execed = true;
              return 0;
            },
          });
        } catch (error) {
          rejected = true;
          message = (error as Error).message;
        }
        results['forge-skip-charge'] = { asyncResult: started, forged: { rejected, message, execed } };
      } finally {
        harness.dispose();
      }
    },
    // 8. forged: a tampered template refuses to parse.
    async () => {
      const harness = makeBudgetHarness('forge-template');
      try {
        await runForegroundOnce(harness.workspace, harness.sessionsDir, 'wp4-five-edge-forge-template');
        const record = readRecords(harness.budget.directory)
          .map((entry) => entry as { template: { fixedArgv: string[] } } & Record<string, unknown>)
          .find((entry) => entry.template !== undefined)!;
        const forged = structuredClone(record);
        forged.template.fixedArgv = [...forged.template.fixedArgv.slice(0, -1), 'pi-subagent-print', '--forged'];
        const { parseDescendantLaunch } = await import('@byok-sdk/implementation-identity');
        let parseError = '';
        try {
          parseDescendantLaunch(forged as never);
        } catch (error) {
          parseError = (error as Error).message;
        }
        results['forge-template'] = { parseError };
      } finally {
        harness.dispose();
      }
    },
  ];

  for (const [index, runCase] of cases.entries()) {
    try {
      await runCase();
    } catch (error) {
      results[`case-error-${index}`] = { message: (error as Error).message, stack: (error as Error).stack };
    }
    flush();
  }
}

main().catch((error) => {
  process.stderr.write(`driver failed: ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exit(1);
});
