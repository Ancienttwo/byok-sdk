import { enqueue, hash, project, promoteOccurrence, taskId, type ApplicationRows, type HostLedger, type Intent, type LedgerState } from '@byok-sdk/server/execution-core';
import { stateOf, type Card, type CollaborationState, type Turn } from './model.js';
import type { Json } from './rules/turn.js';
import { intentFacts } from './delegation.js';
import { turnIntentRetired } from './compaction.js';
import { concludeRoutineTurn, routineOccurrence, type BotRoutine } from './routines.js';
import { dreamIntentIds } from './dream.js';
import { syncTurn, type SyncFacts, type SyncOptions } from './rules/sync.js';
import { autonomousIntentIds, userFirst } from './rules/priority.js';
import { cardCallDue, commitCommand, CONNECTOR_OUTCOME_UNKNOWN, refuseRetired, retiredIdentity, settleCardCall, type AdmittedIds, type Command,
  type CommandPorts } from './rules/commands.js';
import type { CommandRecord, CommitRequest, CommitResult } from './rules/commit.js';
import { botDeviceRefusal } from './topology.js';
import { retainRoots, type RetentionInput, type RetentionLimits, type RetentionResult } from './retention.js';
import { refuseExported, refuseImported } from './switch.js';

// The L store of the commit contract (#739 D1): one K4 ledger transaction holds the state change,
// the command record and the outbox rows. K4 deduplicates terminals and messages, so L records no callback.
// Retention (#798) moves settled rows into K4 application rows of the same transaction.
// A sync step (#793 D2b) writes in the transaction of the Host sync. It records no command and keeps the revision.
export { CommitConflict, revisionOf, type CommitRequest, type CommitResult, type Disposition, type OutboxIntent } from './rules/commit.js';
export type { Command, CommandPorts } from './rules/commands.js';

/**
 * One K8 write to an L ledger in one ledger transaction (#975). It refuses a ledger that holds an uncommitted switch import
 * before the work runs. It refuses while the domain is exported after the work, so a new command on a frozen or H-owned
 * device still gets its device refusal. A refusal the work raises first (a replayed command id, an id conflict,
 * `stale_revision`, `RetentionRefused`) also comes before the export's; each refusal rolls the transaction back.
 */
export function writeLedger<T>(ledger: Pick<HostLedger, 'transaction'>, apply: (state: LedgerState, rows: ApplicationRows) => T): T {
  return ledger.transaction((s, rows) => {
    refuseImported(stateOf(s.application));
    const result = apply(s, rows);
    refuseExported(stateOf(s.application));
    return result;
  });
}
/**
 * The scope of an L ledger is its tenant. `ports` gets the transaction state, so outbox writes join the commit.
 * Moved command records and tombstones come from K4 application rows of the same transaction (#798).
 */
export function commitInLedger(ledger: HostLedger, request: CommitRequest<Command>, ports: (s: LedgerState) => CommandPorts): CommitResult {
  return writeLedger(ledger, (s, rows) => commitInRows(stateOf(s.application), ledger.tenant, request, rows, ports(s)));
}
/**
 * One command in a K4 transaction of the ledger with tenant `scope`, which holds `rows`: an owner command, or a K4 outcome,
 * message or occurrence callback.
 */
export function commitInRows(state: CollaborationState, scope: string, request: CommitRequest<Command>, rows: ApplicationRows,
  ports: CommandPorts): CommitResult {
  let admitted: AdmittedIds | undefined;
  const result = commitCommand(state, request, { scope, recordCallbacks: false,
    archived: id => rows.get('commands', id) as CommandRecord | undefined, admitted: ids => { admitted = ids; } }, ports);
  refuseRetired(admitted, (namespace, id) => rows.isRetired(namespace, id));
  return result;
}
/** One retention call in one ledger transaction. K4 facts come from the same state. */
export function retainInLedger(ledger: HostLedger, input: RetentionInput, limits: RetentionLimits): RetentionResult {
  return writeLedger(ledger, (s, rows) => retainRoots(stateOf(s.application), input, limits, {
    hasIntent: turnId => !!s.intents[hash(turnId)],
    occurrenceOpen: turnId => { const occurrence = s.occurrences[routineOccurrence({ id: turnId })]; return !!occurrence && !occurrence.conclusion; },
  }, rows));
}
const wouldDoRowNeedsMigration = (row: { turnId?: string }): boolean => row.turnId === undefined;
export function wouldDoNeedsMigration(state: CollaborationState): boolean {
  return Object.values(state.wouldDo ?? {}).some(wouldDoRowNeedsMigration);
}
/** The result of `migrateWouldDo`: rows that got their `turnId`, and rows archived because no live Turn owns them. */
export interface WouldDoMigration { backfilled: number; archived: number }
/**
 * The one-shot migration of would-do rows written before #1756, which have no `turnId`. The operator runs it once before
 * the new code serves. Each Turn intent of K4 has the task id `taskId(turnId, generation)` for each of its generations, so
 * the row's task id names its Turn exactly. A row whose intent was compacted, or whose Turn left the state, has no live
 * owner: it moves to the `wouldDo` application rows, as retention would move it, and is counted.
 */
export function migrateWouldDo(ledger: HostLedger): WouldDoMigration {
  return writeLedger(ledger, (s, rows) => {
    const state = stateOf(s.application), owners = new Map<string, string>(), result: WouldDoMigration = { backfilled: 0, archived: 0 };
    for (const intent of Object.values(s.intents)) {
      if (!Object.hasOwn(state.turns, intent.key)) continue;
      for (let generation = 0; generation <= intent.generation; generation++) owners.set(taskId(intent.key, generation), intent.key);
    }
    for (const row of Object.values(state.wouldDo ?? {})) {
      if (!wouldDoRowNeedsMigration(row)) continue;
      const turnId = owners.get(row.taskId);
      if (turnId !== undefined) { row.turnId = turnId; result.backfilled++; continue; }
      // SAFETY: The persisted would-do row consists of JSON fields and can be stored as an application row.
      rows.put('wouldDo', row.id, row as unknown as Json);
      delete state.wouldDo![row.id];
      result.archived++;
    }
    return result;
  });
}
/**
 * The intents that user input goes ahead of (#1229): a Bot Turn whose source is a routine occurrence or another Bot's
 * request, and a dream (#1475). A self continuation, an answer result or a Bot reply keeps its FIFO position.
 */
function prioritiseUser(s: LedgerState, state: ReturnType<typeof stateOf>, user: Intent): void {
  // K4 keys an intent by `hash(turn.id)`, so the priority rule compares intent ids, not Turn ids.
  const autonomous = autonomousIntentIds(Object.values(state.turns), dreamIntentIds(state));
  const plan = userFirst(Object.values(s.intents), user.id, autonomous, s.sequence);
  if (!plan) return;
  for (const { id, sequence } of plan.assignments) s.intents[id]!.sequence = sequence;
  s.sequence = plan.sequence;
}
/**
 * One sync step of one Turn in the L ledger, inside the caller's transaction. The Host sync loop calls it for each Turn.
 * The K4 writes stay here: `enqueue`, `promoteOccurrence`, the intent cancel and the occurrence conclusion.
 * Returns true when the step queued work or concluded an occurrence, so that K4 drains again.
 */
export function syncTurnInLedger(ledger: HostLedger, s: LedgerState, rows: ApplicationRows, turn: Turn, options: SyncOptions<BotRoutine>): boolean {
  const facts: SyncFacts = {
    intent: intentFacts(s).intent,
    executionStarted: id => { const row = s.intents[hash(id)]; return !!row && !!s.executions[row.taskId]?.started; },
    retired: id => turnIntentRetired(ledger, s, turn, options.now) ? 'result_retired' : retiredIdentity('turn', id, (namespace, row) => rows.isRetired(namespace, row)) ? 'turn_retired' : undefined,
    // #957: a Turn whose Bot's device is frozen for a switch, or owned by H, is held and never frozen into an intent.
    deviceRefusal: botId => botDeviceRefusal(stateOf(s.application), botId),
  };
  refuseImported(stateOf(s.application));
  const step = syncTurn(stateOf(s.application), turn, facts, options, (key, value) => project(s, key, value));
  const more = applyStep();
  // The caller's transaction rolls the step back on an uncommitted import or an exported domain (#975).
  refuseExported(stateOf(s.application));
  return more;
  function applyStep(): boolean {
    switch (step?.kind) {
      case 'freeze': {
        const intent = enqueue(s, ledger.tenant, step.input);
        // #1229 item 1: a user-source intent goes ahead of the queued, never-submitted routine and bot_request intents
        // of the same Agent FIFO. Submitted work keeps its order and its taskId generation; the order lives in the ledger.
        if (step.input.source === 'user') prioritiseUser(s, stateOf(s.application), intent);
        return true;
      }
      case 'routine': promoteOccurrence(s, ledger.tenant, routineOccurrence(turn), step.execution); return true;
      case 'cancel': s.intents[hash(turn.id)]!.cancelReason = 'cancelled'; return false;
      // A concluded occurrence can make a staged version due, so the next pass drains K4 again.
      case 'ended': return turn.source === 'routine' && concludeRoutineTurn(s, turn);
      default: return false;
    }
  }
}
/**
 * L's card call step (#958): at most one connector call per card, as H. For each due card, one transaction claims the call
 * before it runs, and one transaction settles it and drops the claim. A claim that a later pass finds with no settle (a crash
 * or a failed settle after the call) ends the card with `CONNECTOR_OUTCOME_UNKNOWN`, with no second call.
 */
export async function callCardsInLedger(ledger: HostLedger, call: (card: Card) => Promise<unknown>): Promise<void> {
  for (const old of Object.values(stateOf(ledger.snapshot().application).cards)) {
    if (!cardCallDue(old)) continue;
    const claimed = writeLedger(ledger, s => {
      const state = stateOf(s.application), card = state.cards[old.id];
      if (!card || !cardCallDue(card)) return false;
      const calls = state.cardCalls ??= {};
      if (!calls[card.id]) return calls[card.id] = true;
      delete calls[card.id];
      settleCardCall(card, { error: new Error(CONNECTOR_OUTCOME_UNKNOWN) });
      return false;
    });
    if (!claimed) continue;
    let outcome: Parameters<typeof settleCardCall>[1];
    try { outcome = { result: await call(old) }; } catch (error) { outcome = { error }; }
    writeLedger(ledger, s => {
      const state = stateOf(s.application);
      delete state.cardCalls![old.id];
      settleCardCall(state.cards[old.id]!, outcome);
    });
  }
}
