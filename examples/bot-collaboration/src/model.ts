import type { AskUserAction, ConfirmableAction, ResultSchema, RoutineScheduleFields } from '@byok-sdk/protocol';
import { emptyTeam, type TeamState } from './team-model';
import type { Json } from '@byok-sdk/example-host-execution-core';

export interface Turn {
  id: string; root: string; botId: string; source: 'user' | 'continuation' | 'answer' | 'action_result' | 'routine' | 'room_slot';
  request: string; hop: number; status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'blocked';
  blockedReason?: string; profileFailure?: { sequence: number; revision: string; reason: string }; outcome?: Json; conclusion?: string; reported?: boolean;
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
export interface CollaborationState {
  version: 1; team: TeamState; turns: Record<string, Turn>; budgets: Record<string, { continuation: number; delegation: number }>;
  schemas: Record<string, ResultSchema>; questions: Record<string, Question>; cards: Record<string, Card>;
  routines: Record<string, Routine>; occurrences: Record<string, Occurrence>; operations: WakeOp[];
  rejected: Rejection[]; audit: string[]; sequence: number;
}
export function stateOf(application: Record<string, Json>): CollaborationState {
  if (application.collaboration === undefined) application.collaboration = json({
    version: 1, team: emptyTeam(), turns: {}, budgets: {}, schemas: {}, questions: {}, cards: {}, routines: {}, occurrences: {},
    operations: [], rejected: [], audit: [], sequence: 0,
  });
  const state = application.collaboration as unknown as CollaborationState;
  if (!state || state.version !== 1) throw new Error('Unsupported Bot collaboration state version');
  return state;
}
export function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
