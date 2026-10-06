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
  let resultRevision = 0;
  const resultWaiters = new Set<(received: boolean) => void>();
  let pending:
    | {
        id: string;
        subtype: 'initialize' | 'interrupt';
        promise: Promise<boolean>;
        settle: (accepted: boolean) => void;
      }
    | undefined;
  const requestControl = (subtype: 'initialize' | 'interrupt', deadline: number): Promise<boolean> => {
    if (ended || !write) return Promise.resolve(false);
    if (pending) return pending.subtype === subtype ? pending.promise : Promise.resolve(false);
    const id = randomUUID();
    let resolve!: (accepted: boolean) => void;
    const promise = new Promise<boolean>((complete) => { resolve = complete; });
    const timer = setTimeout(() => settle(false), deadline);
    const settle = (accepted: boolean) => {
      if (pending?.id !== id) return;
      clearTimeout(timer);
      pending = undefined;
      resolve(accepted);
    };
    pending = { id, subtype, promise, settle };
    void write({
      type: 'control_request', request_id: id,
      request: subtype === 'initialize' ? { subtype, hooks: null } : { subtype },
    }).catch(() => settle(false));
    return promise;
  };
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
      if (message.type === 'result') {
        contextWindow = parseClaudeContextWindow(message.modelUsage, initModel);
        resultRevision += 1;
        for (const resolve of resultWaiters) resolve(true);
      }
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
      for (const resolve of resultWaiters) resolve(false);
    },
    /** Complete the SDK stdio handshake before the first user frame. */
    initialize(): Promise<boolean> { return requestControl('initialize', 60_000); },
    interrupt(): Promise<boolean> { return requestControl('interrupt', timeoutMs); },
    /** ACK and final result share the existing interrupt deadline. */
    async interruptAndSettle(): Promise<boolean> {
      const revision = resultRevision;
      let resolveResult!: (received: boolean) => void;
      const result = new Promise<boolean>(resolve => { resolveResult = resolve; });
      resultWaiters.add(resolveResult);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.interrupt().then(async accepted => accepted && (resultRevision > revision || await result)),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        resultWaiters.delete(resolveResult);
      }
    },
  };
}
