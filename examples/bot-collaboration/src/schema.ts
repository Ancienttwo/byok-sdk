import type { CollaborationState, Turn } from './model';
import type { BotRoutine } from './routines';
import * as rules from './rules/context';
import { HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS } from './rules/history';

// K8 adapter for the pure schema and ContextPack rules in `rules/`. The device ledger is the history authority here.
export { CONFIRMABLE_MAX, DEFAULT_CONFIRMABLE, DEFAULT_TIME_ZONES, MAIN_ACTIONS, NEW_BOTS, NEW_ROOMS, outcomeOffer, outcomeSchema, ROOM_SYSTEM_PROMPT, SYSTEM_PROMPT, TIME_ZONES_MAX,
  TURN_ACTIONS, type CheckedOffer, type ConfirmableSpec, type MainAction, type OutcomeOffer, type TurnAction } from './rules/schema';
export { contextTurns, DEFAULT_CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_TURN_LIMIT, type ContextHistory, type ContextTurn, type InstructionLimits } from './rules/context';

/** Every stored Turn and its rows, in ledger order. */
function ledgerHistory(state: CollaborationState): rules.ContextHistory {
  return { turns: Object.values(state.turns), cards: Object.values(state.cards), questions: Object.values(state.questions), rejected: state.rejected };
}
/** `crossRequest` is the framed Request section of a Cross-Bot Turn; its background is trimmed too (§3.7). */
export function turnContext(state: CollaborationState, turn: Turn, turnLimit = HISTORY_MAX_ITEMS, maxBytes = HISTORY_MAX_BYTES, crossRequest?: string,
  routines: readonly BotRoutine[] = []) {
  return rules.turnContext(state, rules.botHistory(state, turn), turn, turnLimit, maxBytes, crossRequest, routines);
}
/** Snapshot views include the candidate. Frozen turn views keep it in Request. */
export function contextPack<T extends object = Record<never, never>>(state: CollaborationState, turnLimit?: number, currentTurnId?: string,
  maxBytes?: number, separateRequest?: boolean, shared?: T, fit?: { request?: string; background?: unknown[][] }, routines: readonly BotRoutine[] = []) {
  return rules.contextPack(ledgerHistory(state), turnLimit, currentTurnId, maxBytes, separateRequest, shared, fit, routines);
}
