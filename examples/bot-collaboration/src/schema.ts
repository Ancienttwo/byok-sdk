import type { CollaborationState, Turn } from './model';
import type { BotRoutine } from './routines';
import * as rules from './rules/context';
import { HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS } from './rules/history';

// K8 adapter for the pure schema and ContextPack rules in `rules/`. The device ledger is the history authority here.
export { NEW_BOTS, NEW_ROOMS, outcomeSchema, ROOM_SYSTEM_PROMPT, SYSTEM_PROMPT } from './rules/schema';
export { contextTurns, DEFAULT_CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_TURN_LIMIT, type ContextHistory, type ContextTurn, type InstructionLimits } from './rules/context';

/** Every stored Turn and its rows, in ledger order. */
function ledgerHistory(state: CollaborationState): rules.ContextHistory {
  return { turns: Object.values(state.turns), cards: Object.values(state.cards), questions: Object.values(state.questions), rejected: state.rejected };
}
/**
 * One Bot's history in ledger order. `turn` takes its stored position, or comes last when it is not stored.
 * Select within the Bot boundary before applying any count or byte window.
 */
function botHistory(state: CollaborationState, turn: Turn, injected?: readonly rules.ContextTurn[]): rules.ContextHistory {
  const own = <T extends { turnId: string }>(rows: Record<string, T>) => Object.values(rows).filter(row => state.turns[row.turnId]?.botId === turn.botId);
  return {
    // Injected rows replace the stored Turns. The current Turn always comes from this ledger.
    turns: injected ? [...injected.filter(row => row.id !== turn.id), turn]
      : Object.values({ ...Object.fromEntries(Object.entries(state.turns).filter(([, row]) => row.botId === turn.botId)), [turn.id]: turn }),
    cards: own(state.cards), questions: own(state.questions),
    rejected: state.rejected.filter(rejection => rejection.botId === turn.botId && !rejection.consumedBy),
  };
}
/** `crossRequest` is the framed Request section of a Cross-Bot Turn; its background is trimmed too (§3.7). */
export function turnContext(state: CollaborationState, turn: Turn, turnLimit = HISTORY_MAX_ITEMS, maxBytes = HISTORY_MAX_BYTES, crossRequest?: string,
  routines: readonly BotRoutine[] = []) {
  return rules.turnContext(state, botHistory(state, turn), turn, turnLimit, maxBytes, crossRequest, routines);
}
/**
 * The frozen instruction. A Cross-Bot Turn fits `instructionMaxBytes` as a whole.
 * `injected` is the Bot's earlier history from an external authority. Cards, questions and rejected actions stay Host state.
 */
export function turnInstruction(state: CollaborationState, turn: Turn, limits: rules.InstructionLimits, routines: readonly BotRoutine[] = [],
  injected?: readonly rules.ContextTurn[]) {
  return rules.turnInstruction(state, botHistory(state, turn, injected), turn, limits, routines);
}
/** Snapshot views include the candidate. Frozen turn views keep it in Request. */
export function contextPack<T extends object = Record<never, never>>(state: CollaborationState, turnLimit?: number, currentTurnId?: string,
  maxBytes?: number, separateRequest?: boolean, shared?: T, fit?: { request?: string; background?: unknown[][] }, routines: readonly BotRoutine[] = []) {
  return rules.contextPack(ledgerHistory(state), turnLimit, currentTurnId, maxBytes, separateRequest, shared, fit, routines);
}
