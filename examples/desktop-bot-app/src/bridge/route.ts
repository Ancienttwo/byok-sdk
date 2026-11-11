import type { MethodHandlers, MethodTable } from './domain.ts';
import { CustodyError } from '../custody/protocol.ts';
import { BridgeError, type BridgeOutcome } from './protocol.ts';

export interface RendererRoutes<M extends MethodTable<M>, Main extends keyof M & string> {
  /** Every method the renderer may call. */
  readonly allowed: readonly (keyof M & string)[];
  /** The allowed methods main answers itself; they never reach the Host. */
  readonly main: MethodHandlers<Pick<M, Main>>;
  /** Forwards an allowed method to the Host. */
  readonly host: (method: keyof M & string, params: unknown) => Promise<unknown>;
}

/**
 * Main's routing of one renderer call: a method outside the allowlist is
 * refused, a main method is answered in main, and every other allowed method
 * goes to the Host, which validates its params.
 */
export function createRendererRouter<M extends MethodTable<M>, Main extends keyof M & string>(routes: RendererRoutes<M, Main>) {
  return (method: unknown, params: unknown): Promise<unknown> => {
    if (typeof method !== 'string' || !(routes.allowed as readonly string[]).includes(method)) throw new Error('bridge_method_refused');
    const own = Object.hasOwn(routes.main, method) ? (routes.main as Record<string, (params: unknown) => unknown>)[method] : undefined;
    return own ? Promise.resolve(own(params)) : routes.host(method as keyof M & string, params);
  };
}

/** The app's own refusals: their codes (bridge, custody and keys) are the ones the renderer may branch on. */
export const isAppRefusal = (error: unknown): error is BridgeError | CustodyError => error instanceof BridgeError || error instanceof CustodyError;

/**
 * Settles one routed call as a {@link BridgeOutcome}. A refusal keeps its code only when `coded` recognizes the error as
 * one of the app's own (main passes {@link isAppRefusal}); anything else, a Node or Electron error with its
 * own `code` or a thrown non-error included, is `method_failed` with its message.
 */
export async function settleCall(
  call: () => Promise<unknown>,
  coded: (error: unknown) => error is { readonly code: string; readonly message: string },
): Promise<BridgeOutcome> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (coded(error)) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'method_failed', message: error instanceof Error ? error.message : String(error) };
  }
}
