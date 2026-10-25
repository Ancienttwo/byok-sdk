import type { AskUserAction, ConfirmableAction } from '@byok-sdk/protocol';
import { sealAtBoundary, type Authority, type BatchTurn, type CoalesceState } from './coalesce';

/**
 * Turn rows and the rows that a Turn makes, as pure rules (#739 D1). The functions change only the rows
 * that the caller gives and do no I/O. `model.ts` stores these rows in the K8 ledger.
 */
/** The same JSON value type as the K4 `Json`. Rules do not import K4 types. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }

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
  /** History mode: the hash of the injected history that this Turn's offer froze (#739 Q4b), or of a seat's injected room messages (#883). */
  historyDigest?: string;
  /** Set while the sync holds this Turn because its Bot's device has no active binding (#956) or is frozen for an owner switch (#957). */
  held?: 'device_not_bound' | 'device_switching';
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
export interface Card {
  id: string; turnId: string; action: ConfirmableAction<Json>;
  state: 'pending' | 'confirmed' | 'rejected' | 'expired'; expiresAt: number;
  result?: Json; error?: string; conclusion?: 'succeeded' | 'failed'; decisionReported?: boolean;
}
export interface Question { id: string; turnId: string; value: AskUserAction; answer?: string }
export interface Rejection { botId: string; taskId: string; action: string; reason: string; consumedBy?: string }
/** `delegation` counts spent Bot units. `reserved` counts open units; it appears at the first Cross-Bot admission. */
export interface Budget { continuation: number; delegation: number; reserved?: number }
/** The rows that adding a Turn changes. */
export interface TurnsState extends CoalesceState { turns: Record<string, Turn>; budgets: Record<string, Budget> }
export interface TurnFields {
  id: string; root: string; source: Turn['source']; request: string; botId: string; hop: number; authority: Authority;
  delegationId?: string; replies?: ReplyEntry[]; refusalReport?: boolean; unit?: string; inputIds?: string[];
}
/**
 * Idempotent by id. Hop and authority come from the caller; nothing resets them.
 * A new Turn first seals its Bot's open input batch, so the queue keeps arrival order.
 */
export function addTurn(state: TurnsState, fields: TurnFields): Turn {
  const sealed = state.turns[fields.id] ? undefined : sealAtBoundary(state, fields.botId);
  if (sealed) addBatchTurns(state, [sealed]);
  return insertTurn(state, fields);
}
/** One user Turn per sealed input batch, in order. A batch Turn id is new and its batch is sealed, so no boundary seal applies. */
export function addBatchTurns(state: TurnsState, sealed: readonly BatchTurn[]): void {
  for (const batch of sealed) insertTurn(state, { id: batch.id, root: batch.id, source: 'user', request: batch.request, botId: batch.botId, hop: 0,
    authority: batch.authority, inputIds: batch.inputIds });
}
function insertTurn(state: TurnsState, fields: TurnFields): Turn {
  state.turns[fields.id] ??= { ...fields, status: 'queued' };
  state.budgets[fields.root] ??= { continuation: 0, delegation: 0 };
  return state.turns[fields.id]!;
}
