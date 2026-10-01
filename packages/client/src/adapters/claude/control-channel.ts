import { randomUUID } from 'node:crypto';
import type { ClaudeStreamMessage } from './events';

export function parseClaudeContextWindow(
  modelUsage: unknown,
  initModel?: string,
): number | null {
  if (
    !modelUsage ||
    typeof modelUsage !== 'object' ||
    Array.isArray(modelUsage)
  )
    return null;
  const windows = new Set<number>();
  for (const [model, value] of Object.entries(modelUsage)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const window = (value as { contextWindow?: unknown }).contextWindow;
    if (
      typeof window !== 'number' ||
      !Number.isSafeInteger(window) ||
      window <= 0
    )
      continue;
    if (model === initModel) return window;
    windows.add(window);
  }
  return windows.size === 1 ? [...windows][0]! : null;
}

/** One correlated control request at a time; separate from the user/result event queue. */
export function createClaudeControlChannel(timeoutMs: number) {
  let write: ((frame: Record<string, unknown>) => Promise<void>) | undefined;
  let ended = false;
  let initModel: string | undefined;
  let contextWindow: number | null = null;
  let pending:
    | {
        id: string;
        promise: Promise<boolean>;
        settle: (accepted: boolean) => void;
      }
    | undefined;
  return {
    get contextWindow() {
      return contextWindow;
    },
    bind(sender: (frame: Record<string, unknown>) => Promise<void>) {
      write = sender;
    },
    receive(message: ClaudeStreamMessage) {
      if (
        message.type === 'system' &&
        message.subtype === 'init' &&
        typeof message.model === 'string'
      )
        initModel = message.model;
      if (message.type === 'result')
        contextWindow = parseClaudeContextWindow(message.modelUsage, initModel);
      if (
        message.type !== 'control_response' ||
        !message.response ||
        typeof message.response !== 'object'
      )
        return;
      const response = message.response as {
        request_id?: unknown;
        subtype?: unknown;
      };
      if (response.request_id === pending?.id)
        pending?.settle(response.subtype === 'success');
    },
    closed() {
      ended = true;
      pending?.settle(false);
    },
    interrupt(): Promise<boolean> {
      if (ended || !write) return Promise.resolve(false);
      if (pending) return pending.promise;
      const id = randomUUID();
      let resolve!: (accepted: boolean) => void;
      const promise = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      const timer = setTimeout(() => pending?.settle(false), timeoutMs);
      const settle = (accepted: boolean) => {
        if (pending?.id !== id) return;
        clearTimeout(timer);
        pending = undefined;
        resolve(accepted);
      };
      pending = { id, promise, settle };
      void write({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'interrupt' },
      }).catch(() => settle(false));
      return promise;
    },
  };
}
