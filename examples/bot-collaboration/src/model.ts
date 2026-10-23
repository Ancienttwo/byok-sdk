import type { AskUserAction, ConfirmableAction, ResultSchema } from '@byok-sdk/protocol';
import { emptyTeam, type TeamState } from './team-model';
import type { Json } from '@byok-sdk/example-host-execution-core';
import type { ChannelState } from './delivery-routing';
import { sealAtBoundary, type Authority, type BatchTurn, type InputBatch, type UserInput } from './rules/coalesce';

export type { Authority, InputBatch, SealReason, UserInput } from './rules/coalesce';

export interface Turn {
  id: string; root: string; botId: string;
  source: 'user' | 'continuation' | 'answer' | 'action_result' | 'routine' | 'room_slot' | 'bot_request' | 'bot_reply';
  request: string; hop: number; status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'blocked' | 'delivered';
  /** Set at insert and never changed. Absent counts as `bot`: only `owner` turns can manage the team. */
  authority?: Authority;
  /** B side of a delegation: the bot_request Turn and its continuations. */
  delegationId?: string;
  /** bot_reply Turns: one entry per reported delegation. Bodies stay in `replies`. */
  replies?: ReplyEntry[];
  /** A refusal report gets no delegate fragment, so it cannot report again. */
  refusalReport?: boolean;
  /** Budget unit that this Turn's execution spends when it is claimed. */
  unit?: string;
  /** Input batch Turns: the user inputs that this one reply answers, in arrival order. */
  inputIds?: string[];
  blockedReason?: string; profileFailure?: { sequence: number; revision: string; reason: string }; outcome?: Json; conclusion?: string; reported?: boolean;
}
export type Verdict = 'answered' | 'failed' | 'cancelled' | 'refused' | 'expired' | 'abandoned';
export interface ReplyEntry {
  delegationId: string; from: string; request: string; verdict: Verdict; reason?: string;
  /** B taskId of the accepted reply body in `CollaborationState.replies`. */
  reply?: string; continuationRefused?: true;
  /** The reply was accepted before a cancel. The cancel stopped the rest of the execution. */
  partial?: true;
}
/**
 * Frozen in the arbitration transaction (§8.8). `delivered` turns true after core.cancel. No `reason` means a user cancel.
 * `target_archived` is the Host cancel when the target Bot is archived (§8.4). Its verdict is `refused`.
 */
export interface DelegationCancel { requestedAt: number; targetTurnId: string; delivered: boolean; reason?: 'main_bot_cancelled' | 'target_archived' }
export interface Delegation {
  id: string; root: string; fromBotId: string; fromTurnId: string; fromTaskId: string; index: number;
  toBotId: string; toAgentRef?: { agentId: string; profileRevision: string }; toDeviceId?: string;
  request: string; hop: number; requestTurnId?: string; chainTurnIds: string[]; batch: string;
  status: 'queued' | 'waiting_device' | 'running' | 'reply_pending' | 'reply_held' | 'uncertain' | 'resolved';
  revision: number; nextCheckAt?: number; checks?: number; pendingSince?: number;
  verdict?: Verdict; reason?: string; reply?: string; continuationRefused?: true; partial?: true; replyTurnId?: string;
  uncertainSince?: number; resolvedAt?: number;
  cancel?: DelegationCancel;
  /** First observed claim of the current chain Turn (§8.3). */
  claimed?: { turnId: string; at: number };
  /** A chain Turn still open at the verdict. Its later terminal goes to audit only. */
  lateTurnId?: string;
  /** The verdict has no reply Turn because the initiator is archived (§8.5). */
  undelivered?: 'initiator_archived';
}
/**
 * One A outcome. `slots` are the prepaid A reply units of this batch.
 * `released` is set at the first report, or when every accepted delegation is uncertain (§3.5).
 */
export interface Batch { id: string; delegationIds: string[]; slots: string[]; released?: true }
/** `turnId` is the Turn that holds the unit. A free A slot has none. */
export interface Unit { id: string; root: string; state: 'reserved' | 'spent' | 'released'; turnId?: string }
export interface AcceptedReply {
  turnId: string; messageId: string; contentHash: string; contentType: string; acceptedAt: number;
  /** Stored only for delegation chain Turns. */
  body?: string;
}
export interface Card {
  id: string; turnId: string; action: ConfirmableAction<Json>;
  state: 'pending' | 'confirmed' | 'rejected' | 'expired'; expiresAt: number;
  result?: Json; error?: string; conclusion?: 'succeeded' | 'failed'; decisionReported?: boolean;
}
export interface Question { id: string; turnId: string; value: AskUserAction; answer?: string }
export interface Rejection { botId: string; taskId: string; action: string; reason: string; consumedBy?: string }
/** `delegation` counts spent Bot units. `reserved` counts open units; it appears at the first Cross-Bot admission. */
export interface Budget { continuation: number; delegation: number; reserved?: number }
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
export interface TurnFields {
  id: string; root: string; source: Turn['source']; request: string; botId: string; hop: number; authority: Authority;
  delegationId?: string; replies?: ReplyEntry[]; refusalReport?: boolean; unit?: string; inputIds?: string[];
}
/**
 * Idempotent by id. Hop and authority come from the caller; nothing resets them.
 * A new Turn first seals its Bot's open input batch, so the queue keeps arrival order.
 */
export function addTurn(state: CollaborationState, fields: TurnFields): Turn {
  const sealed = state.turns[fields.id] ? undefined : sealAtBoundary(state, fields.botId);
  if (sealed) addBatchTurns(state, [sealed]);
  return insertTurn(state, fields);
}
/** One user Turn per sealed input batch, in order. A batch Turn id is new and its batch is sealed, so no boundary seal applies. */
export function addBatchTurns(state: CollaborationState, sealed: readonly BatchTurn[]): void {
  for (const batch of sealed) insertTurn(state, { id: batch.id, root: batch.id, source: 'user', request: batch.request, botId: batch.botId, hop: 0,
    authority: batch.authority, inputIds: batch.inputIds });
}
function insertTurn(state: CollaborationState, fields: TurnFields): Turn {
  state.turns[fields.id] ??= { ...fields, status: 'queued' };
  state.budgets[fields.root] ??= { continuation: 0, delegation: 0 };
  return state.turns[fields.id]!;
}
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
