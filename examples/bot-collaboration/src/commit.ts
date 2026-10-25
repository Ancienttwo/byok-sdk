import { enqueue, hash, project, promoteOccurrence, type ApplicationRows, type HostLedger, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf, type Card, type Turn } from './model';
import { intentFacts } from './delegation';
import { turnIntentRetired } from './compaction';
import { concludeRoutineTurn, routineOccurrence, type BotRoutine } from './routines';
import { syncTurn, type SyncFacts, type SyncOptions } from './rules/sync';
import { cardCallDue, commitCommand, CONNECTOR_OUTCOME_UNKNOWN, refuseRetired, retiredIdentity, settleCardCall, type AdmittedIds, type Command,
  type CommandPorts } from './rules/commands';
import type { CommandRecord, CommitRequest, CommitResult } from './rules/commit';
import { botDeviceRefusal } from './topology';
import { retainRoots, type RetentionInput, type RetentionLimits, type RetentionResult } from './retention';

// The L store of the commit contract (#739 D1): one K4 ledger transaction holds the state change,
// the command record and the outbox rows. K4 deduplicates terminals and messages, so L records no callback.
// Retention (#798) moves settled rows into K4 application rows of the same transaction.
// A sync step (#793 D2b) writes in the transaction of the Host sync. It records no command and keeps the revision.
export { CommitConflict, revisionOf, type CommitRequest, type CommitResult, type Disposition, type OutboxIntent } from './rules/commit';
export type { Command, CommandPorts } from './rules/commands';

/**
 * The scope of an L ledger is its tenant. `ports` gets the transaction state, so outbox writes join the commit.
 * Moved command records and tombstones come from K4 application rows of the same transaction (#798).
 */
export function commitInLedger(ledger: HostLedger, request: CommitRequest<Command>, ports: (s: LedgerState) => CommandPorts): CommitResult {
  return ledger.transaction((s, rows) => {
    let admitted: AdmittedIds | undefined;
    const result = commitCommand(stateOf(s.application), request, { scope: ledger.tenant, recordCallbacks: false,
      archived: id => rows.get('commands', id) as CommandRecord | undefined, admitted: ids => { admitted = ids; } }, ports(s));
    refuseRetired(admitted, (namespace, id) => rows.isRetired(namespace, id));
    return result;
  });
}
/** One retention call in one ledger transaction. K4 facts come from the same state. */
export function retainInLedger(ledger: HostLedger, input: RetentionInput, limits: RetentionLimits): RetentionResult {
  return ledger.transaction((s, rows) => retainRoots(stateOf(s.application), input, limits, {
    hasIntent: turnId => !!s.intents[hash(turnId)],
    occurrenceOpen: turnId => { const occurrence = s.occurrences[turnId.slice('occurrence:'.length)]; return !!occurrence && !occurrence.conclusion; },
  }, rows));
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
  const step = syncTurn(stateOf(s.application), turn, facts, options, (key, value) => project(s, key, value));
  switch (step?.kind) {
    case 'freeze': enqueue(s, ledger.tenant, step.input); return true;
    case 'routine': promoteOccurrence(s, ledger.tenant, routineOccurrence(turn), step.execution); return true;
    case 'cancel': s.intents[hash(turn.id)]!.cancelReason = 'cancelled'; return false;
    // A concluded occurrence can make a staged version due, so the next pass drains K4 again.
    case 'ended': return turn.source === 'routine' && concludeRoutineTurn(s, turn);
    default: return false;
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
    const claimed = ledger.transaction(s => {
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
    ledger.transaction(s => {
      const state = stateOf(s.application);
      delete state.cardCalls![old.id];
      settleCardCall(state.cards[old.id]!, outcome);
    });
  }
}
