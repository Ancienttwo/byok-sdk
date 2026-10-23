import type { ResultSchema } from '@byok-sdk/protocol';
import { emptyTeam, type TeamState } from './team-model';
import type { Json } from '@byok-sdk/example-host-execution-core';
import type { ChannelState } from './delivery-routing';
import type { InputBatch, UserInput } from './rules/coalesce';
import { json, type Budget, type Card, type Question, type Rejection, type Turn } from './rules/turn';
import type { AcceptedReply, Batch, Delegation, Unit } from './rules/delegation';

export type { Authority, InputBatch, SealReason, UserInput } from './rules/coalesce';
export { addBatchTurns, addTurn, json } from './rules/turn';
export type { Budget, Card, Question, Rejection, ReplyEntry, Turn, TurnFields, Verdict } from './rules/turn';
export type { AcceptedReply, Batch, Delegation, DelegationCancel, Unit } from './rules/delegation';

/** Version 2 has no routine state. Bot routines are K4 routines with the `bot-routine` occurrence hook. */
export interface CollaborationState {
  version: 2; team: TeamState; turns: Record<string, Turn>; budgets: Record<string, Budget>;
  delegations: Record<string, Delegation>; batches: Record<string, Batch>; units: Record<string, Unit>;
  replies: Record<string, AcceptedReply>;
  schemas: Record<string, ResultSchema>; questions: Record<string, Question>; cards: Record<string, Card>;
  rejected: Rejection[]; audit: string[]; sequence: number;
  /** Input coalescing. Both appear at the first coalesced input. */
  inputs?: Record<string, UserInput>; inputBatches?: Record<string, InputBatch>;
  /** Host-only routes and final-content outbox. Never included in ContextPack or projections. */
  channel?: ChannelState;
}
export function stateOf(application: Record<string, Json>): CollaborationState {
  if (application.collaboration === undefined) application.collaboration = json({
    version: 2, team: emptyTeam(), turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {}, schemas: {}, questions: {}, cards: {},
    rejected: [], audit: [], sequence: 0,
  });
  const version = (application.collaboration as unknown as { version?: unknown } | null)?.version;
  // No migration: version 1 kept Bot routines in this state, and K4 owns them now.
  if (version === 1) throw new Error('Bot collaboration state version 1 is not supported. Bot routines moved to K4 routines. '
    + 'Restore a ledger backup made before this change, or start a new ledger.');
  if (version !== 2) throw new Error('Unsupported Bot collaboration state version');
  return application.collaboration as unknown as CollaborationState;
}
