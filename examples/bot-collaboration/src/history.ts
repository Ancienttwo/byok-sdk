export const HISTORY_MAX_BYTES = 65_536;
export const HISTORY_MAX_ITEMS = 100;
export interface HistoryWindow {
  limit: number; maxBytes: number; omittedMessages: number; omittedTurns: number;
  omittedRejections: number; metadataOverBudget: boolean; notice: string | null;
}
export function historyWindow(kind: 'messages' | 'turns', omitted = 0): HistoryWindow {
  return { limit: HISTORY_MAX_ITEMS, maxBytes: HISTORY_MAX_BYTES,
    omittedMessages: kind === 'messages' ? omitted : 0, omittedTurns: kind === 'turns' ? omitted : 0,
    omittedRejections: 0, metadataOverBudget: false, notice: null };
}
/** Trim copied history arrays only. The Host freezes the current Request separately. */
export function fitHistory<T extends { historyWindow: HistoryWindow; rejectedActions: unknown[] }>(
  context: T, history: unknown[], kind: 'omittedMessages' | 'omittedTurns',
): T {
  const window = context.historyWindow;
  const notice = () => {
    window.notice = window.omittedMessages + window.omittedTurns + window.omittedRejections > 0
      ? 'Earlier history was omitted. The current request is provided separately and remains unchanged.' : null;
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(context), 'utf8');
  notice();
  while (history.length && bytes() > window.maxBytes) { history.shift(); window[kind]++; notice(); }
  while (context.rejectedActions.length && bytes() > window.maxBytes) {
    context.rejectedActions.shift(); window.omittedRejections++; notice();
  }
  if (bytes() > window.maxBytes) {
    window.metadataOverBudget = true;
    window.notice = 'Required non-history context exceeds the budget; no authority data was removed. The current request remains unchanged.';
  }
  return context;
}
