import { hash, type HostLedger, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf } from './model';
import { commitCommand, refuseRetired, type AdmittedIds, type Command, type CommandPorts } from './rules/commands';
import type { CommandRecord, CommitRequest, CommitResult } from './rules/commit';
import { retainRoots, type RetentionInput, type RetentionLimits, type RetentionResult } from './retention';

// The L store of the commit contract (#739 D1): one K4 ledger transaction holds the state change,
// the command record and the outbox rows. K4 deduplicates terminals and messages, so L records no callback.
// Retention (#798) moves settled rows into K4 application rows of the same transaction.
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
