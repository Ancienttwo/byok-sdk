// Trial evidence and classification for docs/submit-result-measurement.md
// "Classify every trial". Pure functions: no I/O, no clock.
import { validateResultOutcome } from '@byok-sdk/protocol';
import type { CorpusCase } from './corpus';
import { resultDigest } from './digest';

export const CATEGORIES = ['infrastructure_abort', 'timeout', 'unobservable', 'valid', 'invalid', 'missing', 'terminal_failure'] as const;
export type Category = typeof CATEGORIES[number];

/** The label of a `submit_result` call in `tool_use` (or a lone `tool_result`) events. */
export interface ToolLabel { readonly tool: string; readonly mcp?: { readonly server: string; readonly tool: string } }

/**
 * The call predicate of one cell. Only a calibration trial confirms it
 * (`confirmed: true`). Without a confirmed predicate the harness cannot show
 * that no call happened, so it never records `missing`.
 */
export interface CallPredicate {
  readonly confirmed: boolean;
  readonly label: ToolLabel | null;
  readonly source: string;
}

export const UNCONFIRMED_PREDICATE: CallPredicate = Object.freeze({ confirmed: false, label: null, source: 'none' });

/** One AgentEvent with the UTC time the harness observed it. */
export interface ObservedEvent { readonly at: string; readonly event: Record<string, unknown> }

export interface StagedRecord {
  readonly outcome: unknown;
  readonly contentHash: string;
  readonly byteCount: number;
  readonly receiptId: string;
  readonly createdAt: string;
}

export interface TerminalObservation {
  readonly status: 'task.complete' | 'task.fail' | 'task.cancelled';
  readonly at: string;
  readonly reason: string | null;
  readonly hasDocument: boolean;
  readonly document?: unknown;
}

export interface TrialObservation {
  readonly events: readonly ObservedEvent[];
  readonly terminal: TerminalObservation | null;
  /** `null` when no record exists; `'unreadable'` when a file exists but does not parse as a record. */
  readonly staged: StagedRecord | null | 'unreadable';
  readonly deadlineExpired: boolean;
  /** A harness-observed failure (Host, transport or daemon). Never inferred from silence. */
  readonly infrastructure: { readonly stage: string; readonly code: string } | null;
  readonly operatorCancelled: boolean;
}

export type SubmissionValidation = 'staged' | 'rejected' | 'error' | 'unknown';

export interface Submission {
  readonly index: number;
  readonly at: string;
  readonly toolCallId: string | null;
  readonly label: ToolLabel;
  readonly validation: SubmissionValidation;
  readonly reason: string | null;
  readonly byteCount: number | null;
  readonly hash: string | null;
}

export interface Classification {
  readonly category: Category;
  readonly cause: string | null;
  readonly submissions: readonly Submission[];
  readonly exactTarget: boolean | null;
  readonly firstCallValid: boolean | null;
  readonly submissionSeen: boolean;
  readonly outcomeDigest: string | null;
}

type HelperBody =
  | { readonly kind: 'staged'; readonly receiptId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Source 2: the helper body, read from any JSON string nested in a runtime's `output` shape. */
export function findHelperBody(output: unknown, depth = 0): HelperBody | undefined {
  if (depth > 8 || output === null || output === undefined) return undefined;
  if (typeof output === 'string') {
    const text = output.trim();
    if (!text.startsWith('{')) return undefined;
    try { return findHelperBody(JSON.parse(text), depth + 1); } catch { return undefined; }
  }
  if (Array.isArray(output)) {
    for (const item of output) { const body = findHelperBody(item, depth + 1); if (body) return body; }
    return undefined;
  }
  if (typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  if (typeof record.receiptId === 'string' && record.state === 'staged') return { kind: 'staged', receiptId: record.receiptId };
  if (record.error === 'result_rejected') return { kind: 'rejected', reason: typeof record.reason === 'string' ? record.reason : 'result_rejected' };
  for (const value of Object.values(record)) { const body = findHelperBody(value, depth + 1); if (body) return body; }
  return undefined;
}

function labelOf(event: Record<string, unknown>): ToolLabel {
  const mcp = event.mcp as { server?: unknown; tool?: unknown } | undefined;
  return mcp && typeof mcp.server === 'string' && typeof mcp.tool === 'string'
    ? { tool: String(event.tool), mcp: { server: mcp.server, tool: mcp.tool } }
    : { tool: String(event.tool) };
}

export function sameLabel(left: ToolLabel, right: ToolLabel): boolean {
  return left.tool === right.tool && left.mcp?.server === right.mcp?.server && left.mcp?.tool === right.mcp?.tool;
}

/** The failed-call signals of the method doc table: `isError: true`, or a Codex `output.status` of `failed`. */
function failedSignal(event: Record<string, unknown>): boolean {
  if (event.isError === true) return true;
  const output = event.output as { status?: unknown } | undefined;
  return output !== null && typeof output === 'object' && output.status === 'failed';
}

/** The submitted document inside `tool_use.input`: MCP call wrappers carry it as `arguments`. */
function submittedDocument(input: unknown): unknown {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (Object.hasOwn(record, 'arguments') && typeof record.tool === 'string') return record.arguments;
  }
  return input;
}

interface ToolCall { at: string; toolCallId: string | null; use?: Record<string, unknown>; result?: Record<string, unknown> }

/** Source 1: pair `tool_use` and `tool_result` by `toolCallId`, never by tool name. */
function toolCalls(events: readonly ObservedEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const { at, event } of events) {
    if (event.type !== 'tool_use' && event.type !== 'tool_result') continue;
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
    let call = id === null ? undefined : byId.get(id);
    if (!call || (event.type === 'tool_use' && call.use) || (event.type === 'tool_result' && call.result)) {
      call = { at, toolCallId: id };
      calls.push(call);
      if (id !== null) byId.set(id, call);
    }
    if (event.type === 'tool_use') call.use = event; else call.result = event;
  }
  return calls;
}

/** Every observed `submit_result` call, in order: by helper body, or by the confirmed predicate. */
export function extractSubmissions(events: readonly ObservedEvent[], predicate: CallPredicate, staged: StagedRecord | null): Submission[] {
  const submissions: Submission[] = [];
  for (const call of toolCalls(events)) {
    const body = call.result && call.result.spill === undefined ? findHelperBody(call.result.output) : undefined;
    const label = labelOf(call.use ?? call.result!);
    const byLabel = predicate.confirmed && predicate.label !== null && sameLabel(predicate.label, label);
    if (!body && !byLabel) continue;
    const validation: SubmissionValidation = body?.kind === 'staged' ? 'staged' : body?.kind === 'rejected' ? 'rejected'
      : call.result && failedSignal(call.result) ? 'error' : 'unknown';
    let byteCount: number | null = null;
    let hash: string | null = null;
    if (body?.kind === 'staged' && staged && staged.receiptId === body.receiptId) {
      byteCount = staged.byteCount; hash = staged.contentHash;
    } else if (call.use && call.use.spill === undefined && Object.hasOwn(call.use, 'input')) {
      const document = submittedDocument(call.use.input);
      byteCount = Buffer.byteLength(JSON.stringify(document) ?? '', 'utf8');
      hash = resultDigest(document);
    }
    submissions.push({
      index: submissions.length, at: call.at, toolCallId: call.toolCallId, label, validation,
      reason: body?.kind === 'rejected' ? body.reason : null, byteCount, hash,
    });
  }
  return submissions;
}

/**
 * Calibration: the label of the call whose `tool_result` body is a staged
 * receipt or a `result_rejected` body, found through its `toolCallId`.
 */
export function calibrateLabel(events: readonly ObservedEvent[]): ToolLabel | null {
  for (const call of toolCalls(events)) {
    if (!call.result || call.result.spill !== undefined || !findHelperBody(call.result.output)) continue;
    return labelOf(call.use ?? call.result);
  }
  return null;
}

export interface ClassifyOptions {
  readonly corpusCase: CorpusCase;
  readonly predicate: CallPredicate;
  /** Predeclared capacity reason prefixes (the C06 rule). */
  readonly capacityReasons: readonly string[];
}

/** Assign exactly one primary category, in the order of the method doc. */
export function classifyTrial(observation: TrialObservation, options: ClassifyOptions): Classification {
  const staged = observation.staged === 'unreadable' ? null : observation.staged;
  const submissions = extractSubmissions(observation.events, options.predicate, staged);
  const terminal = observation.terminal;
  const document = terminal?.status === 'task.complete' && terminal.hasDocument ? terminal.document : undefined;
  const outcomeDigest = document === undefined ? null : resultDigest(document);
  const submissionSeen = submissions.length > 0 || staged !== null;
  const done = (category: Category, cause: string | null = null): Classification => {
    const exactTarget = category === 'valid' ? outcomeDigest === options.corpusCase.targetDigest : false;
    // First-call-valid needs a valid terminal and an SDK-valid first submission; an unseen first call is unknown.
    let firstCallValid: boolean | null = false;
    if (category === 'valid') {
      const first = submissions[0];
      firstCallValid = first === undefined || first.validation === 'unknown' ? null : first.validation === 'staged';
    }
    return { category, cause, submissions, exactTarget, firstCallValid, submissionSeen, outcomeDigest };
  };

  // The C06 rule comes before every other category.
  if (options.corpusCase.id === 'C06-large' && terminal && terminal.status !== 'task.complete' && terminal.reason !== null) {
    const reason = terminal.reason;
    if (options.capacityReasons.some(prefix => reason.startsWith(prefix))) return done('terminal_failure', reason);
  }
  if (observation.operatorCancelled) return done('infrastructure_abort', 'operator_cancelled');
  if (observation.infrastructure) return done('infrastructure_abort', `${observation.infrastructure.stage}:${observation.infrastructure.code}`);
  if (observation.deadlineExpired && terminal === null) return done('timeout');
  if (terminal === null || observation.staged === 'unreadable') return done('unobservable');
  if (terminal.status === 'task.complete') {
    if (document === undefined) return done('unobservable', 'complete_without_document');
    if (staged && staged.contentHash !== outcomeDigest) return done('unobservable', 'staged_record_differs_from_terminal');
    if (!validateResultOutcome(options.corpusCase.schema, document).ok) return done('unobservable', 'terminal_document_fails_schema');
    return done('valid');
  }
  if (submissions.some(submission => submission.validation === 'rejected') && staged === null) return done('invalid');
  // `missing` needs a turn that ended normally, complete tool evidence and no call.
  const turnEnded = observation.events.some(item => item.event.type === 'turn_end');
  if (submissions.length === 0 && staged === null && turnEnded) {
    return options.predicate.confirmed ? done('missing') : done('unobservable', 'no_confirmed_call_predicate');
  }
  return done('terminal_failure');
}
