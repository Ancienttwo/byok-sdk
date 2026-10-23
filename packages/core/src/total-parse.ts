/**
 * A zod parse that never throws.
 *
 * `safeParse` returns a failure for invalid data, but it does not catch an
 * error that a getter or a proxy trap throws while zod reads the value, and a
 * revoked proxy throws on any read. A receiver that promises a typed result
 * for hostile input, or a typed error for bad caller input, parses through
 * this. Wire input from `JSON.parse` cannot hold getters or proxies; this
 * closes the same gap for in-process callers.
 */
import type { z } from 'zod';

export type TotalParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error?: z.ZodError };

/** `schema.safeParse(value)`, with a throw while reading `value` as a failure without issues. */
export function safeParseTotal<S extends z.ZodType>(schema: S, value: unknown): TotalParseResult<z.output<S>> {
  try {
    return schema.safeParse(value);
  } catch {
    return { success: false };
  }
}
