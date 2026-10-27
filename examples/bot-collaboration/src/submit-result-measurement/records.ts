// Evidence records of docs/submit-result-measurement.md "Evidence format and
// reporting", and the redaction applied before any file is written.
import type { OfferAdmissionTimings } from '@byok-sdk/protocol';
import type { CallPredicate, Category, Submission, ToolLabel } from './evidence';

export interface TrialTerminal {
  readonly status: 'task.complete' | 'task.fail' | 'task.cancelled';
  readonly at: string;
  /** The raw SDK reason string, without change. `null` for `task.complete`. */
  readonly reason: string | null;
  /** The wire terminal has no error code; always `null` on this SDK revision. */
  readonly errorCode: null;
  readonly outcomeDigest: string | null;
  /** True when the terminal arrived after the preregistered deadline (after the runner cancelled the task). */
  readonly afterDeadline: boolean;
}

export interface TrialRecord {
  readonly runId: string;
  readonly cellId: string;
  readonly trialId: string;
  readonly caseId: string;
  readonly round: number;
  readonly retryOf: string | null;
  readonly taskId: string;
  readonly offeredAt: string;
  readonly claimedAt: string | null;
  /** The device's admission timings as the claim carried them (#1014). */
  readonly admission: OfferAdmissionTimings | null;
  /** Actual runtime start (`task.started`), else the claim time. */
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly elapsedMs: number | null;
  readonly deadlineMs: number;
  readonly submissions: readonly Submission[];
  readonly submissionSeen: boolean;
  readonly terminal: TrialTerminal | null;
  readonly category: Category;
  readonly cause: string | null;
  readonly exactTarget: boolean | null;
  readonly firstCallValid: boolean | null;
  readonly replyDelivery: 'not_configured' | 'sent' | 'withdrawn' | 'not_applicable' | null;
  readonly replyDisposition: 'accepted' | 'held' | 'refused' | null;
  readonly usage: readonly Record<string, unknown>[] | null;
  readonly evidenceRef: string;
}

export interface NotStartedRow {
  readonly runId: string;
  readonly cellId: string;
  readonly trialId: string;
  readonly caseId: string;
  readonly round: number;
  readonly taskId: string;
  readonly stage: 'submit' | 'decline' | 'unclaimed' | 'terminal_before_claim';
  readonly reason: string | null;
  readonly code: string | null;
  /** The decline's admission timings (#1014); `null` at every other stage. */
  readonly admission: OfferAdmissionTimings | null;
  readonly at: string;
}

export interface PlannedTrial { readonly trialId: string; readonly caseId: string; readonly round: number; readonly counted: boolean }

export interface CalibrationResult {
  readonly trialId: string;
  readonly caseId: string;
  readonly label: ToolLabel | null;
  readonly category: Category | 'not_started';
}

export interface RunManifest {
  readonly schema: 'byok.submit-result-measurement.manifest.v1';
  readonly runId: string;
  readonly cellId: string;
  readonly mode: 'dry-run' | 'execute' | 'synthetic';
  /** Synthetic runs validate plumbing only. They never measure model behavior. */
  readonly synthetic: boolean;
  readonly authorization: string | null;
  readonly cell: Readonly<Record<string, unknown>>;
  readonly corpus: {
    readonly revision: string;
    readonly preflight: { readonly ok: boolean; readonly failures: readonly unknown[] };
    readonly cases: readonly { readonly id: string; readonly hashes: unknown; readonly bytes: unknown; readonly targetDigest: string }[];
  };
  readonly plan: {
    readonly rounds: number;
    readonly order: readonly string[];
    readonly plannedTrials: number;
    readonly calibrationTrials: number;
    /** Runtime tasks the run may start: calibration plus counted trials, capped by `maxTrials`. */
    readonly runtimeTasks: number;
  };
  readonly deadlineMs: number;
  readonly budget: { readonly maxTrials: number; readonly maxSpend: string | null };
  readonly capacityReasons: readonly string[];
  readonly predicate: CallPredicate;
  readonly calibration: CalibrationResult | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly completion: 'planned' | 'complete' | 'incomplete' | 'void';
  readonly startedTrials: number;
  readonly notStartedTrials: number;
}

/**
 * Replace local paths with placeholders in every string of a value. The
 * runner never reads a credential, so no key can reach a record; this keeps
 * home and run-root paths out of shareable files.
 */
export function redact<T>(value: T, replacements: readonly (readonly [string, string])[]): T {
  const active = replacements.filter(([from]) => from.length > 1).sort((a, b) => b[0].length - a[0].length);
  const variants = active.flatMap(([from, to]) => {
    const forms = new Set([from, from.replaceAll('\\', '/'), from.replaceAll('\\', '\\\\'), JSON.stringify(from).slice(1, -1)]);
    return [...forms].map(form => [form, to] as const);
  });
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return variants.reduce((text, [from, to]) => text.split(from).join(to), input);
    if (Array.isArray(input)) return input.map(walk);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, walk(item)]));
    return input;
  };
  return walk(value) as T;
}
