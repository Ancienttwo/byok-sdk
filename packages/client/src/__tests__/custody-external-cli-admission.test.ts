import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CustodyDispatchRefusalError, dispatchCustodyPiSubagentSpawn } from '../custody/custody-dispatcher';
import {
  EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX,
  externalCliAdmissionRefusal,
  findExternalCliRunnerStep,
} from '../custody/external-cli-admission';
import {
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
  BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV,
} from '../custody/custody-commitments';

// N1 external-CLI admission gate tests (plan 20260918-2052, contract
// 20260918-2052-n1-external-cli-gate). Owner ruling 2026-09-18: the
// external-CLI lane's terminal state is B (the last delegation hop becomes
// the sixth custody edge); until that edge is minted the lane must refuse
// typed at every SDK-owned boundary it can cross. Verified reachability:
//
//   dispatcher admission   every background runner child is minted by
//                          dispatchCustodyPiSubagentSpawn with the
//                          parent-written runner config, and external-cli
//                          execution is async-only — so the config's steps
//                          carry the kind exactly once at this boundary;
//   runner payload handoff runPiSubagentRunnerPayload is the second custody
//                          surface the same config crosses (rewrite-after-
//                          admission, hand-driven invocation);
//   subagent definitions  enter only through vendored discovery/registry
//                          surfaces — the SDK owns no registration face, so
//                          no third gate exists to build without vendored
//                          edits (B's implementation face).
//
// The scan is kind-based (`runner.type === 'external-cli'` in the serialized
// steps), never name-based: every adapter face (codex-exec / claude-code /
// cursor-agent and their writer variants), the bare form, and every nesting
// shape the vendored runner executes (sequential, parallel array, dynamic
// parallel object) must refuse with the same typed error, and no constructed
// definition shape can dodge the gate. The five already-enabled custody
// edges are covered by custody-five-edge-dispatch.test.ts and must stay
// untouched — the clean-config control here proves the runner lane itself
// still admits.

const clientRoot = path.resolve(import.meta.dirname, '../..');

// Computed specifier: the vendored tree publishes TS with no consumable
// declarations, so tests must not reference it with literal type-checkable
// import specifiers. The runtime resolves them natively.
async function vendoredImport<T = Record<string, unknown>>(relative: string): Promise<T> {
  return (await import(pathToFileURL(path.resolve(clientRoot, relative)).href)) as T;
}

interface Budget {
  rootRunId: string;
  directory: string;
  limit: number;
}

interface BudgetHarness {
  budget: Budget;
  workspace: string;
  sessionsDir: string;
  dispose: () => void;
}

const RUN_FANOUT_BUDGET_ENV = 'PI_SUBAGENT_RUN_FANOUT_BUDGET';

interface DispatchOutcome {
  refused: boolean;
  errorName: string;
  message: string;
}

function outcomeOf(run: () => unknown): DispatchOutcome {
  try {
    run();
    return { refused: false, errorName: '', message: '' };
  } catch (error) {
    return {
      refused: error instanceof CustodyDispatchRefusalError,
      errorName: error instanceof Error ? error.name : '',
      message: error instanceof Error ? error.message : '',
    };
  }
}

/** Sorted listing of a directory; [] when it does not exist (ENOENT). */
function listDirSafe(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The custody state a dispatch must never leave behind on a refusal. */
function custodyState(budgetDirectory: string): string[] {
  return listDirSafe(budgetDirectory).filter((entry) => entry.startsWith('custody-'));
}

interface StepShape extends Record<string, unknown> {
  agent: string;
  task: string;
  runner?: Record<string, unknown>;
}

function stepWithRunner(runner: Record<string, unknown>): StepShape {
  return { agent: 'probe', task: 'external probe', runner };
}

/** Write a runner config with the serialized step shape spawnRunner produces. */
function writeConfig(configPath: string, steps: Array<Record<string, unknown>>): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      id: `n1-admission-${randomUUID()}`,
      steps,
      resultPath: `${configPath}.result`,
      cwd: path.dirname(configPath),
      placeholder: '{previous}',
      asyncDir: path.dirname(configPath),
    }),
    { mode: 0o600 },
  );
}

describe('external-cli admission: the kind scan sees every serialized step shape', () => {
  it('admits configs without steps, pi runners and external-job runners (the knife stays on external-cli)', () => {
    expect(findExternalCliRunnerStep({})).toBeUndefined();
    expect(findExternalCliRunnerStep({ steps: 'not-an-array' })).toBeUndefined();
    expect(findExternalCliRunnerStep({ steps: [{ agent: 'general', task: 't', runner: { type: 'pi' } }] })).toBeUndefined();
    expect(
      findExternalCliRunnerStep({ steps: [{ agent: 'job', task: 't', runner: { type: 'external-job', provider: 'p' } }] }),
    ).toBeUndefined();
  });

  it('finds a bare sequential external-cli step', () => {
    expect(
      findExternalCliRunnerStep({ steps: [{ agent: 'probe', task: 't', runner: { type: 'external-cli', command: 'x' } }] }),
    ).toEqual({ location: 'steps[0]' });
  });

  it('finds external-cli steps nested in parallel arrays and dynamic parallel groups', () => {
    expect(
      findExternalCliRunnerStep({
        steps: [
          { agent: 'general', task: 't' },
          {
            parallel: [
              { agent: 'general', task: 't' },
              { agent: 'probe', task: 't', runner: { type: 'external-cli', command: 'x', adapter: 'codex-exec' } },
            ],
          },
        ],
      }),
    ).toEqual({ location: 'steps[1].parallel[1]', adapter: 'codex-exec' });
    expect(
      findExternalCliRunnerStep({
        steps: [
          {
            expand: { maxItems: 2 },
            parallel: { agent: 'probe', task: 't', runner: { type: 'external-cli', command: 'x' } },
            collect: { as: 'out' },
          },
        ],
      }),
    ).toEqual({ location: 'steps[0].parallel' });
  });

  it('reads a config file into a typed refusal verdict (admitting, finding, invalid JSON, unreadable)', async () => {
    const harness = await makeBudgetHarness('scan-verdict');
    try {
      const clean = path.join(harness.workspace, 'clean.json');
      writeFileSync(clean, JSON.stringify({ steps: [{ agent: 'general', task: 't' }] }), { mode: 0o600 });
      expect(externalCliAdmissionRefusal(clean)).toBeUndefined();
      const external = path.join(harness.workspace, 'external.json');
      writeFileSync(external, JSON.stringify({ steps: [{ agent: 'p', task: 't', runner: { type: 'external-cli', command: 'x' } }] }), { mode: 0o600 });
      expect(externalCliAdmissionRefusal(external)).toContain(EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX);
      const invalid = path.join(harness.workspace, 'invalid.json');
      writeFileSync(invalid, '{ not json', { mode: 0o600 });
      expect(externalCliAdmissionRefusal(invalid)).toContain('not valid JSON at external-cli admission');
      expect(externalCliAdmissionRefusal(path.join(harness.workspace, 'missing.json'))).toContain('unreadable at external-cli admission');
    } finally {
      harness.dispose();
    }
  });
});

interface AdapterCase {
  label: string;
  runner: Record<string, unknown>;
  location: string;
  adapter?: string;
}

const ADAPTER_CASES: AdapterCase[] = [
  { label: 'a bare external-cli runner', runner: { type: 'external-cli', command: '/nonexistent-external-cli-probe' }, location: 'steps[0]' },
  { label: 'a codex-exec adapter runner', runner: { type: 'external-cli', adapter: 'codex-exec', command: 'codex' }, location: 'steps[0]', adapter: 'codex-exec' },
  { label: 'a claude-code adapter runner', runner: { type: 'external-cli', adapter: 'claude-code', command: 'claude' }, location: 'steps[0]', adapter: 'claude-code' },
  { label: 'a cursor-agent adapter runner', runner: { type: 'external-cli', adapter: 'cursor-agent', command: 'cursor-agent' }, location: 'steps[0]', adapter: 'cursor-agent' },
  { label: 'a writer-variant adapter runner', runner: { type: 'external-cli', adapter: 'claude-code-writer', command: 'claude' }, location: 'steps[0]', adapter: 'claude-code-writer' },
];

describe('external-cli admission: dispatcher admission refuses typed, fail-closed', () => {
  for (const adapterCase of ADAPTER_CASES) {
    it(`refuses a runner config whose step declares ${adapterCase.label}`, async () => {
      const harness = await makeBudgetHarness('dispatch-direct');
      try {
        const configPath = path.join(harness.workspace, 'runner-config.json');
        writeConfig(configPath, [stepWithRunner(adapterCase.runner)]);
        const outcome = outcomeOf(() =>
          dispatchCustodyPiSubagentSpawn({ child: 'pi-subagent-runner', cwd: harness.workspace, runnerConfigPath: configPath }),
        );
        expect(outcome.refused, `expected a typed refusal, got: ${outcome.message}`).toBe(true);
        expect(outcome.errorName).toBe('CustodyDispatchRefusalError');
        expect(outcome.message).toContain(EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX);
        expect(outcome.message).toContain(`declares runner.type 'external-cli' at ${adapterCase.location}`);
        if (adapterCase.adapter !== undefined) expect(outcome.message).toContain(`adapter '${adapterCase.adapter}'`);
        // Fail-closed: 未准入 — the refusal mints no record, ledger or cap state.
        expect(custodyState(harness.budget.directory)).toEqual([]);
      } finally {
        harness.dispose();
      }
    });
  }

  it('refuses an external-cli step hidden in a parallel group (no second path through nesting)', async () => {
    const harness = await makeBudgetHarness('dispatch-parallel');
    try {
      const configPath = path.join(harness.workspace, 'runner-config.json');
      writeConfig(configPath, [
        { agent: 'general', task: 'first' },
        {
          parallel: [
            { agent: 'general', task: 'left' },
            { agent: 'probe', task: 'right', runner: { type: 'external-cli', adapter: 'cursor-agent', command: 'cursor-agent' } },
          ],
        },
      ]);
      const outcome = outcomeOf(() =>
        dispatchCustodyPiSubagentSpawn({ child: 'pi-subagent-runner', cwd: harness.workspace, runnerConfigPath: configPath }),
      );
      expect(outcome.refused).toBe(true);
      expect(outcome.errorName).toBe('CustodyDispatchRefusalError');
      expect(outcome.message).toContain("declares runner.type 'external-cli' at steps[1].parallel[1]");
      expect(custodyState(harness.budget.directory)).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('refuses an external-cli step hidden in a dynamic parallel group', async () => {
    const harness = await makeBudgetHarness('dispatch-dynamic');
    try {
      const configPath = path.join(harness.workspace, 'runner-config.json');
      writeConfig(configPath, [
        {
          expand: { maxItems: 2 },
          parallel: { agent: 'probe', task: 'fan out', runner: { type: 'external-cli', command: '/nonexistent-external-cli-probe' } },
          collect: { as: 'out' },
        },
      ]);
      const outcome = outcomeOf(() =>
        dispatchCustodyPiSubagentSpawn({ child: 'pi-subagent-runner', cwd: harness.workspace, runnerConfigPath: configPath }),
      );
      expect(outcome.refused).toBe(true);
      expect(outcome.errorName).toBe('CustodyDispatchRefusalError');
      expect(outcome.message).toContain("declares runner.type 'external-cli' at steps[0].parallel");
      expect(custodyState(harness.budget.directory)).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('refuses an unreadable or unparseable runner config instead of admitting it (no fallback lane)', async () => {
    const harness = await makeBudgetHarness('dispatch-malformed');
    try {
      const missing = outcomeOf(() =>
        dispatchCustodyPiSubagentSpawn({
          child: 'pi-subagent-runner',
          cwd: harness.workspace,
          runnerConfigPath: path.join(harness.workspace, 'missing.json'),
        }),
      );
      expect(missing.refused).toBe(true);
      expect(missing.errorName).toBe('CustodyDispatchRefusalError');
      expect(missing.message).toContain('unreadable at external-cli admission');
      const invalidPath = path.join(harness.workspace, 'invalid.json');
      writeFileSync(invalidPath, '{ not json', { mode: 0o600 });
      const invalid = outcomeOf(() =>
        dispatchCustodyPiSubagentSpawn({ child: 'pi-subagent-runner', cwd: harness.workspace, runnerConfigPath: invalidPath }),
      );
      expect(invalid.refused).toBe(true);
      expect(invalid.message).toContain('not valid JSON at external-cli admission');
      expect(custodyState(harness.budget.directory)).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it('still admits a clean runner config (the runner lane itself is untouched)', async () => {
    const harness = await makeBudgetHarness('dispatch-clean');
    try {
      const configPath = path.join(harness.workspace, 'runner-config.json');
      writeConfig(configPath, [{ agent: 'general', task: 'clean probe' }]);
      const dispatch = dispatchCustodyPiSubagentSpawn({ child: 'pi-subagent-runner', cwd: harness.workspace, runnerConfigPath: configPath });
      expect(dispatch.args.join(' ')).toContain('__byok_sdk_helper pi-subagent-runner');
      expect(dispatch.env[BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV]).toBe(configPath);
    } finally {
      harness.dispose();
    }
  });
});

describe('external-cli admission: the vendored background lane surfaces the typed refusal', () => {
  it(
    'executeAsyncSingle with an external-cli agent refuses at dispatch and reports the typed reason',
    async () => {
      const harness = await makeBudgetHarness('vendored-async');
      try {
        const asyncExecution = await vendoredImport<{
          executeAsyncSingle: (id: string, params: Record<string, unknown>) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>;
        }>('vendor/pi-subagents/0.60.0/src/runs/background/async-execution.ts');
        const result = await asyncExecution.executeAsyncSingle(`n1-admission-${randomUUID()}`, {
          agent: 'external-probe',
          task: 'Run the external probe.',
          agentConfig: {
            name: 'external-probe',
            description: 'external-cli admission probe agent',
            systemPromptMode: 'append',
            inheritProjectContext: false,
            inheritGlobalContext: false,
            inheritSkills: false,
            systemPrompt: 'You are an admission probe.',
            source: 'project',
            filePath: path.join(clientRoot, 'src/__tests__/fixtures/custody-external-cli-payload-probe.ts'),
            runner: { type: 'external-cli', command: '/nonexistent-external-cli-probe' },
          },
          ctx: { pi: { events: { emit() {}, on() {} } }, cwd: harness.workspace, currentSessionId: 'n1-admission-session', interactive: false },
          cwd: harness.workspace,
          artifactsDir: path.join(harness.workspace, 'artifacts'),
          artifactConfig: {},
          shareEnabled: false,
          sessionRoot: harness.sessionsDir,
          sessionDir: harness.sessionsDir,
          maxSubagentDepth: 3,
          runFanoutBudget: harness.budget,
        });
        expect(result.isError, `expected the vendored async start to refuse: ${JSON.stringify(result.content)}`).toBe(true);
        const text = result.content?.map((part) => part.text ?? '').join('\n') ?? '';
        expect(text).toContain(EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX);
        expect(text).toContain("runner.type 'external-cli'");
        // The refusal happened at admission: no runner child was minted.
        expect(custodyState(harness.budget.directory)).toEqual([]);
      } finally {
        harness.dispose();
      }
    },
    30_000,
  );
});

describe('external-cli admission: the runner payload refuses before the vendored closure loads', () => {
  it(
    'exits nonzero with the typed reason when the transported config declares external-cli',
    async () => {
      const harness = await makeBudgetHarness('payload-gate');
      try {
        const configPath = path.join(harness.workspace, 'runner-config.json');
        writeConfig(configPath, [stepWithRunner({ type: 'external-cli', adapter: 'codex-exec', command: 'codex' })]);
        const bunExecutable = path.basename(process.execPath) === 'bun' ? process.execPath : 'bun';
        const run = spawnSync(
          bunExecutable,
          [path.join(clientRoot, 'src/__tests__/fixtures/custody-external-cli-payload-probe.ts')],
          {
            encoding: 'utf8',
            timeout: 60_000,
            cwd: clientRoot,
            env: { ...process.env, [BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV]: configPath },
          },
        );
        expect(run.status, `payload probe stderr: ${run.stderr}`).not.toBe(0);
        expect(run.stderr).toContain(EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX);
        expect(run.stderr).toContain('pi-subagent-runner payload:');
      } finally {
        harness.dispose();
      }
    },
    90_000,
  );
});

// ---------------------------------------------------------------------------
// Harness: the same custody environment shape the five-edge driver forges,
// in-process. The dispatcher reads process.env at call time, so every test
// saves, overrides and restores the custody keys around its dispatches.
// ---------------------------------------------------------------------------

const CUSTODY_ENV_KEYS = [
  RUN_FANOUT_BUDGET_ENV,
  'PI_SUBAGENT_MAX_DEPTH',
  'PI_CODING_AGENT_SESSION_DIR',
  BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV,
  BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV,
  BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV,
];

async function makeBudgetHarness(label: string): Promise<BudgetHarness> {
  const bridge = await vendoredImport<{
    createRunFanoutBudget: (rootRunId: string, limit: number) => Budget;
    encodeRunFanoutBudgetDescriptor: (descriptor: Budget) => string;
  }>('src/custody/custody-vendor-bridge.js');
  const saved = new Map(CUSTODY_ENV_KEYS.map((key) => [key, process.env[key]]));
  const budget = bridge.createRunFanoutBudget(`n1-admission-${label}-${randomUUID()}`, 8);
  process.env[RUN_FANOUT_BUDGET_ENV] = bridge.encodeRunFanoutBudgetDescriptor(budget);
  process.env.PI_SUBAGENT_MAX_DEPTH = '3';
  const sessionsDir = path.join(os.tmpdir(), `n1-admission-${label}-sessions-${randomUUID()}`);
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  delete process.env[BYOK_SDK_CUSTODY_PARENT_DEPTH_ENV];
  delete process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV];
  delete process.env[BYOK_SDK_CUSTODY_RUNNER_CONFIG_ENV];
  const workspace = mkdtempSync(path.join(os.tmpdir(), `n1-admission-${label}-`));
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
      rmSync(sessionsDir, { recursive: true, force: true });
    },
  };
}
