import { types as utilTypes } from 'node:util';

/**
 * One definition of "inert plain data" for values a host hands the SDK
 * (provisioning readbacks, public options, requests). A value is copied ONCE,
 * reading each property exactly once through its own data descriptor, so no
 * getter, setter, Proxy trap, `toJSON` or prototype can run after the copy or
 * change a value between its check and its use.
 *
 * Every refusal throws {@link PLAIN_DATA_REJECTED}, a symbol that carries no
 * message or cause; callers map any throw from here to their own closed code.
 * A Proxy at any level is refused before any of its traps runs.
 */
export const PLAIN_DATA_REJECTED: unique symbol = Symbol('plain data rejected');

export interface PlainDataSnapshotOptions {
  /** Objects/arrays nested deeper than this are refused. */
  readonly maxDepth: number;
  /** Accept `undefined` leaves (optional option fields). JSON-shaped callers leave this off. */
  readonly allowUndefined?: boolean;
  /**
   * Accept an exact `Uint8Array` (not a subclass, not a Proxy) and copy its
   * bytes through the intrinsic typed-array accessors, so an own property
   * shadowing `buffer`/`byteOffset`/`byteLength` is never consulted.
   */
  readonly allowBytes?: boolean;
  /** Accept a non-Proxy function as an opaque leaf (never traversed). */
  readonly allowFunctions?: boolean;
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
function intrinsicGetter(name: string): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, name)?.get;
  if (getter === undefined) throw new Error(`typed array intrinsic ${name} is unavailable`);
  return getter;
}
const typedArrayBuffer = intrinsicGetter('buffer');
const typedArrayByteOffset = intrinsicGetter('byteOffset');
const typedArrayByteLength = intrinsicGetter('byteLength');

function copyBytes(value: Uint8Array): Uint8Array {
  const buffer = typedArrayBuffer.call(value);
  const offset = typedArrayByteOffset.call(value) as number;
  const length = typedArrayByteLength.call(value) as number;
  if (!utilTypes.isArrayBuffer(buffer)) throw PLAIN_DATA_REJECTED;
  const copy = new Uint8Array(length);
  // Both views are over real ArrayBuffers: `set` reads internal slots only.
  copy.set(new Uint8Array(buffer, offset, length));
  return copy;
}

/** Copy `value` into inert plain data or throw {@link PLAIN_DATA_REJECTED}. */
export function snapshotPlainData(value: unknown, options: PlainDataSnapshotOptions): unknown {
  return snapshot(value, options, 0);
}

function snapshot(value: unknown, options: PlainDataSnapshotOptions, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) {
    if (options.allowUndefined === true) return undefined;
    throw PLAIN_DATA_REJECTED;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw PLAIN_DATA_REJECTED;
    return value;
  }
  if (typeof value === 'function') {
    if (options.allowFunctions === true && !utilTypes.isProxy(value)) return value;
    throw PLAIN_DATA_REJECTED;
  }
  if (typeof value !== 'object' || depth >= options.maxDepth) throw PLAIN_DATA_REJECTED;
  // A Proxy is not plain data: refuse it before any trap can run.
  if (utilTypes.isProxy(value)) throw PLAIN_DATA_REJECTED;
  if (options.allowBytes === true && utilTypes.isUint8Array(value)) {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw PLAIN_DATA_REJECTED;
    return copyBytes(value as Uint8Array);
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw PLAIN_DATA_REJECTED;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) throw PLAIN_DATA_REJECTED;
  if (isArray) {
    const lengthDescriptor = descriptors['length'];
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
      throw PLAIN_DATA_REJECTED;
    }
    const length = lengthDescriptor.value;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw PLAIN_DATA_REJECTED;
      out.push(snapshot(descriptor.value, options, depth + 1));
    }
    if (Object.keys(descriptors).length !== length + 1) throw PLAIN_DATA_REJECTED;
    return out;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor) || descriptor.enumerable !== true) throw PLAIN_DATA_REJECTED;
    out[key] = snapshot(descriptor.value, options, depth + 1);
  }
  return out;
}

/**
 * Read exactly the named own DATA properties of a plain object, once each,
 * as primitives (`string`, finite `number`, `boolean`, `null`); an absent or
 * `undefined` property is `undefined`. Other properties are never read, so a
 * host may pass a larger configuration object. A Proxy, a non-plain
 * prototype, an accessor on a named key, or a non-primitive value throws
 * {@link PLAIN_DATA_REJECTED}.
 */
export function pickPlainDataProperties<K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) throw PLAIN_DATA_REJECTED;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw PLAIN_DATA_REJECTED;
  const out = Object.create(null) as Record<K, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      out[key] = undefined;
      continue;
    }
    if (!('value' in descriptor)) throw PLAIN_DATA_REJECTED;
    const field: unknown = descriptor.value;
    if (field !== undefined && field !== null && typeof field !== 'string' && typeof field !== 'boolean' &&
        !(typeof field === 'number' && Number.isFinite(field))) {
      throw PLAIN_DATA_REJECTED;
    }
    out[key] = field;
  }
  return out;
}
