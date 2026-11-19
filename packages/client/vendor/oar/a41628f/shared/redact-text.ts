// BYOK change: redact decoded JSON values and withhold maps with credential-bearing keys (Apache-2.0).
/* oxlint-disable import/prefer-default-export -- Shared named helpers. */
export type RedactionPath = readonly (string | number)[];
type Redact = (text: string) => string;
type JsonField = (path: RedactionPath) => boolean;
const withheld = '"[redacted]"';


/** Copy only changed values. A credential-bearing property name hides its containing object. */
function sanitize(value: unknown, redact: Redact, jsonField: JsonField | undefined, path: RedactionPath, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return jsonField?.(path) === true ? redactJsonText(value, redact) : redact(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    value.forEach((item: unknown, index) => { result.push(sanitize(item, redact, jsonField, [...path, index], seen)); });
    const sanitized = result.every((item, index) => item === value[index]) ? value : result;
    seen.set(value, sanitized);
    return sanitized;
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.some(key => redact(key) !== key)) return "[redacted]";
  const target = Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, target);
  let changed = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor) {
      const original: unknown = descriptor.value;
      const sanitized = sanitize(original, redact, jsonField, [...path, key], seen);
      changed ||= sanitized !== original;
      Object.defineProperty(target, key, { ...descriptor, value: sanitized });
    } else if (value instanceof Error && key === "stack" && typeof value.stack === "string") {
      const stack = redact(value.stack);
      changed ||= stack !== value.stack;
      Object.defineProperty(target, key, { value: stack, configurable: true, writable: true });
    }
  }
  const sanitized = changed ? target : value;
  seen.set(value, sanitized);
  return sanitized;
}

/** Opaque application data, never an outbound runtime message. */
export function redactText<T>(value: T, redact: Redact, jsonField?: JsonField): T {
  return sanitize(value, redact, jsonField, [], new WeakMap()) as T;
}

/** The protocol declares this field as encoded JSON. Keep its original token spans,
 * including duplicate object members, and decode each string before matching it. */
export function redactJsonText(text: string, redact: Redact): string {
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
      const replacement = redact(original);
      if (replacement === original) continue;
      if (suffix !== undefined && object !== undefined) object.withhold = true;
      else edits.push({ start, end: start + token.length, replacement: JSON.stringify(replacement) });
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
