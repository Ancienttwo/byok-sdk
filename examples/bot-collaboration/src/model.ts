import type { ResultSchema } from '@byok-sdk/protocol';
import { emptyTeam, type TeamState } from './team-model';
import type { Json } from '@byok-sdk/server/execution-core';
import type { ChannelState } from './delivery-routing';
import type { InputBatch, UserInput } from './rules/coalesce';
import { json, type Budget, type Card, type Question, type Rejection, type Turn } from './rules/turn';
import type { AcceptedReply, Batch, Delegation, Unit } from './rules/delegation';
import type { CommandRecord } from './rules/commit';
import type { DeviceTopology } from './topology';
import type { SwitchExportMark, SwitchImport } from './switch';

export type { Authority, InputBatch, SealReason, UserInput } from './rules/coalesce';
export { addBatchTurns, addTurn, json } from './rules/turn';
export type { Budget, Card, Question, Rejection, ReplyEntry, Turn, TurnFields, Verdict } from './rules/turn';
export type { AcceptedReply, Batch, Delegation, DelegationCancel, Unit } from './rules/delegation';

/**
 * Version 3 (#798): retention moves settled rows out of this state into K4 application rows, so a version 2 writer
 * would read archived evidence as absent. Bot routines are K4 routines with the `bot-routine` occurrence hook.
 */
export interface CollaborationState {
  version: 3; team: TeamState; turns: Record<string, Turn>; budgets: Record<string, Budget>;
  delegations: Record<string, Delegation>; batches: Record<string, Batch>; units: Record<string, Unit>;
  replies: Record<string, AcceptedReply>;
  schemas: Record<string, ResultSchema>; questions: Record<string, Question>; cards: Record<string, Card>;
  rejected: Rejection[]; audit: string[]; sequence: number;
  /** Input coalescing. Both appear at the first coalesced input. */
  inputs?: Record<string, UserInput>; inputBatches?: Record<string, InputBatch>;
  /** Host-only routes and final-content outbox. Never included in ContextPack or projections. */
  channel?: ChannelState;
  /**
   * Commit contract (#739 D1). Both appear at the first commit; a state without them is at revision 0.
   * `commands` holds the dedup evidence of owner commands. K4 deduplicates terminals and messages itself.
   */
  revision?: number; commands?: Record<string, CommandRecord>;
  /**
   * Host intents (#882): the handler name of each Host-owned K4 intent, by intent key. A record lives as long as K4
   * keeps its intent. It appears at the first Host intent, so an older ledger reads an empty table.
   */
  hostIntents?: Record<string, { handler: string }>;
  /**
   * L card call claims (#958): a card id is here from the transaction before its connector call until the one that settles
   * it. It appears at the first claim, so an older ledger reads an empty table. Never in ContextPack or projections.
   */
  cardCalls?: Record<string, true>;
  /**
   * L owner records by device id (#957, §4.1), from `topology.ts`. A device appears at its first switch step, so an older
   * ledger reads every device as L at revision 0. Never in ContextPack or projections.
   */
  topology?: Record<string, DeviceTopology>;
  /**
   * L switch records (#975), from `switch.ts`. `switchExport` appears at the export of an old owner and stays; while it is
   * here the Host writes nothing. `switchImport` is here from the load of a new owner until its commit toward L. Neither
   * moves in an export, and neither is in ContextPack or projections.
   */
  switchExport?: SwitchExportMark; switchImport?: SwitchImport;
}
export function stateOf(application: Record<string, Json>): CollaborationState {
  if (application.collaboration === undefined) application.collaboration = json({
    version: 3, team: emptyTeam(), turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {}, schemas: {}, questions: {}, cards: {},
    rejected: [], audit: [], sequence: 0,
  });
  const version = (application.collaboration as unknown as { version?: unknown } | null)?.version;
  // No migration: version 1 kept Bot routines in this state, and K4 owns them now.
  if (version === 1) throw new Error('Bot collaboration state version 1 is not supported. Bot routines moved to K4 routines. '
    + 'Restore a ledger backup made before this change, or start a new ledger.');
  // No migration: a version 2 writer cannot read archived rows, so the two versions never share a ledger.
  if (version === 2) throw new Error('Bot collaboration state version 2 is not supported. Retention moved settled rows out of the state. '
    + 'Restore a ledger backup made before this change, or start a new ledger.');
  if (version !== 3) throw new Error('Unsupported Bot collaboration state version');
  return application.collaboration as unknown as CollaborationState;
}
