import type { AgentHomeProjectionRequest } from '@byok-sdk/server';
import type { ExecutionTemplate } from '../../host-execution-core/src/model';

export interface BotProfile {
  id: string; name: string; role: string; persona: string; model: string;
  mainBot: boolean; archived: boolean; revision: string; readyRevision: string | null;
  execution: ExecutionTemplate;
}
export interface Room {
  id: string; name: string; members: string[]; admin?: string; mode: 'mention'; announcement: string;
  visibleFrom: Record<string, number>;
  messages: Array<{ id: string; from: string; text: string; late: boolean }>;
}
export interface Round {
  id: string; root: string; roomId: string; input: string; seats: string[];
  limit: number; counts: Record<string, number>; admin?: string; closed: boolean;
}
export interface Seat {
  id: string; roundId: string; botId: string;
  status: 'waiting' | 'queued' | 'running' | 'late' | 'post' | 'pass' | 'failed' | 'busy' | 'removed' | 'blocked';
  triggerMessageId?: string; released: boolean; deadline?: number; startedAt?: number; late: boolean; reason?: string;
}
export interface HomeOperation {
  sequence: number; botId: string; request: AgentHomeProjectionRequest;
  retries: AgentHomeProjectionRequest[]; retryAt?: number;
  status: 'pending' | 'applied' | 'failed'; error?: string;
}
export interface TeamState {
  bots: Record<string, BotProfile>; rooms: Record<string, Room>; rounds: Record<string, Round>;
  seats: Record<string, Seat>; roots: Record<string, { autonomous: number; late: number }>;
  notes: Array<{ id: string; text: string }>;
  homeOperations: HomeOperation[];
}
export function emptyTeam(): TeamState {
  return { bots: {}, rooms: {}, rounds: {}, seats: {}, roots: {}, notes: [], homeOperations: [] };
}
