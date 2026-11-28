// BYOK change: Use the caller's bounded POSIX process-table reader with the isolated app-server's PID (Apache-2.0).
/* oxlint-disable import/max-dependencies -- This guard composes control plans, process-table reads and the record stream. */
import type { SessionCleanup } from "../../contracts/placement.js";
import type { RequestRecord } from "../../contracts/session.js";
import { processTableFailure, type ProcessTable, type ProcessTableObservation, type SignalReport } from "../../shared/executable/process-tree.js";
import { endTurnEntries, turnEntries, type ProcessTableReading } from "../../shared/executable/process-turn-scope.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { RpcControlPlan } from "./rpc-control.js";

/*
 * SessionOptions.endTurnProcessesOnAbort. Native turn/interrupt can leave the
 * running command and a detached child alive, and the native terminal APIs
 * neither reach a detached child nor spare earlier work, so OAR compares two
 * process-table reads: one started before turn/start, one before turn/interrupt.
 * Semantics and record shape: docs/runtimes/codex.md, docs/spec/record-stream.md.
 *
 * All state belongs to one turn, by native turn id once known. A record of the
 * old turn's end is published before this module hears of it, and an observer
 * can prompt from there: nothing an old turn does may reach a newer one.
 */

/** The isolated process and the host's bounded /bin/ps reader. */
export interface CodexProcessReader {
  rootPid(): number | undefined;
  readProcessTable(): ProcessTable;
}

/** The turn one `prompt` asked for: `turnId` is null until its turn/start reply names it. */
interface PromptedTurn { readonly baseline: ProcessTableObservation; turnId: string | null }

/** What one turn's abort knows at the moment the interrupt may be sent. */
interface AbortEvidence {
  readonly turnId: string;
  readonly snapshot: ProcessTableObservation;
  readonly baseline: ProcessTableObservation | null;
  /** Abort requests whose interrupt was sent and not refused. */
  readonly requests: Set<string>;
}

/** The observation one turn's aborts share. */
interface AbortAttempt {
  readonly observing: AbortEvidence;
  ended: boolean;
  /** Set once an interrupt was sent on this evidence. */
  sent: AbortEvidence | null;
}

interface Readings { readonly root: number; readonly baseline: ProcessTable; readonly snapshot: ProcessTableReading }

export interface CodexTurnProcesses {
  /** Read the baseline when a prompt is admitted, before writing turn/start. */
  prompting<Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan): (...args: Args) => RpcControlPlan;
  /** Take the snapshot before the interrupt is sent; a refusal ends this attempt's claim. */
  aborting(plan: () => RpcControlPlan): () => RpcControlPlan;
  /** A root turn/completed, after its frame is recorded. Touches that turn's state only. */
  turnCompleted(params: JsonRecord): void;
  /** The app-server exited, before its `exited` response is recorded. */
  exited(): void;
}

const passive: CodexTurnProcesses = {
  prompting: (plan) => plan,
  aborting: (plan) => plan,
  turnCompleted() {},
  exited() {},
};

function readFailure(what: string, result: Exclude<ProcessTableObservation, { readonly ok: true }>): string {
  return `${what} process table read failed: ${result.reason}`;
}

/** The two usable reads, or why there are not two: nothing is ended without both. */
function usableReadings(evidence: AbortEvidence, root: number | undefined): Readings | string {
  const { baseline, snapshot } = evidence;
  if (baseline === null) { return "no baseline: OAR did not start this turn with a prompt"; }
  if (!baseline.ok) { return readFailure("the baseline", baseline); }
  if (!snapshot.ok) { return readFailure("the pre-interrupt snapshot", snapshot); }
  if (root === undefined) { return "the app-server has no process id"; }
  const held = baseline.table.get(root);
  if (held === undefined || snapshot.table.get(root)?.start !== held.start) { return "the app-server is not the same process in both reads"; }
  return { root, baseline: baseline.table, snapshot };
}

/** What a round of signals amounts to: a signal that was not sent is never reported as sent. */
function cleanupOf(report: SignalReport): SessionCleanup {
  if (!report.hostIdentified) { return { kind: "failed", reason: "the host is not in the revalidating process table, so nothing was signalled" }; }
  // Processes OAR may not signal (another user's) are named, never folded into "all were signalled".
  const foreign = report.foreign === 0 ? {} : { foreign: report.foreign };
  if (report.failed === 0) { return { kind: "completed", signalled: report.signalled, ...foreign }; }
  const reason = `${String(report.failed)} of ${String(report.failed + report.signalled)} processes could not be signalled: ${report.codes.join(", ")}`;
  return { kind: "failed", reason, ...(report.signalled === 0 ? {} : { signalled: report.signalled }), ...foreign };
}

/** End an attempt and return its evidence, if an interrupt stands. */
function closeAttempt(attempt: AbortAttempt): { readonly evidence: AbortEvidence; readonly requestId: string } | null {
  attempt.ended = true;
  const evidence = attempt.sent;
  attempt.sent = null;
  if (evidence === null) { return null; }
  const [requestId] = evidence.requests;
  return requestId === undefined ? null : { evidence, requestId };
}

export function codexTurnProcesses(kernel: SessionKernel, reader?: CodexProcessReader): CodexTurnProcesses {
  // BYOK change: the session always owns an isolated app-server. Windows has no per-turn process groups.
  if (reader === undefined || process.platform === "win32") { return passive; }
  let prompted: PromptedTurn | null = null;
  const attempts = new Map<string, AbortAttempt>();

  const read = (): ProcessTableObservation => {
    const start = performance.now();
    try { return { ok: true, source: "ps", table: reader.readProcessTable(), elapsedMs: performance.now() - start, skipped: 0 }; }
    catch (error) { return processTableFailure(error, "ps", performance.now() - start); }
  };
  const observe = (turnId: string): AbortEvidence => ({
    turnId, snapshot: read(), requests: new Set(),
    baseline: prompted !== null && (prompted.turnId === null || prompted.turnId === turnId) ? prompted.baseline : null,
  });
  const record = (requestId: string, result: SessionCleanup): void => { kernel.respond(requestId, { kind: "cleanup", result }); };
  const decide = (requestId: string, evidence: AbortEvidence, turn: JsonRecord | null): void => {
    if (turn?.id !== evidence.turnId || turn.status !== "interrupted") {
      record(requestId, { kind: "failed", reason: `the turn ended with status ${String(turn?.status)}, not by this interrupt` });
      return;
    }
    const readings = usableReadings(evidence, reader.rootPid());
    if (typeof readings === "string") {
      record(requestId, { kind: "failed", reason: readings });
      return;
    }
    const targets = turnEntries(readings.root, readings.baseline, readings.snapshot);
    if (targets.length === 0) {
      record(requestId, { kind: "completed", signalled: 0 });
      return;
    }
    const fresh = read();
    record(requestId, fresh.ok ? cleanupOf(endTurnEntries(readings.root, targets, readings.baseline, fresh)) : { kind: "failed", reason: readFailure("the revalidating", fresh) });
  };

  return {
    prompting: (plan) => (...args) => {
      const base = plan(...args);
      let own: PromptedTurn | null = null;
      const withdraw = (): void => { if (prompted === own) { prompted = null; } };
      return {
        ...base,
        gate: (request) => {
          const refused = base.gate(request);
          if (refused === null) { own = { baseline: read(), turnId: null }; prompted = own; }
          return refused;
        },
        onReply: (reply) => {
          const body = base.onReply(reply);
          const turnId = asRecord(reply.turn)?.id;
          if (body.kind === "rejected" || typeof turnId !== "string") { withdraw(); }
          else if (own !== null) { own.turnId = turnId; }
          return body;
        },
        onError: (message, native) => {
          withdraw();
          return base.onError(message, native);
        },
      };
    },
    aborting: (plan) => () => {
      const base = plan();
      let issued: RequestRecord | null = null;
      let joined: AbortAttempt | null = null;
      return {
        ...base,
        gate: (request) => {
          issued = request;
          return base.gate(request);
        },
        prepare: async () => {
          const turnId = String(base.params().turnId);
          const attempt = attempts.get(turnId) ?? { observing: observe(turnId), ended: false, sent: null };
          attempts.set(turnId, attempt);
          joined = attempt;
          const evidence = attempt.observing;
          const unreachable = kernel.unreachable();
          if (unreachable !== null || attempt.ended || issued === null) {
            if (attempts.get(turnId) === attempt) { attempts.delete(turnId); }
            return unreachable ?? { kind: "rejected", code: "no_active_turn", reason: "turn ended before the interrupt was sent" };
          }
          evidence.requests.add(issued.id);
          attempt.sent = evidence;
          return null;
        },
        onError: (message, native) => {
          const evidence = joined?.sent;
          if (issued !== null && joined !== null && evidence?.requests.delete(issued.id) === true && evidence.requests.size === 0) {
            joined.sent = null;
            if (attempts.get(evidence.turnId) === joined) { attempts.delete(evidence.turnId); }
          }
          return base.onError(message, native);
        },
      };
    },
    turnCompleted(params) {
      const turn = asRecord(params.turn);
      const id = turn?.id;
      if (typeof id === "string" && prompted?.turnId === id) { prompted = null; }
      // A completion that names no turn cannot be matched, so it closes what is open and interrupts nothing.
      const named = typeof id === "string" ? attempts.get(id) : undefined;
      const closing = typeof id === "string" ? (named === undefined ? [] : [named]) : [...attempts.values()];
      if (typeof id === "string") { attempts.delete(id); } else { attempts.clear(); }
      for (const attempt of closing) {
        const closed = closeAttempt(attempt);
        if (closed !== null) { decide(closed.requestId, closed.evidence, turn); }
      }
    },
    exited() {
      prompted = null;
      const closing = [...attempts.values()];
      attempts.clear();
      for (const attempt of closing) {
        const closed = closeAttempt(attempt);
        if (closed !== null) { record(closed.requestId, { kind: "failed", reason: "the app-server exited before the aborted turn ended; its exit cleanup applies instead" }); }
      }
    },
  };
}
