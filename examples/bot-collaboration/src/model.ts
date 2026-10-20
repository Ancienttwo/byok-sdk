import type { AskUserAction, ConfirmableAction, ResultSchema, RoutineScheduleFields } from '@byok-sdk/protocol';
import { emptyTeam, type TeamState } from './team-model';
import type { Json } from '@byok-sdk/example-host-execution-core';

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
export type Authority = 'owner' | 'bot';
/** One durable record per user input while input coalescing is in use. `key` is the caller's input key. */
export interface UserInput {
  id: string; key: string; botId: string; request: string; bytes: number;
  sender: string; authority: Authority; receivedAt: number; batchId: string;
}
export type SealReason = 'idle' | 'window' | 'items' | 'bytes' | 'boundary' | 'key_changed' | 'cancel' | 'policy_off' | 'archived';
/**
 * `id` is the first input's id and the batch Turn id. `key` is the coalescing key.
 * `request` is the rendered Request while the batch is open; sealing moves it into the batch Turn.
 * `bytes` is its UTF-8 size, framing included.
 */
export interface InputBatch {
  id: string; botId: string; key: string; inputIds: string[]; bytes: number;
  openedAt: number; sealAt: number; state: 'open' | 'sealed'; sealReason?: SealReason; request?: string;
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
  status: 'queued' | 'running' | 'reply_pending' | 'reply_held' | 'uncertain' | 'resolved';
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
export interface Definition { version: number; schedule: RoutineScheduleFields; prompt: string; target: string }
export interface Slot { version: number; at: number; key: string }
export interface Routine {
  id: string; owner: string; current: number; pending: number | null; generation: number;
  /** Authority of the Turn that created the routine. Its routine Turns inherit it. */
  authority?: Authority;
  versions: Record<string, Definition>; lifecycle: 'active' | 'paused' | 'completed';
  armed: Slot | null; inflight: string[];
  status: 'ok' | 'calendar_error' | 'no_occurrence_within_horizon' | 'schedule_retrying';
  errors: Array<{ at: number; message: string; wakeKey?: string }>;
}
export interface Occurrence {
  key: string; routineId: string; version: number; at: number; deliveredAt: number;
  decision: 'run' | 'skipped' | 'superseded' | 'capacity';
  trigger: 'scheduled' | 'catch_up'; definition?: Definition; turnId?: string; settled: boolean;
}
export interface WakeOp {
  sequence: number; routineId: string; generation: number; kind: 'schedule' | 'cancel'; slot: Slot;
  state: 'pending' | 'done' | 'obsolete'; error?: string; retryAt?: number;
}
export interface Rejection { botId: string; taskId: string; action: string; reason: string; consumedBy?: string }
/** `delegation` counts spent Bot units. `reserved` counts open units; it appears at the first Cross-Bot admission. */
export interface Budget { continuation: number; delegation: number; reserved?: number }
export interface CollaborationState {
  version: 1; team: TeamState; turns: Record<string, Turn>; budgets: Record<string, Budget>;
  delegations: Record<string, Delegation>; batches: Record<string, Batch>; units: Record<string, Unit>;
  replies: Record<string, AcceptedReply>;
  schemas: Record<string, ResultSchema>; questions: Record<string, Question>; cards: Record<string, Card>;
  routines: Record<string, Routine>; occurrences: Record<string, Occurrence>; operations: WakeOp[];
  rejected: Rejection[]; audit: string[]; sequence: number;
  /** Input coalescing. Both appear at the first coalesced input. */
  inputs?: Record<string, UserInput>; inputBatches?: Record<string, InputBatch>;
}
export function stateOf(application: Record<string, Json>): CollaborationState {
  if (application.collaboration === undefined) application.collaboration = json({
    version: 1, team: emptyTeam(), turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {}, schemas: {}, questions: {}, cards: {}, routines: {}, occurrences: {},
    operations: [], rejected: [], audit: [], sequence: 0,
  });
  const state = application.collaboration as unknown as CollaborationState;
  if (!state || state.version !== 1) throw new Error('Unsupported Bot collaboration state version');
  return state;
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
  const open = state.turns[fields.id] ? undefined : openInputBatch(state, fields.botId);
  if (open) sealInputBatch(state, open, 'boundary');
  state.turns[fields.id] ??= { ...fields, status: 'queued' };
  state.budgets[fields.root] ??= { continuation: 0, delegation: 0 };
  return state.turns[fields.id]!;
}
/** A Bot has at most one open input batch. */
export function openInputBatch(state: CollaborationState, botId: string): InputBatch | undefined {
  return Object.values(state.inputBatches ?? {}).find(batch => batch.botId === botId && batch.state === 'open');
}
/** The batch becomes one user Turn with the batch id. Neither changes after this. */
export function sealInputBatch(state: CollaborationState, batch: InputBatch, reason: SealReason): Turn {
  const request = batch.request;
  if (batch.state !== 'open' || request === undefined) throw new Error('Input batch is already sealed');
  batch.state = 'sealed'; batch.sealReason = reason; delete batch.request;
  return addTurn(state, { id: batch.id, root: batch.id, source: 'user', request, botId: batch.botId, hop: 0,
    authority: state.inputs![batch.id]!.authority, inputIds: [...batch.inputIds] });
}
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
