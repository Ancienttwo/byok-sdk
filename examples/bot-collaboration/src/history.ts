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
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  const pool = (values: unknown[], counter: 'omittedRejections' | typeof kind) => {
    const sizes = values.map(bytes);
    return { values, counter, sizes, extra: sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, values.length - 1) };
  };
  // New room/private messages take priority over older policy feedback.
  const pools = [pool(context.rejectedActions, 'omittedRejections'), pool(history, kind)];
  // Serialize required metadata once. Empty arrays and object each contribute
  // two bytes; pool.extra and bytes(window)-2 account for their full values.
  const base = Buffer.byteLength(JSON.stringify(context, (_key, value) =>
    value === history || value === context.rejectedActions ? [] : value === window ? {} : value), 'utf8');
  const notice = () => {
    window.notice = window.omittedMessages + window.omittedTurns + window.omittedRejections > 0
      ? 'Earlier history was omitted.' : null;
  };
  const overBudget = () => base + pools.reduce((sum, row) => sum + row.extra, 0) + bytes(window) - 2 > window.maxBytes;
  notice();
  for (const row of pools) {
    while (row.values.length && overBudget()) {
      const size = row.sizes.shift()!;
      row.values.shift();
      row.extra -= size + (row.values.length ? 1 : 0);
      window[row.counter]++;
      notice();
    }
  }
  if (overBudget()) {
    window.metadataOverBudget = true;
    window.notice = [window.notice, 'Required non-history context exceeds the budget; no authority data was removed.'].filter(Boolean).join(' ');
  }
  return context;
}
