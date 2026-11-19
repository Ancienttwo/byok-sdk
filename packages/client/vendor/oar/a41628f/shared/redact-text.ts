// BYOK change: redact decoded JSON values and withhold maps with credential-bearing keys (Apache-2.0).
/* oxlint-disable import/prefer-default-export -- Shared named helpers. */
export type RedactionPath = readonly (string | number)[];
type Redact = (text: string) => string;
type JsonField = (path: RedactionPath) => boolean;
// Node 24 and Bun implement JSON source access. OAR's ES2024 library
// predates the standard library declarations for it.
const jsonSource = JSON as unknown as {
  parse(text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown): unknown;
  rawJSON(text: string): object;
  isRawJSON(value: unknown): boolean;
};

/** Copy only changed values. A credential-bearing property name hides its containing object. */
function sanitize(value: unknown, redact: Redact, jsonField: JsonField | undefined, path: RedactionPath, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return jsonField?.(path) === true ? redactJsonText(value, redact) : redact(value);
  if (value === null || typeof value !== "object" || jsonSource.isRawJSON(value)) return value;
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

/** The protocol declares this field as encoded JSON. Malformed input is withheld. */
export function redactJsonText(text: string, redact: Redact): string {
  let parsed: unknown;
  try {
    // Preserve every number's exact spelling even when a sibling value changes.
    parsed = jsonSource.parse(text, (_key, value, context) =>
      typeof value === "number" && context?.source !== undefined ? jsonSource.rawJSON(context.source) : value);
  } catch {
    return '"[redacted]"';
  }
  const sanitized = sanitize(parsed, redact, undefined, [], new WeakMap());
  return sanitized === parsed ? text : JSON.stringify(sanitized);
}
