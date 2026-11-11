import { buildHandoffPack, type HandoffPackBudgets, type HandoffTurn } from '@byok-sdk/protocol';
import type { Card, Question, Rejection, Turn } from './turn.js';
import { roomContext, type RoomMessage } from './rooms.js';
import { HISTORY_MAX_ITEMS, HISTORY_MAX_BYTES, HISTORY_OMITTED_NOTICE, historyWindow, fitHistory } from './history.js';
import { crossBotRequest, delegationBlock, instructionOverhead, isCrossBot, openDelegationsContext } from './delegation.js';
import { ownerMainTurn, ROOM_SYSTEM_PROMPT, systemPrompt, type ContextRoutine, type ContextState } from './schema.js';

/**
 * The frozen ContextPack and instruction as pure rules (#739 D1). The caller gives the history; no function
 * here reads stored Turn rows. A Host can read the history from the device ledger or from an external authority.
 */
/**
 * One Bot's history, oldest first. `turns` holds the current Turn; the Turn id selects it.
 * For a frozen Bot Turn, give only this Bot's rows: its Turns, the cards and questions of its Turns,
 * and its rejected actions that no Turn consumed. `room` holds a seat Turn's room messages from an external authority.
 */
export interface ContextHistory {
  readonly turns: readonly (Turn | ContextTurn)[]; readonly cards: readonly Card[]; readonly questions: readonly Question[];
  readonly rejected: readonly Rejection[]; readonly room?: readonly RoomMessage[];
}
/**
 * One history row of a ContextPack. An external history authority gives its rows in this shape (#739 Q4a).
 * `reply` is the reply text that the user saw for this Turn (#1318). Only an external authority gives it; K8 stores no reply text.
 */
export interface ContextTurn {
  id: string; root: string; source: Turn['source']; request: string; hop: number; status: Turn['status'];
  conclusion?: string; outcomeSummary: string[]; reply?: string;
}
const SOURCES = new Set<string>(['user', 'continuation', 'answer', 'action_result', 'routine', 'room_slot', 'bot_request', 'bot_reply']);
const STATUSES = new Set<string>(['queued', 'processing', 'succeeded', 'failed', 'blocked', 'delivered']);
/** Checks rows from an external authority. A row in another shape refuses the whole history. */
export function contextTurns(value: unknown): ContextTurn[] {
  const fail = (): never => { throw new Error('Invalid injected history'); };
  if (!Array.isArray(value)) fail();
  return (value as unknown[]).map(row => {
    const r = (row ?? fail()) as Record<string, unknown>;
    const text = (key: string) => typeof r[key] === 'string' ? r[key] as string : fail();
    if (!SOURCES.has(text('source')) || !STATUSES.has(text('status')) || !Number.isSafeInteger(r.hop) || (r.hop as number) < 0
      || r.conclusion !== undefined && typeof r.conclusion !== 'string' || r.reply !== undefined && typeof r.reply !== 'string'
      || !Array.isArray(r.outcomeSummary) || r.outcomeSummary.some(key => typeof key !== 'string')) fail();
    return { id: text('id'), root: text('root'), source: r.source as Turn['source'], request: text('request'), hop: r.hop as number,
      status: r.status as Turn['status'], ...(r.conclusion === undefined ? {} : { conclusion: r.conclusion as string }),
      outcomeSummary: [...r.outcomeSummary as string[]], ...(r.reply === undefined ? {} : { reply: r.reply as string }) };
  });
}
/**
 * One history row from a `bot-turn:<id>` projection value and the reply text that the user saw, for an external authority.
 * The row passes `contextTurns`.
 */
export function historyRowFromTurn(projection: Turn & { readonly owner: string; readonly reply?: string }): ContextTurn {
  const { conclusion, ...row } = contextTurn(projection);
  return { ...row, ...(conclusion === undefined ? {} : { conclusion }) };
}
function contextTurn(turn: Turn | ContextTurn): ContextTurn & { conclusion: string | undefined } {
  return { id: turn.id, root: turn.root, source: turn.source, request: turn.request, hop: turn.hop, status: turn.status, conclusion: turn.conclusion,
    outcomeSummary: 'outcomeSummary' in turn ? [...turn.outcomeSummary]
      : turn.outcome && typeof turn.outcome === 'object' && !Array.isArray(turn.outcome) ? Object.keys(turn.outcome) : [],
    ...('reply' in turn && turn.reply !== undefined ? { reply: turn.reply } : {}) };
}
/** One history row as a turn of the handoff pack. Its text goes in `lines`, and the rest stays whole in `meta`. */
export function handoffTurn(turn: Turn | ContextTurn): HandoffTurn {
  const { id, root, source, request, hop, status, conclusion, outcomeSummary, reply } = contextTurn(turn);
  return { lines: [{ speaker: source, text: request }, ...(reply === undefined ? [] : [{ speaker: 'bot', text: reply }])],
    meta: { id, root, hop, status, ...(conclusion === undefined ? {} : { conclusion }), outcomeSummary } };
}
/** The bytes of a pack of `turns` turns with nothing in it. */
export function handoffFrameBytes(turns: number): number {
  return Buffer.byteLength(JSON.stringify({ omittedTurns: turns, earlier: [], recent: [] }), 'utf8');
}
/** `crossRequest` is the framed Request section of a Cross-Bot Turn; its background is trimmed too (§3.7). */
export function turnContext<R extends ContextRoutine>(state: ContextState, history: ContextHistory, turn: Turn, turnLimit = HISTORY_MAX_ITEMS,
  maxBytes = HISTORY_MAX_BYTES, crossRequest?: string, routines: readonly R[] = [], handoff = DEFAULT_HANDOFF_BUDGETS) {
  const team = state.team;
  const ownRejections = history.rejected;
  const shared = { teamNotes: crossRequest === undefined ? team.notes : [...team.notes],
    roster: Object.values(team.bots).filter(b => !b.archived).map(b => ({ id: b.id, name: b.name, role: b.role, mainBot: b.mainBot })),
    rejectedActions: ownRejections.slice(-turnLimit), rooms: Object.values(team.rooms).map(({ messages: _messages, visibleFrom: _visibility, ...room }) => room),
    ...(turn.source === 'bot_request' ? { delegation: delegationBlock(state, turn) } : {}),
    ...(ownerMainTurn(state, turn.botId, turn) ? { openDelegations: openDelegationsContext(state) } : {}) };
  if (turn.source === 'room_slot') {
    const result = { ...shared, ...roomContext(team, turn, turnLimit, history.room) };
    result.historyWindow.maxBytes = maxBytes;
    result.historyWindow.omittedRejections = ownRejections.length - shared.rejectedActions.length;
    return fitHistory(result, result.room.messages, turn.request);
  }
  return contextPack(history, turnLimit, turn.id, maxBytes, true, shared,
    crossRequest === undefined ? {} : { request: crossRequest, background: [shared.rooms, shared.teamNotes] }, routines.filter(row => row.owner === turn.botId), handoff);
}
export interface InstructionLimits {
  turnLimit: number;
  /** The Request and the ContextPack without its Bot `history`. */
  contextMaxBytes: number;
  instructionMaxBytes: number;
  /** The Bot `history`. Default: `DEFAULT_HANDOFF_BUDGETS`. */
  handoff?: HandoffPackBudgets;
}
/**
 * The frozen instruction. A Cross-Bot Turn fits `instructionMaxBytes` as a whole.
 * `actions` narrows the Bot Turn prompt to those actions (`promptActions`). Absent: `SYSTEM_PROMPT`.
 */
export function turnInstruction<R extends ContextRoutine>(state: ContextState, history: ContextHistory, turn: Turn, limits: InstructionLimits,
  routines: readonly R[] = [], actions?: readonly string[]) {
  const prompt = turn.source === 'room_slot' ? ROOM_SYSTEM_PROMPT : systemPrompt(actions);
  const cross = isCrossBot(turn);
  const request = cross ? crossBotRequest(state, turn) : turn.request;
  const context = turnContext(state, history, turn, limits.turnLimit,
    cross ? limits.instructionMaxBytes - instructionOverhead(prompt) : limits.contextMaxBytes, cross ? request : undefined, routines, limits.handoff);
  return { context, instruction: `${prompt}\n\nRequest:\n${request}\n\nContextPack:\n${JSON.stringify(context)}` };
}
/** The stored Turn and row tables that a Bot's history selects from. */
export interface BotHistoryState {
  readonly turns: Readonly<Record<string, Turn>>; readonly cards: Readonly<Record<string, Card>>;
  readonly questions: Readonly<Record<string, Question>>; readonly rejected: readonly Rejection[];
}
/**
 * One Bot's history in ledger order. `turn` takes its stored position, or comes last when it is not stored.
 * Select within the Bot boundary before applying any count or byte window.
 */
export function botHistory(state: BotHistoryState, turn: Turn, injected?: readonly ContextTurn[], room?: readonly RoomMessage[]): ContextHistory {
  const own = <T extends { turnId: string }>(rows: Readonly<Record<string, T>>) => Object.values(rows).filter(row => state.turns[row.turnId]?.botId === turn.botId);
  return {
    // Injected rows replace the stored Turns. The current Turn always comes from this ledger.
    turns: injected ? [...injected.filter(row => row.id !== turn.id), turn]
      : Object.values({ ...Object.fromEntries(Object.entries(state.turns).filter(([, row]) => row.botId === turn.botId)), [turn.id]: turn }),
    cards: own(state.cards), questions: own(state.questions),
    rejected: state.rejected.filter(rejection => rejection.botId === turn.botId && !rejection.consumedBy),
    ...(room ? { room } : {}),
  };
}
/**
 * The frozen instruction of a Bot Turn, from its own history. A Cross-Bot Turn fits `instructionMaxBytes` as a whole.
 * `injected` is the Bot's earlier history from an external authority. Cards, questions and rejected actions stay Host state.
 * `room` is a seat Turn's room messages from an external authority. `actions` narrows the prompt, as in `turnInstruction`.
 */
export function botTurnInstruction<R extends ContextRoutine>(state: ContextState & BotHistoryState, turn: Turn, limits: InstructionLimits,
  routines: readonly R[] = [], injected?: readonly ContextTurn[], room?: readonly RoomMessage[], actions?: readonly string[]) {
  return turnInstruction(state, botHistory(state, turn, injected, room), turn, limits, routines, actions);
}
export const DEFAULT_CONTEXT_MAX_BYTES = HISTORY_MAX_BYTES;
export const DEFAULT_CONTEXT_TURN_LIMIT = 12;
export const DEFAULT_HANDOFF_BUDGETS: HandoffPackBudgets = { recentBytes: 40 * 1024, earlyBytes: 6 * 1024, totalBytes: 46 * 1024 };

/**
 * Snapshot views include the candidate as the newest turn of `history.recent`; an empty `recent` means it did not fit.
 * Frozen turn views keep it in Request. `maxBytes` bounds everything but `history`, which `handoff` bounds. `fit.request`
 * marks a Cross-Bot Turn, whose `history` gets only the bytes left in `maxBytes`.
 */
export function contextPack<T extends object = Record<never, never>, R = ContextRoutine>(history: ContextHistory, turnLimit = DEFAULT_CONTEXT_TURN_LIMIT,
  currentTurnId?: string, maxBytes = DEFAULT_CONTEXT_MAX_BYTES, separateRequest = false, shared: T = {} as T,
  fit: { request?: string; background?: unknown[][] } = {}, routines: readonly R[] = [], handoff = DEFAULT_HANDOFF_BUDGETS) {
  if (!Number.isSafeInteger(turnLimit) || turnLimit < 1) throw new Error('Invalid ContextPack turn limit');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid ContextPack byte budget');
  const turns = history.turns;
  const current = currentTurnId === undefined ? turns.at(-1) : turns.find(turn => turn.id === currentTurnId);
  if (currentTurnId !== undefined && !current) throw new Error('Missing ContextPack candidate');
  const earlier = turns.filter(turn => turn.id !== current?.id);
  const rows = (separateRequest || !current ? earlier : [...earlier, current]).map(handoffTurn);
  const cards = [...history.cards], questions = [...history.questions];
  const pendingCard = (card: typeof cards[number]) => card.state === 'pending';
  const pendingQuestion = (question: typeof questions[number]) => question.answer === undefined;
  // Pending work has priority. Each category retains the K8a recent-12 bound.
  const recent = <T>(rows: T[], pending: (row: T) => boolean) => [
    ...rows.filter(row => !pending(row)), ...rows.filter(pending),
  ].slice(-Math.min(turnLimit, DEFAULT_CONTEXT_TURN_LIMIT));
  const selectedCards = recent(cards, pendingCard), selectedQuestions = recent(questions, pendingQuestion);
  const context = {
    ...shared,
    historyWindow: { ...historyWindow('turns', 0, turnLimit, maxBytes),
      omittedCards: cards.length - selectedCards.length, omittedQuestions: questions.length - selectedQuestions.length,
      omittedPendingCards: cards.filter(pendingCard).length - selectedCards.filter(pendingCard).length,
      omittedPendingQuestions: questions.filter(pendingQuestion).length - selectedQuestions.filter(pendingQuestion).length,
      omittedRejections: history.rejected.filter(row => !row.consumedBy).length - Math.min(turnLimit, history.rejected.filter(row => !row.consumedBy).length),
    },
    rejectedActions: history.rejected.filter(row => !row.consumedBy).slice(-turnLimit),
    questions: selectedQuestions, cards: selectedCards,
    routines: [...routines],
  };
  const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');
  const frame = handoffFrameBytes(rows.length);
  const cross = fit.request !== undefined;
  // The notice that `history` can add counts in `maxBytes`. A Cross-Bot Turn holds the `history` key and frame there too.
  const notice = utf8(`${HISTORY_OMITTED_NOTICE} `), key = utf8(',"history":');
  const fitted = fitHistory(context, [], fit.request ?? (separateRequest ? current!.request : ''), fit.background && [...fit.background, context.routines],
    notice + (cross ? key + frame : 0));
  const window = fitted.historyWindow;
  // Required metadata can leave less than the frame. `metadataOverBudget` reports that, and it does not block.
  const totalBytes = cross ? Math.max(frame, Math.min(handoff.totalBytes, maxBytes - window.currentRequestBytes - utf8(JSON.stringify(fitted)) - notice - key))
    : handoff.totalBytes;
  const pack = buildHandoffPack(rows, { ...handoff, totalBytes });
  if (pack.omittedTurns > 0 && !window.notice?.startsWith(HISTORY_OMITTED_NOTICE)) {
    window.notice = [HISTORY_OMITTED_NOTICE, window.notice].filter(Boolean).join(' ');
  }
  return { ...fitted, history: pack };
}
