// BYOK change: redact decoded JSON values and withhold maps with credential-bearing keys (Apache-2.0).
/* oxlint-disable import/prefer-default-export -- Shared named helpers. */
import { asRecord, type JsonRecord } from "./json.js";
export type RedactionPath = readonly (string | number)[];
type Redact = (text: string) => string;
type Matches = (text: string) => boolean;
type JsonField = (path: RedactionPath) => boolean;
export interface RedactionStructure {
  readonly string: (path: RedactionPath, value: string) => boolean;
  readonly keys: (path: RedactionPath, key: string) => boolean;
}
const withheld = '"[redacted]"';


/** Copy only changed values. A credential-bearing property name hides its containing object. */
function sanitize(value: unknown, redact: Redact, matches: Matches, jsonField: JsonField | undefined, structure: RedactionStructure | undefined, path: RedactionPath, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") {
    if (structure?.string(path, value) === true) return value;
    return jsonField?.(path) === true ? redactJsonText(value, redact, matches) : redact(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    value.forEach((item: unknown, index) => { result.push(sanitize(item, redact, matches, jsonField, structure, [...path, index], seen)); });
    const sanitized = result.every((item, index) => item === value[index]) ? value : result;
    seen.delete(value);
    return sanitized;
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.some(key => structure?.keys(path, key) !== true && matches(key))) return "[redacted]";
  const target = Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, target);
  let changed = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor) {
      const original: unknown = descriptor.value;
      const sanitized = sanitize(original, redact, matches, jsonField, structure, [...path, key], seen);
      changed ||= sanitized !== original;
      Object.defineProperty(target, key, { ...descriptor, value: sanitized });
    } else if (value instanceof Error && key === "stack" && typeof value.stack === "string") {
      const stack = redact(value.stack);
      changed ||= stack !== value.stack;
      Object.defineProperty(target, key, { value: stack, configurable: true, writable: true });
    }
  }
  const sanitized = changed ? target : value;
  seen.delete(value);
  return sanitized;
}

/** Opaque application data, never an outbound runtime message. */
export function redactText<T>(value: T, redact: Redact, jsonField?: JsonField, structure?: RedactionStructure, matches: Matches = text => redact(text) !== text): T {
  return sanitize(value, redact, matches, jsonField, structure, [], new WeakMap()) as T;
}

/** Join user-message blocks after excluding every block the native traversal withheld. */
export function redactJoinedText(original: readonly unknown[], sanitized: unknown, redact: Redact,
  separator = "", isTextBlock: (block: JsonRecord) => boolean = block => block.type === "text",
): { content: unknown; input: string } {
  if (!Array.isArray(sanitized)) return { content: sanitized, input: "" };
  const indexes: number[] = [];
  const parts: string[] = [];
  const retained: string[] = [];
  original.forEach((block, index) => {
    const source = asRecord(block);
    const safe = asRecord(sanitized[index]);
    if (source === null || !isTextBlock(source) || typeof source.text !== "string" || typeof safe?.text !== "string") return;
    indexes.push(index);
    if (source.text !== "") parts.push(source.text);
    if (safe.text !== "") retained.push(safe.text);
  });
  const input = redact(parts.join(separator));
  if (input === retained.join(separator)) return { content: sanitized, input };
  const content = [...sanitized];
  for (const [offset, index] of indexes.entries()) content[index] = { ...asRecord(content[index]), text: offset === 0 ? input : "" };
  return { content, input };
}

/** The protocol declares this field as encoded JSON. Keep its original token spans,
 * including duplicate object members, and decode each string before matching it. */
export function redactJsonText(text: string, redact: Redact, matches: Matches = value => redact(value) !== value): string {
  try { JSON.parse(text); } catch { return "null"; }
  const objects: { start: number; firstEdit: number; withhold: boolean }[] = [];
  const edits: { start: number; end: number; replacement: string }[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"([\t\n\r ]*:)?|[{}]/gu)) {
    const start = match.index;
    const token = match[0];
    if (token === "{") {
      objects.push({ start, firstEdit: edits.length, withhold: false });
    } else if (token === "}") {
      const object = objects.pop();
      if (object?.withhold === true) {
        edits.length = object.firstEdit;
        edits.push({ start: object.start, end: start + 1, replacement: withheld });
      }
    } else {
      const suffix = match[1];
      const object = objects.at(-1);
      const stringToken = suffix === undefined ? token : token.slice(0, -suffix.length);
      const original = JSON.parse(stringToken) as string;
      if (suffix !== undefined && object !== undefined) {
        object.withhold ||= matches(original);
      } else {
        const replacement = redact(original);
        if (replacement !== original) edits.push({ start, end: start + token.length, replacement: JSON.stringify(replacement) });
      }
    }
  }
  if (edits.length === 0) return text;
  const chunks: string[] = [];
  let end = 0;
  for (const edit of edits) {
    chunks.push(text.slice(end, edit.start), edit.replacement);
    end = edit.end;
  }
  chunks.push(text.slice(end));
  return chunks.join("");
}
