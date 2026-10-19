import type { Card, Question } from './model';

export const HISTORY_MAX_BYTES = 32 * 1024;
export const HISTORY_MAX_ITEMS = 100;
export interface HistoryWindow {
  turnLimit: number; maxBytes: number; omittedMessages: number; omittedTurns: number;
  omittedCards: number; omittedQuestions: number; omittedPendingCards: number; omittedPendingQuestions: number;
  omittedRejections: number; currentRequestBytes: number; metadataOverBudget: boolean; notice: string | null;
  /** Cross-Bot Turns only: omitted team notes, rooms and routines. */
  omittedBackground?: number;
}
export function historyWindow(kind: 'messages' | 'turns', omitted = 0, turnLimit = HISTORY_MAX_ITEMS, maxBytes = HISTORY_MAX_BYTES): HistoryWindow {
  return { turnLimit, maxBytes, omittedMessages: kind === 'messages' ? omitted : 0,
    omittedTurns: kind === 'turns' ? omitted : 0, omittedCards: 0, omittedQuestions: 0,
    omittedPendingCards: 0, omittedPendingQuestions: 0,
    omittedRejections: 0, currentRequestBytes: 0, metadataOverBudget: false, notice: null };
}
export class CurrentRequestTooLargeError extends Error {}
/**
 * Reserve the frozen Request bytes, then trim copied history arrays only.
 * `background` arrays (copies) are trimmed oldest first after history.
 */
export function fitHistory<T extends { historyWindow: HistoryWindow; rejectedActions: unknown[]; cards?: Card[]; questions?: Question[] }>(
  context: T, history: unknown[], kind: 'omittedMessages' | 'omittedTurns', request: string, keepCandidate = false,
  background: unknown[][] = [],
): T {
  const window = context.historyWindow;
  const requestBytes = Buffer.byteLength(request, 'utf8');
  if (requestBytes > window.maxBytes) {
    throw new CurrentRequestTooLargeError(`Current Request is ${requestBytes} UTF-8 bytes; budget is ${window.maxBytes} bytes. Shorten the request and send it again.`);
  }
  window.currentRequestBytes = requestBytes;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  type Counter = 'omittedRejections' | 'omittedCards' | 'omittedQuestions' | 'omittedBackground' | typeof kind;
  const pool = (values: unknown[], counter: Counter, pending = (_value: unknown) => false,
    pendingCounter?: 'omittedPendingCards' | 'omittedPendingQuestions') => {
    const sizes = values.map(bytes);
    return { values, counter, pending, pendingCounter, sizes, extra: sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, values.length - 1) };
  };
  const refusals = pool(context.rejectedActions, 'omittedRejections');
  const cards = pool(context.cards ?? [], 'omittedCards', row => (row as Card).state === 'pending', 'omittedPendingCards');
  const questions = pool(context.questions ?? [], 'omittedQuestions', row => (row as Question).answer === undefined, 'omittedPendingQuestions');
  const messages = pool(history, kind);
  const extras = background.map(values => pool(values, 'omittedBackground'));
  if (background.length) window.omittedBackground = 0;
  const pools = [refusals, cards, questions, messages, ...extras];
  // Measure required metadata once. Each optional row is encoded once.
  const base = requestBytes + Buffer.byteLength(JSON.stringify(context, (_key, value) =>
    pools.some(row => value === row.values) ? [] : value === window ? {} : value), 'utf8');
  const notice = () => {
    window.notice = window.omittedMessages + window.omittedTurns + window.omittedRejections + window.omittedCards + window.omittedQuestions
      + (window.omittedBackground ?? 0) > 0
      ? 'Earlier history was omitted.' : null;
  };
  const overBudget = () => base + pools.reduce((sum, row) => sum + row.extra, 0) + bytes(window) - 2 > window.maxBytes;
  const remove = (row: ReturnType<typeof pool>) => {
    const value = row.values.shift();
    row.extra -= row.sizes.shift()! + (row.values.length ? 1 : 0);
    window[row.counter] = (window[row.counter] ?? 0) + 1;
    if (row.pendingCounter && row.pending(value)) window[row.pendingCounter]++;
    notice();
  };
  notice();
  // Keep pending work after settled items and older messages have been removed.
  for (const row of [refusals, cards, questions]) {
    while (row.values.length && !row.pending(row.values[0]) && overBudget()) remove(row);
  }
  while (messages.values.length > (keepCandidate ? 1 : 0) && overBudget()) remove(messages);
  for (const row of extras) while (row.values.length && overBudget()) remove(row);
  for (const row of [cards, questions]) while (row.values.length && overBudget()) remove(row);
  if (overBudget()) {
    window.metadataOverBudget = true;
    window.notice = [window.notice, 'Required non-history context exceeds the remaining Request budget; no authority data was removed.'].filter(Boolean).join(' ');
  }
  return context;
}
