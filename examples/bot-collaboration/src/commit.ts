import type { HostLedger, LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf } from './model';
import { commitCommand, type Command, type CommandPorts } from './rules/commands';
import type { CommitRequest, CommitResult } from './rules/commit';

// The L store of the commit contract (#739 D1): one K4 ledger transaction holds the state change,
// the command record and the outbox rows. K4 deduplicates terminals and messages, so L records no callback.
export { CommitConflict, revisionOf, type CommitRequest, type CommitResult, type Disposition, type OutboxIntent } from './rules/commit';
export type { Command, CommandPorts } from './rules/commands';

/** The scope of an L ledger is its tenant. `ports` gets the transaction state, so outbox writes join the commit. */
export function commitInLedger(ledger: HostLedger, request: CommitRequest<Command>, ports: (s: LedgerState) => CommandPorts): CommitResult {
  return ledger.transaction(s => commitCommand(stateOf(s.application), request, { scope: ledger.tenant, recordCallbacks: false }, ports(s)));
}
