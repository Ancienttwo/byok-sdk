import type { ResultSchema } from '@byok-sdk/protocol';
import { emptyTeam, type TeamState } from './team-model.js';
import type { Json } from '@byok-sdk/server/execution-core';
import type { ChannelState } from './delivery-routing.js';
import type { InputBatch, UserInput } from './rules/coalesce.js';
import { json, type Budget, type Card, type Question, type Rejection, type Turn } from './rules/turn.js';
import type { AcceptedReply, Batch, Delegation, Unit } from './rules/delegation.js';
import type { CommandRecord } from './rules/commit.js';
import type { DeviceTopology } from './topology.js';
import type { SwitchExportMark } from './migration.js';
import type { SwitchImport } from './switch.js';
import type { AutonomyState, WouldDo } from './rules/autonomy.js';
import type { DreamState } from './dream.js';

export type { Authority, InputBatch, SealReason, UserInput } from './rules/coalesce.js';
export { addBatchTurns, addTurn, json } from './rules/turn.js';
export type { Budget, Card, Question, Rejection, ReplyEntry, Turn, TurnFields, Verdict } from './rules/turn.js';
export type { AcceptedReply, Batch, Delegation, DelegationCancel, Unit } from './rules/delegation.js';

/**
 * The K8 state. A Host ledger keeps it in its application body, and the ledger's `k8` format row (`botLedgerOptions`) is
 * its format.
 * Retention keeps settled rows in K4 application rows (#798). Bot routines are K4 routines with the `bot-routine`
 * occurrence hook.
 */
export interface CollaborationState extends AutonomyState {
  team: TeamState; turns: Record<string, Turn>; budgets: Record<string, Budget>;
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
  /**
   * Would-do rows of observing Bots (#1229), keyed by `wouldDoId(taskId, action, index)`. They appear at the first
   * observed action, so an older ledger reads none. They are Host UI history, never part of the Bot's ContextPack or wire.
   */
  wouldDo?: Record<string, WouldDo>;
  /**
   * Dreaming (#1475), from `dream.ts`: the owner of each dream intent and the last result of each Bot. It appears at the first
   * dream routine, so an older ledger reads none. Never in ContextPack or projections.
   */
  dreams?: DreamState;
}
/** The K8 state of an application body, created empty at its first use. */
export function stateOf(application: Record<string, Json>): CollaborationState {
  if (application.collaboration === undefined) application.collaboration = json({
    team: emptyTeam(), turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {}, schemas: {}, questions: {}, cards: {},
    rejected: [], audit: [], sequence: 0,
  });
  // SAFETY: The store that holds this body admitted its format when it opened (a Host ledger's `k8` row), so the value is
  // the state this build writes.
  return application.collaboration as unknown as CollaborationState;
}
