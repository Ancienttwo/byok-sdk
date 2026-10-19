/**
 * Result-document schema subset (wire v3, docs/protocol.md §7.2).
 *
 * A `terminalProjection.mode: 'result-document'` offer freezes one JSON
 * Schema for the task's structured outcome. This module owns the two checks
 * every party applies to it:
 *
 * - {@link checkResultSchema}: the admission guard. It decides whether a
 *   candidate schema is inside the subset this SDK accepts. It is ours, and
 *   it is the only admission authority: the instance validator below never
 *   sees a schema the guard did not admit.
 * - {@link validateResultOutcome}: re-runs the guard, bounds the outcome,
 *   then validates the outcome against the admitted schema with
 *   `@cfworker/json-schema` (draft 2020-12, interpreted; no code generation).
 *
 * The subset (PRD §8.3): `type`, `properties`, `required`,
 * `additionalProperties` (only `false`), `items`, `enum`, `const`, `oneOf`,
 * `minLength`, `maxLength`, `minItems`, `maxItems`, `minimum`, `maximum`,
 * `description`. Every other keyword is refused, so `$ref`, `pattern`,
 * `format` and the other draft 2020-12 vocabularies are unreachable in the
 * library. The root must be `type: 'object'`; root `oneOf` is allowed.
 *
 * Zod-free and free of node builtins.
 */
import { Validator, type OutputUnit } from '@cfworker/json-schema';
import { canonicalizePlainJson, type BoundedPlainJsonCheck } from './plain-json';

/** Maximum canonical JSON UTF-8 size of a result-document schema. */
export const RESULT_SCHEMA_MAX_BYTES = 16_384;
/** Maximum canonical JSON UTF-8 size of a submitted outcome document. */
export const RESULT_OUTCOME_MAX_BYTES = 65_536;
/**
 * Maximum subschema nesting below the root (each `properties` member, `items`
 * and `oneOf` branch is one level). With the 16 KiB cap this bounds how much
 * schema structure one validation walks.
 */
export const RESULT_SCHEMA_MAX_DEPTH = 32;
/**
 * Maximum JSON container nesting of a schema or outcome document, checked
 * iteratively before any recursive routine runs on it.
 */
export const RESULT_JSON_MAX_DEPTH = 128;
/** Maximum number of issues one failed check reports. */
export const RESULT_ISSUES_MAX_COUNT = 20;
/** Maximum UTF-8 size of the reported issue list, as JSON. */
export const RESULT_ISSUES_MAX_BYTES = 4_096;
/**
 * Pointer, keyword and message strings in an issue are cut to this many UTF-16
 * units. Even fully `\u`-escaped, one issue then fits the byte cap, so a
 * failure always reports at least one issue.
 */
const ISSUE_STRING_MAX_LENGTH = 128;

export const RESULT_SCHEMA_KEYWORDS = Object.freeze([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'description',
] as const);
export type ResultSchemaKeyword = (typeof RESULT_SCHEMA_KEYWORDS)[number];

export const RESULT_SCHEMA_INSTANCE_TYPES = Object.freeze([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const);
export type ResultSchemaInstanceType = (typeof RESULT_SCHEMA_INSTANCE_TYPES)[number];

/** A schema inside the admitted subset. Only {@link checkResultSchema} proves a value is one. */
export interface ResultSchema {
  readonly type?: ResultSchemaInstanceType | readonly ResultSchemaInstanceType[];
  readonly properties?: { readonly [name: string]: ResultSchema };
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: ResultSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly oneOf?: readonly ResultSchema[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

/**
 * One bounded failure detail. `pointer` is an RFC 6901 JSON Pointer into the
 * checked document: the schema for admission issues, the outcome for
 * validation issues (`''` is the document root). `keyword` is the JSON Schema
 * keyword at fault, or a document-level code: `not-serializable`,
 * `not-plain-json`, `over-cap`, `too-deep` (JSON nesting), `schema` (a
 * subschema that is not an object) or `depth` (subschema nesting).
 */
export interface ResultIssue {
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
}

/** Document-level failure shared by the schema and outcome checks. */
export type ResultDocumentFailureReason = 'not-serializable' | 'not-plain-json' | 'over-cap' | 'too-deep';

interface ResultFailure<Reason extends string> {
  readonly ok: false;
  readonly reason: Reason;
  /** Canonical UTF-8 size, when it was measured. */
  readonly bytes?: number;
  /** At least one issue; at most {@link RESULT_ISSUES_MAX_COUNT} and {@link RESULT_ISSUES_MAX_BYTES}. */
  readonly issues: readonly ResultIssue[];
  /** True when issues were dropped to respect the caps. */
  readonly truncated: boolean;
}

export type ResultSchemaCheck =
  | { readonly ok: true; readonly bytes: number; readonly canonical: ResultSchema }
  | ResultFailure<ResultDocumentFailureReason | 'not-subset'>;

export type ResultOutcomeCheck =
  | { readonly ok: true; readonly bytes: number; readonly canonical: unknown }
  | ResultFailure<'schema-not-admitted' | ResultDocumentFailureReason | 'schema-mismatch'>;

const KEYWORDS = new Set<string>(RESULT_SCHEMA_KEYWORDS);
const INSTANCE_TYPES = new Set<string>(RESULT_SCHEMA_INSTANCE_TYPES);
const encoder = new TextEncoder();

function cut(value: string): string {
  return value.length <= ISSUE_STRING_MAX_LENGTH ? value : `${value.slice(0, ISSUE_STRING_MAX_LENGTH - 1)}…`;
}

/** Collects issues under the count and byte caps. */
class IssueSink {
  readonly issues: ResultIssue[] = [];
  truncated = false;
  private bytes = 2; // "[]"

  add(pointer: string, keyword: string, message: string): void {
    const issue: ResultIssue = { pointer: cut(pointer), keyword: cut(keyword), message: cut(message) };
    const size = encoder.encode(JSON.stringify(issue)).length + (this.issues.length === 0 ? 0 : 1);
    if (this.issues.length >= RESULT_ISSUES_MAX_COUNT || this.bytes + size > RESULT_ISSUES_MAX_BYTES) {
      this.truncated = true;
      return;
    }
    this.issues.push(issue);
    this.bytes += size;
  }

  get empty(): boolean {
    return this.issues.length === 0 && !this.truncated;
  }
}

function pointerTo(base: string, token: string | number): string {
  return `${base}/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * True when any string or property name in pure JSON data is not well-formed
 * Unicode. A lone surrogate has no UTF-8 encoding, so the measured canonical
 * size would not describe it, and the library cannot build a pointer to it.
 * Iterative; the caller has already bounded the nesting depth.
 */
function hasLoneSurrogate(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (LONE_SURROGATE.test(node)) return true;
    } else if (Array.isArray(node)) {
      for (const member of node) stack.push(member);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, member] of Object.entries(node)) {
        if (LONE_SURROGATE.test(key)) return true;
        stack.push(member);
      }
    }
  }
  return false;
}

/** Canonical plain JSON within the byte and depth caps, in well-formed Unicode. */
function canonicalDocument(value: unknown, maxBytes: number): BoundedPlainJsonCheck {
  const check = canonicalizePlainJson(value, maxBytes, RESULT_JSON_MAX_DEPTH);
  if (check.ok && hasLoneSurrogate(check.canonical)) return { ok: false, reason: 'not-plain-json' };
  return check;
}

function documentFailure(
  check: Exclude<BoundedPlainJsonCheck, { ok: true }>,
  what: string,
  maxBytes: number,
): ResultFailure<ResultDocumentFailureReason> {
  const sink = new IssueSink();
  switch (check.reason) {
    case 'not-serializable':
      sink.add('', check.reason, `${what} is not JSON-serializable`);
      return { ok: false, reason: check.reason, issues: sink.issues, truncated: false };
    case 'not-plain-json':
      sink.add('', check.reason, `${what} is not plain JSON data in well-formed Unicode`);
      return { ok: false, reason: check.reason, issues: sink.issues, truncated: false };
    case 'over-cap':
      sink.add('', check.reason, `${what} is ${check.bytes} bytes as canonical JSON (UTF-8); the cap is ${maxBytes}`);
      return { ok: false, reason: check.reason, bytes: check.bytes, issues: sink.issues, truncated: false };
    case 'too-deep':
      sink.add('', check.reason, `${what} nests JSON containers deeper than ${RESULT_JSON_MAX_DEPTH}`);
      return { ok: false, reason: check.reason, bytes: check.bytes, issues: sink.issues, truncated: false };
  }
}

/** Walks one subschema of an already-canonical (pure JSON) document. */
function checkSubschema(node: unknown, pointer: string, depth: number, sink: IssueSink, requireObjectRoot = true): void {
  if (!isObject(node)) {
    sink.add(pointer, 'schema', 'a subschema must be a JSON object');
    return;
  }
  if (depth > RESULT_SCHEMA_MAX_DEPTH) {
    sink.add(pointer, 'depth', `subschemas nest deeper than ${RESULT_SCHEMA_MAX_DEPTH} levels`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) sink.add(pointerTo(pointer, key), key, 'keyword is outside the result schema subset');
  }
  if (requireObjectRoot && depth === 0 && node.type !== 'object') {
    sink.add(pointerTo(pointer, 'type'), 'type', "the root schema must declare type: 'object'");
  }

  if (Object.hasOwn(node, 'type')) {
    const type = node.type;
    const valid = typeof type === 'string'
      ? INSTANCE_TYPES.has(type)
      : Array.isArray(type) && type.length > 0
        && type.every((member) => typeof member === 'string' && INSTANCE_TYPES.has(member))
        && new Set(type).size === type.length;
    if (!valid) sink.add(pointerTo(pointer, 'type'), 'type', 'must be a JSON type name or a non-empty array of unique type names');
  }
  if (Object.hasOwn(node, 'properties')) {
    const properties = node.properties;
    const at = pointerTo(pointer, 'properties');
    if (!isObject(properties)) sink.add(at, 'properties', 'must be an object of subschemas');
    else for (const [name, subschema] of Object.entries(properties)) checkSubschema(subschema, pointerTo(at, name), depth + 1, sink);
  }
  if (Object.hasOwn(node, 'required')) {
    const required = node.required;
    if (!Array.isArray(required) || !required.every((name) => typeof name === 'string') || new Set(required).size !== required.length) {
      sink.add(pointerTo(pointer, 'required'), 'required', 'must be an array of unique property names');
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && node.additionalProperties !== false) {
    sink.add(pointerTo(pointer, 'additionalProperties'), 'additionalProperties', 'only additionalProperties: false is allowed');
  }
  if (Object.hasOwn(node, 'items')) {
    if (!isObject(node.items)) sink.add(pointerTo(pointer, 'items'), 'items', 'must be one subschema object');
    else checkSubschema(node.items, pointerTo(pointer, 'items'), depth + 1, sink);
  }
  if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    sink.add(pointerTo(pointer, 'enum'), 'enum', 'must be a non-empty array');
  }
  if (Object.hasOwn(node, 'oneOf')) {
    const oneOf = node.oneOf;
    const at = pointerTo(pointer, 'oneOf');
    if (!Array.isArray(oneOf) || oneOf.length === 0) sink.add(at, 'oneOf', 'must be a non-empty array of subschemas');
    else oneOf.forEach((subschema, index) => checkSubschema(subschema, pointerTo(at, index), depth + 1, sink));
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (Object.hasOwn(node, keyword) && !isNonNegativeInteger(node[keyword])) {
      sink.add(pointerTo(pointer, keyword), keyword, 'must be a non-negative integer');
    }
  }
  for (const keyword of ['minimum', 'maximum'] as const) {
    if (Object.hasOwn(node, keyword) && typeof node[keyword] !== 'number') {
      sink.add(pointerTo(pointer, keyword), keyword, 'must be a number');
    }
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
    sink.add(pointerTo(pointer, 'description'), 'description', 'must be a string');
  }
}

/**
 * The admission guard for a result-document schema. Accepts only plain JSON
 * data of at most {@link RESULT_SCHEMA_MAX_BYTES} canonical UTF-8 bytes that
 * lies inside the subset (module comment). On success, `canonical` is the
 * snapshot every party freezes and validates against.
 */
export function checkResultSchema(schema: unknown): ResultSchemaCheck {
  const document = canonicalDocument(schema, RESULT_SCHEMA_MAX_BYTES);
  if (!document.ok) return documentFailure(document, 'the result schema', RESULT_SCHEMA_MAX_BYTES);
  const sink = new IssueSink();
  checkSubschema(document.canonical, '', 0, sink);
  if (!sink.empty) return { ok: false, reason: 'not-subset', bytes: document.bytes, issues: sink.issues, truncated: sink.truncated };
  return { ok: true, bytes: document.bytes, canonical: document.canonical as ResultSchema };
}

/**
 * Deep copy of pure JSON data with null-prototype objects. The library tests
 * property presence with `in`, so a prototype would make `required:
 * ['constructor']` pass on `{}`; a null prototype makes presence own-only.
 */
function withoutPrototypes(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutPrototypes);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, member] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: withoutPrototypes(member), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

/** `#/a~1b/0` (the library's URI-encoded fragment) to the RFC 6901 pointer `/a~1b/0`. */
function fragmentToPointer(location: string): string {
  return decodeURI(location.startsWith('#') ? location.slice(1) : location);
}

/**
 * Validate one outcome document against a result schema. The guard
 * ({@link checkResultSchema}) always runs first; a schema it refuses is
 * `schema-not-admitted` and never reaches the library. The outcome must be
 * plain JSON data of at most {@link RESULT_OUTCOME_MAX_BYTES} canonical UTF-8
 * bytes, checked before validation. On success, `canonical` is the snapshot
 * a sender stages and puts on the wire.
 */
export function validateResultOutcome(schema: unknown, outcome: unknown): ResultOutcomeCheck {
  const admitted = checkResultSchema(schema);
  if (!admitted.ok) {
    return { ok: false, reason: 'schema-not-admitted', bytes: admitted.bytes, issues: admitted.issues, truncated: admitted.truncated };
  }
  const document = canonicalDocument(outcome, RESULT_OUTCOME_MAX_BYTES);
  if (!document.ok) return documentFailure(document, 'the outcome', RESULT_OUTCOME_MAX_BYTES);

  // Short-circuit: each level stops at its first failure, so the error list
  // follows one failing path instead of growing with every failing pair.
  const validator = new Validator(withoutPrototypes(admitted.canonical) as Record<string, unknown>, '2020-12', true);
  const result = validator.validate(withoutPrototypes(document.canonical));
  if (result.valid) return { ok: true, bytes: document.bytes, canonical: document.canonical };

  const sink = new IssueSink();
  for (const unit of result.errors as readonly OutputUnit[]) sink.add(fragmentToPointer(unit.instanceLocation), unit.keyword, unit.error);
  return { ok: false, reason: 'schema-mismatch', bytes: document.bytes, issues: sink.issues, truncated: sink.truncated };
}

const MAX_BYTES_PER_CODE_POINT = 6;
/**
 * Longest JSON.stringify of a finite double: 25, e.g. "-0.0000012345678901234567"
 * (fixed notation down to 1e-6 with 17 significant digits and a sign). Exponent
 * forms are at most 24 ("-1.7976931348623157e+308").
 */
const MAX_NUMBER_BYTES = 25;
/**
 * Longest JSON.stringify of an integer-valued double: 22 in fixed notation
 * ("-999999999999999900000", |x| < 1e21) and 24 in exponent notation.
 */
const MAX_INTEGER_BYTES = 24;
/** Below this magnitude JSON.stringify writes an integer in plain decimal digits. */
const DECIMAL_LIMIT = 1e21;
const enc = new TextEncoder();
const size = (v: unknown) => enc.encode(JSON.stringify(v)).length;

type Node = ResultSchema;

function typeBound(node: Node, type: string): number | null {
  switch (type) {
    case 'null': return 4;
    case 'boolean': return 5;
    case 'integer': {
      // Tighten only when both ends are finite and below 1e21 in magnitude:
      // then every integer in range is plain decimal and its length grows with |x|.
      const lo = typeof node.minimum === 'number' ? Math.ceil(node.minimum) : undefined;
      const hi = typeof node.maximum === 'number' ? Math.floor(node.maximum) : undefined;
      if (lo === undefined || hi === undefined || !(Math.abs(lo) < DECIMAL_LIMIT) || !(Math.abs(hi) < DECIMAL_LIMIT)) return MAX_INTEGER_BYTES;
      return Math.min(MAX_INTEGER_BYTES, Math.max(String(lo).length, String(hi).length));
    }
    case 'number':
      return MAX_NUMBER_BYTES;
    case 'string':
      return typeof node.maxLength === 'number' ? 2 + MAX_BYTES_PER_CODE_POINT * node.maxLength : null;
    case 'array': {
      if (node.maxItems === 0) return 2;
      if (typeof node.maxItems !== 'number' || node.items === undefined) return null;
      const item = outcomeBound(node.items);
      return item === null ? null : 2 + node.maxItems * item + Math.max(0, node.maxItems - 1);
    }
    case 'object': {
      if (node.additionalProperties !== false) return null;
      const entries = Object.entries(node.properties ?? {});
      let total = 2 + Math.max(0, entries.length - 1);
      for (const [name, sub] of entries) {
        const b = outcomeBound(sub);
        if (b === null) return null;
        total += size(name) + 1 + b;
      }
      return total;
    }
    default: return null;
  }
}

/** Conservative upper bound in canonical UTF-8 bytes, or null when no finite bound follows from the schema. */
function outcomeBound(schema: ResultSchema): number | null {
  const node = schema as Node;
  const bounds: number[] = [];
  if (Object.hasOwn(node, 'const')) bounds.push(size(node.const));
  if (Array.isArray(node.enum)) bounds.push(Math.max(...node.enum.map(size)));
  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf.map(outcomeBound);
    if (branches.every((b): b is number => b !== null)) bounds.push(Math.max(...branches));
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const each = types.map(t => typeBound(node, t));
    if (each.every((b): b is number => b !== null)) bounds.push(Math.max(...each));
  }
  return bounds.length === 0 ? null : Math.min(...bounds);
}

/**
 * Conservative canonical UTF-8 bound, or null for an invalid or unbounded schema.
 * Strings cost at most 6 bytes per code point. Number costs 25; integer costs
 * 24, tightened only when both ends have magnitude below 1e21. A bound need
 * not be attainable when constraints intersect or oneOf branches overlap.
 */
export function resultOutcomeMaxBytes(schema: ResultSchema): number | null {
  // Inspect data descriptors before canonicalization can invoke a callback.
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'function') return null;
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) return null;
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (name === 'toJSON' && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function')) return null;
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      pending.push(descriptor.value);
    }
  }
  const document = canonicalDocument(schema, RESULT_SCHEMA_MAX_BYTES);
  if (!document.ok) return null;
  const sink = new IssueSink();
  // A fragment can be any instance type, unlike a result-document root.
  checkSubschema(document.canonical, '', 0, sink, false);
  if (!sink.empty) return null;
  return outcomeBound(document.canonical as ResultSchema);
}
