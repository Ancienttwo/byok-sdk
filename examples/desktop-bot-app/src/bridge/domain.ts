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
 * `M` itself when every method is named `<prefix>.<verb>`, `never` otherwise,
 * so an interface extending it fails to compile. Distinct prefixes keep two
 * domains, and the core methods, from declaring the same name.
 */
export type Prefixed<M, P extends string> = keyof M extends `${P}.${string}` ? M : never;

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

/** The intersection of a tuple of handler maps: what {@link joinHandlers} returns. */
export type Joined<T extends readonly object[]> = T extends readonly [infer Head, ...infer Rest extends readonly object[]] ? Head & Joined<Rest> : unknown;

/**
 * Joins handler maps. A method two maps answer refuses the composition: no
 * handler silently replaces another, the core `status` included. The result
 * keeps every map's type, so assigning it to a complete handler type checks at
 * compile time that no method lacks a handler.
 */
export function joinHandlers<T extends readonly object[]>(...maps: T): Joined<T> {
  const joined: Record<string, (params: unknown) => unknown> = {};
  for (const map of maps) {
    for (const [name, handler] of Object.entries(map)) {
      if (Object.hasOwn(joined, name)) throw new Error(`Bridge method ${name} has two handlers`);
      joined[name] = handler as (params: unknown) => unknown;
    }
  }
  return joined as Joined<T>;
}
