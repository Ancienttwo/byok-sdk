/**
 * The shape every bridge domain module (`src/bridge/domains/*.ts`) declares.
 * A domain names its methods `<domain>.<verb>`, lists which of them the
 * renderer may call, and which of those main answers itself instead of the
 * Host. `protocol.ts` composes the domains; a domain never edits it.
 */

/** One bridge method: what the caller sends and what it gets back. */
export interface MethodSpec { readonly params: unknown; readonly result: unknown }

/** A domain's methods: an interface whose every member is a {@link MethodSpec}. */
export type MethodTable<M> = { readonly [K in keyof M]: MethodSpec };

/**
 * The renderer allowlist of one domain. `renderer` methods are forwarded to the
 * Host; `main` methods are answered by main and never reach the Host. A method
 * in neither list is reachable only from main's own code.
 */
export interface BridgeDomain<M extends MethodTable<M>> {
  readonly renderer: readonly (keyof M & string)[];
  readonly main: readonly (keyof M & string)[];
}

/**
 * The handlers that answer a set of methods. Params arrive unvalidated: the
 * handler owns the data boundary and refuses bad params with a `BridgeError`
 * (`invalid_params`).
 */
export type MethodHandlers<M extends MethodTable<M>> = {
  readonly [K in keyof M]: (params: unknown) => M[K]['result'] | Promise<M[K]['result']>;
};
