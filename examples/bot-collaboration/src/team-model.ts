import type { AgentHomeProjectionRequest } from '@byok-sdk/server';
import type { ExecutionTemplate } from '@byok-sdk/example-host-execution-core';
import type { Room, Round, Seat } from './rules/rooms';
import type { ExternalTeam } from './rules/team';

export type { Room, Round, Seat };
export interface BotProfile {
  id: string; name: string; role: string; persona: string; model: string;
  mainBot: boolean; archived: boolean; revision: string; readyRevision: string | null;
  execution: ExecutionTemplate;
}
export interface HomeOperation {
  sequence: number; botId: string; request: AgentHomeProjectionRequest;
  retries: AgentHomeProjectionRequest[]; retryAt?: number;
  status: 'pending' | 'applied' | 'failed'; error?: string;
  /** Set in the transaction before the first write is sent (#957), so a crash or a failed send still counts it as sent. */
  sent?: true;
}
export interface TeamState {
  bots: Record<string, BotProfile>; rooms: Record<string, Room>; rounds: Record<string, Round>;
  seats: Record<string, Seat>; roots: Record<string, { autonomous: number; late: number }>;
  notes: Array<{ id: string; text: string }>;
  homeOperations: HomeOperation[];
  /** External team mode (#739 Q4c). Absent: this Host owns its local team. */
  external?: ExternalTeam;
}
export function emptyTeam(): TeamState {
  return { bots: {}, rooms: {}, rounds: {}, seats: {}, roots: {}, notes: [], homeOperations: [] };
}
