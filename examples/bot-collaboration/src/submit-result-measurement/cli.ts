// Runner for the #610 measurement method (docs/submit-result-measurement.md).
//
//   bun run build
//   bun examples/bot-collaboration/src/submit-result-measurement/cli.ts --runtime codex --model <id>
//
// The default is a dry run: it prints the plan and the runtime task count and
// starts no daemon, no runtime and no provider call. A real run needs
// --execute plus an owner authorization reference, a deadline, a spend limit
// and an output directory. The runner never reads a credential: the runtime
// uses its own login or environment.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ClaudeAdapter, CodexAdapter, GrokAdapter, PiAdapter, type RuntimeAdapter } from '@byok-sdk/client';
import type { DispatchSelection } from '@byok-sdk/protocol';
import { CORPUS } from './corpus';
import { MEASURED_RUNTIMES, plannedManifest, runCell, type MeasuredRuntime } from './harness';
import type { RunManifest } from './records';


export interface CliDeps {
  /** Replace the runtime adapter. The run is then synthetic: it validates plumbing, not model behavior. */
  readonly adapters?: () => RuntimeAdapter[];
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly signal?: AbortSignal;
}

const USAGE = `Usage: cli.ts --runtime <pi|claude|codex|grok> --model <id> [options]

Options:
  --rounds <n>              Rounds of C01-C06 (default 20)
  --cases <ids>             Comma-separated case ids (default all six)
  --max-trials <n>          Stop after n counted trials (default rounds x cases)
  --capacity-reason <text>  Predeclared capacity reason prefix; repeatable (default context_overflow)
  --cell <key=value>        Operator-declared cell fact; repeatable (model settings, account tier, token limits)
  --run-id <id>             Lowercase letters, digits and dashes (default from the UTC time)
  --json                    Print the planned manifest as JSON
  --execute                 Start real runtime tasks. Requires the four options below
  --authorization <ref>     Owner approval reference for this paid run
  --deadline-ms <ms>        Preregistered task deadline
  --max-spend <label>       Preregistered maximum total spend
  --out <dir>               Output directory for the redacted dataset
`;

function selectionFor(runtime: MeasuredRuntime, model: string): DispatchSelection | undefined {
  // Claude and Codex take the model through the subscription lane. Grok takes it as
  // an adapter option. Pi BYOK needs a credential-custody launcher, so Pi uses the
  // model of its own configuration, and the cell records the operator label.
  return runtime === 'claude' || runtime === 'codex' ? { lane: 'subscription', runtimeId: runtime, providerId: null, modelId: model } : undefined;
}

function builtinAdapters(runtime: MeasuredRuntime, model: string): () => RuntimeAdapter[] {
  // Grok takes its model as an adapter option; the other runtimes use their default options.
  return () => [runtime === 'pi' ? new PiAdapter() : runtime === 'claude' ? new ClaudeAdapter() : runtime === 'codex' ? new CodexAdapter() : new GrokAdapter({ model })];
}

const positive = (name: string, value: string | undefined, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a positive integer`);
  return parsed;
};

class UsageError extends Error {}

function describePlan(manifest: RunManifest, model: string, selection: DispatchSelection | undefined): string {
  const roundBytes = CORPUS.filter(entry => manifest.plan.order.includes(entry.id)).reduce((sum, entry) => sum + entry.bytes.instruction, 0);
  return [
    `Cell: ${manifest.cellId}`,
    `Runtime: ${String(manifest.cell.runtime)}; model ${model} ${selection ? '(sent as the subscription dispatch selection)' : manifest.cell.runtime === 'grok' ? '(set as the Grok adapter model)' : '(from the Pi configuration; recorded as a label)'}`,
    `Corpus: ${manifest.corpus.revision}; preflight ${manifest.corpus.preflight.ok ? 'ok' : 'FAILED: the run is void'}`,
    `Plan: ${manifest.plan.calibrationTrials} uncounted calibration trial + ${manifest.plan.rounds} rounds x ${manifest.plan.order.length} cases = ${manifest.plan.plannedTrials} counted trials`,
    `Runtime tasks: ${manifest.plan.runtimeTasks} (max-trials ${manifest.budget.maxTrials}). Each task makes at least two model requests; token counts are unknown until measured.`,
    `Instruction bytes: ${roundBytes} per round, ${roundBytes * manifest.plan.rounds} in all counted rounds.`,
  ].join('\n');
}

/** Returns the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  try {
    const { values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: {
        runtime: { type: 'string' }, model: { type: 'string' }, rounds: { type: 'string' }, cases: { type: 'string' },
        'max-trials': { type: 'string' }, 'capacity-reason': { type: 'string', multiple: true }, cell: { type: 'string', multiple: true },
        'run-id': { type: 'string' }, json: { type: 'boolean' }, execute: { type: 'boolean' }, authorization: { type: 'string' },
        'deadline-ms': { type: 'string' }, 'max-spend': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
      },
    });
    if (values.help) { out(USAGE); return 0; }
    const runtime = values.runtime as MeasuredRuntime | undefined;
    if (!runtime || !MEASURED_RUNTIMES.includes(runtime)) throw new UsageError('--runtime must be one of pi, claude, codex, grok');
    const model = values.model;
    if (!model || /[\u0000-\u001f]/u.test(model)) throw new UsageError('--model is required');
    const caseIds = values.cases ? values.cases.split(',').map(id => id.trim()) : CORPUS.map(entry => entry.id);
    for (const id of caseIds) if (!CORPUS.some(entry => entry.id === id)) throw new UsageError(`unknown case ${id}`);
    const rounds = positive('rounds', values.rounds, 20);
    const maxTrials = positive('max-trials', values['max-trials'], rounds * caseIds.length);
    const runId = values['run-id'] ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(runId) || runId.length > 64) throw new UsageError('--run-id must use lowercase letters, digits and single dashes');
    const cell: Record<string, string> = { model };
    for (const fact of values.cell ?? []) {
      const eq = fact.indexOf('=');
      if (eq < 1) throw new UsageError('--cell takes key=value');
      cell[fact.slice(0, eq)] = fact.slice(eq + 1);
    }
    const selection = selectionFor(runtime, model);
    const cellId = `${runtime}.${model}.${process.platform}-${process.arch}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const synthetic = deps.adapters !== undefined;
    const common = {
      runId, cellId, runtime, ...(selection ? { dispatchSelection: selection } : {}), rounds, caseIds, maxTrials,
      capacityReasons: values['capacity-reason'] ?? ['context_overflow'], calibrate: true, cell,
      authorization: values.authorization ?? null, maxSpend: values['max-spend'] ?? null,
    };
    if (!values.execute) {
      const manifest = plannedManifest({ ...common, mode: 'dry-run', deadlineMs: positive('deadline-ms', values['deadline-ms'], 600_000) });
      out('DRY RUN: no daemon, no runtime and no provider call.');
      out(describePlan(manifest, model, selection));
      out('A real run needs --execute --authorization <ref> --deadline-ms <ms> --max-spend <label> --out <dir>.');
      if (values.json) out(JSON.stringify(manifest, null, 2));
      return 0;
    }
    const missing = (['authorization', 'deadline-ms', 'max-spend', 'out'] as const).filter(name => !values[name]);
    if (missing.length > 0) throw new UsageError(`--execute requires ${missing.map(name => `--${name}`).join(', ')}`);
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'byok-m610-'));
    try {
      const result = await runCell({
        ...common, mode: synthetic ? 'synthetic' : 'execute', deadlineMs: positive('deadline-ms', values['deadline-ms']),
        adapters: deps.adapters ?? builtinAdapters(runtime, model), outDir: path.resolve(values.out!), workRoot,
        ...(deps.signal ? { signal: deps.signal } : {}), log: out,
      });
      out(`Wrote ${result.files.length} files to ${path.resolve(values.out!)}; completion ${result.manifest.completion}; started ${result.manifest.startedTrials}, not started ${result.manifest.notStartedTrials}.`);
      return result.manifest.completion === 'void' ? 1 : 0;
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      err(`${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
}
