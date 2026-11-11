import type { MethodHandlers, MethodTable } from './domain.ts';
import type { BridgeOutcome } from './protocol.ts';

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

/**
 * Settles one routed call as a {@link BridgeOutcome}. A refusal keeps the code its error carries (a `BridgeError`, a
 * custody or keys error); an error without one is `method_failed`.
 */
export async function settleCall(call: () => Promise<unknown>): Promise<BridgeOutcome> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { ok: false, code: typeof code === 'string' ? code : 'method_failed', message: typeof message === 'string' ? message : String(error) };
  }
}
