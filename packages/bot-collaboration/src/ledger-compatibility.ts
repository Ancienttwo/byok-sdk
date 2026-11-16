import type { HostLedger } from '@byok-sdk/server/execution-core';
import { refuseUnmigratedWouldDo, type AutonomyState } from './rules/autonomy.js';

// A Host ledger is opened once per instance. Direct host-kit writers can also
// receive a ledger without constructing a BotCollaboration, so admit it at
// their first transaction before any K8 work runs.
const admitted = new WeakSet<object>();

export function checkLedgerWouldDo(ledger: Pick<HostLedger, 'transaction'>, state: AutonomyState): void {
  refuseUnmigratedWouldDo(state);
  admitted.add(ledger);
}

export function admitLedgerWouldDo(ledger: Pick<HostLedger, 'transaction'>, state: AutonomyState): void {
  if (!admitted.has(ledger)) checkLedgerWouldDo(ledger, state);
}
