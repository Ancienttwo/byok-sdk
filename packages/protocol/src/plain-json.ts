/**
 * Plain-JSON-data canonicalization shared by every bounded JSON channel of
 * the wire: `task.complete.document` (`checkResultDocument`, messages.ts) and
 * the result-document schema and outcome (`result-schema.ts`). One rule, one
 * implementation, so the channels cannot disagree about what "plain JSON
 * data" means or how its canonical UTF-8 size is measured.
 *
 * Zod-free and free of node builtins.
 */

/** Outcome of {@link canonicalizePlainJson} without a depth bound. */
export type PlainJsonCheck =
  | { readonly ok: true; readonly bytes: number; readonly canonical: unknown }
  | { readonly ok: false; readonly reason: 'not-serializable' }
  | { readonly ok: false; readonly reason: 'over-cap'; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'not-plain-json' };

/** Outcome of {@link canonicalizePlainJson} with a container-nesting bound. */
export type BoundedPlainJsonCheck =
  | PlainJsonCheck
  | { readonly ok: false; readonly reason: 'too-deep'; readonly bytes: number };

/**
 * Structural equality between a value and its own JSON round trip, written
 * out by hand (no node builtins — this package deliberately has none) over
 * exactly the three shapes pure JSON data can take.
 *
 * The asymmetry is the point: `a` is the CALLER's object, which may contain
 * anything JavaScript allows, while `b` is always the output of
 * `JSON.parse` — pure data. So every case where `a` is something JSON cannot
 * represent (a `Date`, a function, `undefined`, `NaN`, a symbol, a getter
 * that answers differently the second time, an object whose `toJSON` rewrote
 * it) shows up here as a shape or value mismatch against `b`, and is
 * rejected. `NaN !== NaN` falls out of strict equality for free, which is
 * exactly what we want: `NaN` serializes to `null`, so it is not
 * representable and must not pass.
 *
 * The one case structural comparison alone cannot see — an object whose data
 * lives somewhere other than its own enumerable string keys, e.g. a
 * populated `Map` — gets its own explicit rejection in the object branch
 * below.
 */
function isSameJsonData(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;

  const typeOfA = typeof a;
  if (typeOfA !== typeof b) return false;

  if (typeOfA !== 'object') {
    // string | number | boolean. Anything else (function, symbol, bigint,
    // undefined) can never equal a JSON.parse output, and `NaN === NaN` is
    // false, so this single comparison covers every primitive case.
    return a === b;
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const arrayA = a as unknown[];
    const arrayB = b as unknown[];
    if (arrayA.length !== arrayB.length) return false;
    for (let index = 0; index < arrayA.length; index += 1) {
      if (!isSameJsonData(arrayA[index], arrayB[index])) return false;
    }
    return true;
  }

  const objectA = a as Record<string, unknown>;
  const objectB = b as Record<string, unknown>;
  const keysA = Object.keys(objectA); // own enumerable string keys
  const keysB = Object.keys(objectB);

  // An object whose data does NOT live in its own enumerable string keys is
  // invisible to both `JSON.stringify` and the key comparison below — a
  // populated `Map`/`Set` serializes to `{}` and would otherwise compare
  // EQUAL to that `{}`, delivering an empty document as the task's truthful
  // structured result. That is the same silent-wrong-output class the whole
  // plain-data contract exists to stop, so a container-shaped value with no
  // own enumerable string keys and a non-plain prototype is rejected here.
  // Applied at every object node (this function recurses), so a nested
  // `Map`/`Set`/exotic instance dies exactly like a top-level one.
  //
  // The boundary this deliberately draws: a class instance WITH own
  // enumerable fields still passes, because its data really is in those
  // fields and survives the round trip intact. A class whose values come
  // from PROTOTYPE-level getters does not — those are invisible to JSON, so
  // such an instance is not plain JSON data and is outside this contract by
  // definition (docs/protocol.md §7.2). `Object.create(null)` is explicitly
  // fine: a null prototype is plain data, just without `Object.prototype`.
  if (keysA.length === 0) {
    const prototypeA: unknown = Object.getPrototypeOf(objectA);
    if (prototypeA !== Object.prototype && prototypeA !== null) return false;
  }

  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objectB, key)) return false;
    if (!isSameJsonData(objectA[key], objectB[key])) return false;
  }
  return true;
}

/**
 * Container nesting depth of pure JSON data (a `JSON.parse` output), computed
 * iteratively so no input can exhaust the call stack. A scalar is depth 0,
 * `{}` and `[]` are depth 1. Stops as soon as `limit` is exceeded.
 */
export function jsonDepthExceeds(value: unknown, limit: number): boolean {
  const stack: { readonly node: unknown; readonly depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    const next = depth + 1;
    if (next > limit) return true;
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) stack.push({ node: child, depth: next });
  }
  return false;
}

/**
 * Canonicalize `value` as plain JSON data within `maxBytes` canonical UTF-8
 * bytes:
 *
 *   1. `JSON.stringify` must succeed and not return `undefined`.
 *   2. Its UTF-8 byte length must be at most `maxBytes`.
 *   3. `JSON.parse` that string: the CANONICAL SNAPSHOT (pure data).
 *   4. With `maxDepth`, the snapshot's container nesting must be at most
 *      `maxDepth`. This runs before step 5, so the recursive comparison
 *      below is bounded by it.
 *   5. The original must be structurally equal to the snapshot
 *      (`isSameJsonData`).
 *
 * On success a sender uses `canonical`, never the original reference.
 */
export function canonicalizePlainJson(value: unknown, maxBytes: number): PlainJsonCheck;
export function canonicalizePlainJson(value: unknown, maxBytes: number, maxDepth: number): BoundedPlainJsonCheck;
export function canonicalizePlainJson(value: unknown, maxBytes: number, maxDepth?: number): BoundedPlainJsonCheck {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { ok: false, reason: 'not-serializable' };
  }
  if (json === undefined) return { ok: false, reason: 'not-serializable' };

  const bytes = new TextEncoder().encode(json).length;
  if (bytes > maxBytes) return { ok: false, reason: 'over-cap', bytes };

  const canonical: unknown = JSON.parse(json);
  if (maxDepth !== undefined && jsonDepthExceeds(canonical, maxDepth)) return { ok: false, reason: 'too-deep', bytes };
  if (!isSameJsonData(value, canonical)) return { ok: false, reason: 'not-plain-json' };

  return { ok: true, bytes, canonical };
}
