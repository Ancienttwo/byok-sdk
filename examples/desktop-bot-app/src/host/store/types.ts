import type { Turn } from '@byok-sdk/bot-collaboration/host-kit';

/** One Bot of the roster. The Host store is the team authority; K8 receives the roster as `applyTeam` snapshots. */
export interface BotProfile {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly persona: string;
  /** A model catalog entry id from the brand config, never a runtime model name. */
  readonly model: string;
}

/** A roster row. Archive is irreversible: K8 refuses an archived Bot in any later snapshot. */
export interface BotRow extends BotProfile {
  readonly archived: boolean;
}

/** The roster at one revision: the store's team revision and its unarchived Bots, oldest first. */
export interface Roster {
  readonly revision: number;
  readonly bots: readonly BotProfile[];
}

/**
 * One transcript entry, in commit order (`seq`).
 * - `input`: a user send, keyed by the renderer's action id. `turnId` is absent until K8 committed the input.
 * - `reply`: an accepted reply body, written only after its Turn's outcome committed `succeeded` (#1499 R1).
 * - `clear`: a context epoch marker, keyed by its action id. Later ContextPacks omit every row before it.
 */
export type TranscriptEntry =
  | { readonly seq: number; readonly kind: 'input'; readonly botId: string; readonly actionId: string; readonly text: string; readonly turnId?: string; readonly at: number }
  | { readonly seq: number; readonly kind: 'reply'; readonly botId: string; readonly turnId: string; readonly taskId: string; readonly text: string; readonly at: number }
  | { readonly seq: number; readonly kind: 'clear'; readonly botId: string; readonly actionId: string; readonly at: number };

/** A `bot-turn:<id>` projection value, as K8 publishes it. */
export type TurnProjection = Turn & { readonly owner: string; readonly reason?: string };

/** The Host's record of one Turn: its latest projection and, once accepted, the reply that the user saw. */
export interface TurnRecord {
  readonly turnId: string;
  readonly botId: string;
  readonly root: string;
  /** Position in the transcript order: the input's `seq` for an input Turn. History after a clear compares it with the epoch. */
  readonly seq: number;
  readonly projection: TurnProjection;
  /** The reply body written to the transcript; absent for a Turn that ended without a visible reply. */
  readonly reply?: string;
}
