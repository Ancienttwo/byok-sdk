import type { Turn } from './turn.js';
import type { AcceptedReply, Delegation } from './delegation.js';
import type { Seat } from './rooms.js';

/** The collaboration rows that the compact veto reads. */
export interface CompactState {
  readonly turns: Readonly<Record<string, Turn>>;
  readonly delegations: Readonly<Record<string, Delegation>>;
  readonly team: { readonly seats: Readonly<Record<string, Seat>> };
  readonly replies: Readonly<Record<string, AcceptedReply>>;
  /** The dreams that K8 has not closed, by occurrence key. */
  readonly dreams?: { readonly open: Readonly<Record<string, unknown>> };
}
/** The store facts that the compact veto reads. */
export interface CompactFacts {
  /** The Turn has an intent. */
  hasIntent(turnId: string): boolean;
  /** The receipt that the store keeps for the replay of the task's accepted Agent message. */
  receipt(taskId: string): { readonly messageId: string; readonly contentHash: string } | undefined;
}

/** The occurrence key that an intent key names. K4 `occurrenceIntentKey` owns the format, and a rule cannot import the K4 root entry. */
const occurrenceOf = (key: string) => key.startsWith('occurrence:') ? key.slice('occurrence:'.length) : undefined;

/**
 * Refuses the compaction of the intent of Turn `key` with a reason, or allows it with `undefined` (#816, #793 S8). A Turn id is
 * its intent key. K8 reads the intent of a Turn until the Turn and its readers settle, so the store keeps it until then.
 * A dream intent has no Turn, and K8 reads it until the sync closes the dream, or the next dream repeats the window (#1490).
 * Any other key without a Turn, for example a Host job, is not a K8 key. L's K4 veto and H's compaction both run this rule.
 */
export function compactVeto(state: CompactState, key: string, facts: CompactFacts): string | undefined {
  const occurrence = occurrenceOf(key);
  if (occurrence !== undefined && state.dreams && Object.hasOwn(state.dreams.open, occurrence)) return 'The dream result is not synced';
  const turn = Object.hasOwn(state.turns, key) ? state.turns[key]! : undefined;
  if (!turn) return undefined;
  // A Turn without an intent, for example one that ended before promotion, has no result left to report.
  if (!turn.conclusion || facts.hasIntent(key) && !turn.reported) return 'The Turn is not concluded and reported';
  for (const d of Object.values(state.delegations)) {
    if (d.lateTurnId === key || !d.verdict && (d.chainTurnIds.includes(key) || d.cancel?.targetTurnId === key)) {
      return 'An unresolved delegation references the Turn';
    }
  }
  const seat = Object.hasOwn(state.team.seats, key) ? state.team.seats[key]! : undefined;
  if (seat && !seat.released) return 'The room seat of the Turn is not released';
  // A receipt is settled when the store holds it for message replay, and a delegated reply body when its delegation has a verdict.
  for (const [taskId, reply] of Object.entries(state.replies)) {
    if (reply.turnId !== key) continue;
    const receipt = facts.receipt(taskId);
    if (receipt?.messageId !== reply.messageId || receipt.contentHash !== reply.contentHash
      || reply.body !== undefined && !(turn.delegationId && state.delegations[turn.delegationId]?.verdict)) {
      return 'The reply receipt of the Turn is not settled';
    }
  }
  return undefined;
}
