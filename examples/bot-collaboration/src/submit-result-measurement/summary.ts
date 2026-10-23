// Counts, rates and 95% Wilson intervals of docs/submit-result-measurement.md
// "Evidence format and reporting". Pure functions.
import { CATEGORIES, type Category } from './evidence';
import type { TrialRecord } from './records';

export interface Rate {
  readonly successes: number;
  readonly n: number;
  /** `null` at n = 0 (N/A). */
  readonly rate: number | null;
  readonly wilson95: { readonly low: number; readonly high: number } | null;
}

const Z = 1.96;

export function wilson(successes: number, n: number): Rate {
  if (n === 0) return { successes, n, rate: null, wilson95: null };
  const p = successes / n;
  const denominator = 1 + Z * Z / n;
  const center = (p + Z * Z / (2 * n)) / denominator;
  const half = Z * Math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / denominator;
  return { successes, n, rate: p, wilson95: { low: Math.max(0, center - half), high: Math.min(1, center + half) } };
}

/** Nearest-rank percentile of completed latencies; `null` when none. */
function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

export interface GroupSummary {
  readonly planned: number;
  readonly started: number;
  readonly notStarted: number;
  readonly categories: Readonly<Record<Category, Rate>>;
  readonly valid: Rate;
  readonly exactTarget: Rate;
  readonly firstCallValid: Rate;
  /** First-call-valid observations that are unknown (`null`); they count as non-successes above. */
  readonly firstCallValidUnknown: number;
  /** Secondary rate: excludes only infrastructure_abort, timeout and unobservable. Never the headline. */
  readonly completedObservableValid: Rate & { readonly excluded: Readonly<Record<string, number>> };
  readonly reruns: number;
  readonly latencyMs: { readonly completed: number; readonly median: number | null; readonly p95: number | null; readonly censoredTimeouts: number };
}

const EXCLUDED: readonly Category[] = ['infrastructure_abort', 'timeout', 'unobservable'];

export function summarizeGroup(planned: number, trials: readonly TrialRecord[], notStarted: number): GroupSummary {
  const primary = trials.filter(trial => trial.retryOf === null);
  const started = primary.length;
  const count = (predicate: (trial: TrialRecord) => boolean) => primary.filter(predicate).length;
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, wilson(count(trial => trial.category === category), started)])) as Record<Category, Rate>;
  const observable = primary.filter(trial => !EXCLUDED.includes(trial.category));
  const completed = primary.filter(trial => trial.terminal !== null && trial.elapsedMs !== null).map(trial => trial.elapsedMs!);
  return {
    planned, started, notStarted, categories,
    valid: categories.valid,
    exactTarget: wilson(count(trial => trial.exactTarget === true), started),
    firstCallValid: wilson(count(trial => trial.firstCallValid === true), started),
    firstCallValidUnknown: count(trial => trial.category === 'valid' && trial.firstCallValid === null),
    completedObservableValid: {
      ...wilson(observable.filter(trial => trial.category === 'valid').length, observable.length),
      excluded: Object.fromEntries(EXCLUDED.map(category => [category, count(trial => trial.category === category)])),
    },
    reruns: trials.length - primary.length,
    latencyMs: { completed: completed.length, median: percentile(completed, 0.5), p95: percentile(completed, 0.95), censoredTimeouts: count(trial => trial.category === 'timeout') },
  };
}

export interface RunSummary {
  readonly runId: string;
  readonly cellId: string;
  readonly cell: GroupSummary;
  readonly byCase: Readonly<Record<string, GroupSummary>>;
}

export function summarizeRun(input: {
  runId: string; cellId: string; caseIds: readonly string[]; plannedPerCase: number;
  trials: readonly TrialRecord[]; notStarted: readonly { caseId: string }[];
}): RunSummary {
  const byCase = Object.fromEntries(input.caseIds.map(caseId => [caseId, summarizeGroup(
    input.plannedPerCase,
    input.trials.filter(trial => trial.caseId === caseId),
    input.notStarted.filter(row => row.caseId === caseId).length,
  )]));
  return {
    runId: input.runId, cellId: input.cellId,
    cell: summarizeGroup(input.plannedPerCase * input.caseIds.length, input.trials, input.notStarted.length),
    byCase,
  };
}

const pct = (rate: Rate) => rate.rate === null ? 'N/A'
  : `${rate.successes}/${rate.n} (${(rate.rate * 100).toFixed(1)}%, 95% CI ${(rate.wilson95!.low * 100).toFixed(1)}–${(rate.wilson95!.high * 100).toFixed(1)}%)`;
const ms = (value: number | null) => value === null ? 'N/A' : String(value);

/** A Markdown report of the counts. It states no product threshold and no conclusion. */
export function renderSummaryMarkdown(summary: RunSummary, header: readonly string[]): string {
  const row = (name: string, group: GroupSummary) => `| ${name} | ${group.planned} | ${group.started} | ${group.notStarted} | ${CATEGORIES.map(category => group.categories[category].successes).join(' | ')} | ${pct(group.valid)} | ${pct(group.exactTarget)} | ${pct(group.firstCallValid)} | ${group.reruns} | ${ms(group.latencyMs.median)} | ${ms(group.latencyMs.p95)} | ${group.latencyMs.censoredTimeouts} |`;
  const secondary = summary.cell.completedObservableValid;
  return [
    `# submit_result measurement: ${summary.cellId}`,
    '',
    ...header.map(line => `- ${line}`),
    '',
    'Denominator: all started trials. Rates are N/A when no trial started.',
    'Latency is for trials with a terminal. Timeouts are censored and are not completions.',
    '',
    `| Group | Planned | Started | Not started | ${CATEGORIES.join(' | ')} | valid | exact target | first call valid | Reruns | Median ms | p95 ms | Censored timeouts |`,
    `| --- | ${Array.from({ length: CATEGORIES.length + 12 }, () => '---').join(' | ')} |`,
    row('cell', summary.cell),
    ...Object.entries(summary.byCase).map(([caseId, group]) => row(caseId, group)),
    '',
    `Secondary completed-observable valid rate (not the headline): ${pct(secondary)}; excluded ${Object.entries(secondary.excluded).map(([name, value]) => `${name} ${value}`).join(', ')}.`,
    `First-call-valid unknown (valid trials with an unseen first call): ${summary.cell.firstCallValidUnknown}.`,
    '',
  ].join('\n');
}
