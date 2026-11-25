// BYOK change: Modified from OAR a122061 to accept explicitly resolved credentials (Apache-2.0).
/* oxlint-disable import/prefer-default-export -- Shared named helper. */
import type { RawEvent, SessionOptions } from "../contracts/session.js";
import { environmentValue } from "./environment.js";
import { redactText, type RedactionPath, type RedactionStructure } from "./redact-text.js";

const CREDENTIAL_WORDS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS", "COOKIE", "PWD"]);
const AUTH_HEADERS = new Set(["AUTHORIZATION", "PROXY-AUTHORIZATION"]);
const CREDENTIAL_NAMES = new Set(["PGPASSWORD"]);
const CREDENTIAL_MIN_LENGTH = 8;
const PATH_VALUE = /^(?:\/|~\/|[a-z]:\\)/iu;
function credentialValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length >= CREDENTIAL_MIN_LENGTH && !PATH_VALUE.test(value);
}

/**
 * BYOK change: a refused MCP mount echoes its entries JSON-encoded, and a diagnostic can encode them again, so a
 * credential is also protected with one and two levels of JSON escaping. A value without quotes, backslashes or
 * control characters escapes to itself.
 */
function escapedForms(value: string): readonly string[] {
  const once = JSON.stringify(value).slice(1, -1);
  return [value, once, JSON.stringify(once).slice(1, -1)];
}

/** A connection string proves its password is a credential, regardless of the env name. */
function urlCredentials(value: string | null | undefined): readonly string[] {
  if (typeof value !== "string" || !/^[a-z][a-z\d+.-]*:\/\//iu.test(value) || !URL.canParse(value)) { return []; }
  const parsed = new URL(value);
  if (parsed.password === "") { return []; }
  const passwords = [parsed.password];
  try { passwords.push(decodeURIComponent(parsed.password)); } catch { /* Malformed percent escapes still leave the encoded password protected. */ }
  return [value, ...passwords.filter((password) => password.length >= CREDENTIAL_MIN_LENGTH)];
}

export interface CredentialRedactionTail {
  /** The original suffix that can still begin a credential, at most longest key length minus one. */
  readonly text: string;
  /** The number of UTF-16 code units already covered by the last emitted replacement. */
  readonly covered: number;
  readonly continuesRedaction: boolean;
}

export interface CredentialRedactor {
  /** Private connection redaction input, each credential as registered. Never put these values in records or diagnostics. */
  values(this: void): readonly string[];
  hasProtectedValues(this: void): boolean;
  matches(this: void, text: string): boolean;
  redactChunk(this: void, text: string, tail?: CredentialRedactionTail): { readonly ready: string; readonly pending?: CredentialRedactionTail };
  finishRedaction(this: void, tail?: CredentialRedactionTail): string;
  add(this: void, value: string | undefined): void;
  /** BYOK change: A credential the caller resolved, including short or path-like values. */
  addExplicit(this: void, value: string): void;
  /** BYOK change: suppress an echoed image payload from records and control errors. */
  addImage(this: void, data: string): void;
  redact(this: void, text: string): string;
  redactValue<T>(this: void, value: T, jsonField?: (path: RedactionPath) => boolean, structure?: RedactionStructure): T;
}

/** Explicit session credentials only; runtime-native keys can be added after SDK resolution. */
export function sessionCredentialRedactor(options: Partial<SessionOptions>): CredentialRedactor {
  // BYOK change: `credentials` holds each registered credential as given, which `values()` returns, so passing one
  // redactor's values to another's `add` registers nothing new. `known` is the match set: each credential with its
  // escaped forms, and echoed image payloads.
  const credentials = new Set<string>();
  const known = new Set<string>();
  let orderedCredentials: readonly string[] = [];
  let orderedValues: readonly string[] = [];
  const register = (value: string): boolean => {
    if (value.length === 0 || credentials.has(value)) { return false; }
    credentials.add(value);
    for (const form of escapedForms(value)) { known.add(form); }
    return true;
  };
  const remember = (value: string | null | undefined): void => { if (credentialValue(value)) { register(value); } };
  // BYOK change: the caller hands each MCP env and header value to the runtime, so each one is a credential whatever
  // its name or shape. A value under the minimum length is not registered, even under a credential name, unless it is
  // inside a longer header or URL: a short value such as DEBUG=1 would redact every matching character of model output.
  const mcpValue = (value: string | null | undefined): void => {
    if (typeof value === "string" && value.length >= CREDENTIAL_MIN_LENGTH) { register(value); }
  };
  const env = (entries: SessionOptions["env"]): void => {
    for (const [name, value] of Object.entries(entries ?? {})) {
      const upper = name.toUpperCase();
      if (CREDENTIAL_WORDS.has(upper.split("_").at(-1) ?? "") || CREDENTIAL_NAMES.has(upper)) { remember(value); }
      for (const credential of urlCredentials(value)) { register(credential); }
    }
  };
  env(options.env);
  for (const server of options.mcpServers ?? []) {
    if (!("type" in server)) {
      for (const value of Object.values(server.env ?? {})) {
        mcpValue(value);
        for (const credential of urlCredentials(value)) { register(credential); }
      }
      continue;
    }
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      mcpValue(value);
      if (AUTH_HEADERS.has(name.toUpperCase())) { mcpValue(/^\s*\S+\s+(.+?)\s*$/u.exec(value)?.[1]); }
    }
  }
  const byLength = (values: Iterable<string>): readonly string[] => [...values].toSorted((left, right) => right.length - left.length);
  const refresh = (): void => {
    orderedCredentials = byLength(credentials);
    orderedValues = byLength(known);
  };
  refresh();
  const redactTextParts = (text: string, streaming: boolean, tail?: CredentialRedactionTail): { ready: string; pending?: CredentialRedactionTail } => {
    const keys = orderedValues;
    let cut = text.length;
    if (streaming) {
      for (const key of keys) {
        for (let size = Math.min(key.length - 1, text.length); size > text.length - cut; size--) {
          if (text.endsWith(key.slice(0, size))) { cut = text.length - size; break; }
        }
      }
    }
    const matches: { start: number; end: number }[] = [];
    if (tail !== undefined && tail.covered > 0) matches.push({ start: 0, end: tail.covered });
    for (const key of keys) {
      let previous: { start: number; end: number } | undefined;
      for (let start = text.indexOf(key); start !== -1; start = text.indexOf(key, start + 1)) {
        const end = start + key.length;
        if (previous !== undefined && start <= previous.end) previous.end = end;
        else { previous = { start, end }; matches.push(previous); }
      }
    }
    matches.sort((a, b) => a.start - b.start);
    const parts: string[] = [];
    let at = 0;
    let continuing = tail?.continuesRedaction === true;
    for (const { start, end } of matches) {
      if (start <= at && continuing) { at = Math.max(at, end); continue; }
      if (start >= cut) break;
      parts.push(text.slice(at, start), "[redacted]");
      at = end;
      continuing = true;
    }
    if (at < cut) { parts.push(text.slice(at, cut)); continuing = false; }
    const ready = parts.join("");
    const suffix = text.slice(cut);
    // Only the possible partial match stays buffered. Remember coverage and
    // adjacency so a later match can extend a replacement already emitted.
    return !streaming || (suffix === "" && !continuing) ? { ready }
      : { ready, pending: { text: suffix, covered: Math.max(0, at - cut), continuesRedaction: continuing } };
  };
  const redact = (text: string): string => redactTextParts(text, false).ready;
  const matches = (text: string): boolean => orderedValues.some(value => text.includes(value));
  const addCredential = (value: string): void => { if (register(value)) { refresh(); } };
  return {
    values: () => orderedCredentials,
    hasProtectedValues: () => orderedValues.length !== 0,
    matches,
    redactChunk: (text, tail) => redactTextParts((tail?.text ?? "") + text, true, tail),
    finishRedaction: tail => tail === undefined ? "" : redactTextParts(tail.text, false, tail).ready,
    add(value) {
      if (credentialValue(value)) { addCredential(value); }
    },
    addExplicit: addCredential,
    addImage(data) {
      if (data.length !== 0 && !known.has(data)) {
        known.add(data);
        refresh();
      }
    },
    redact,
    redactValue: (value, jsonField, structure) => orderedValues.length === 0 ? value : redactText(value, redact, jsonField, structure, matches),
  };
}

function eventPath(path: RedactionPath): boolean {
  return path[0] === "body" && path[1] === "events" && typeof path[2] === "number";
}

export function isProjectedToolInput(record: RawEvent, path: RedactionPath): boolean {
  const [,, index, field] = path;
  if (record.kind !== "frame" || path.length !== 4 || !eventPath(path) || typeof index !== "number" || field !== "input") return false;
  const kind = record.body.events[index]?.kind;
  return kind === "tool_call_started" || kind === "tool_call_input";
}

/** Keep the typed record and event discriminators out of the content traversal. */
export function redactRuntimeRecord<T extends RawEvent>(
  record: T, redact: CredentialRedactor["redactValue"], jsonField?: (path: RedactionPath) => boolean,
  isProtocolString?: (path: RedactionPath, value: string) => boolean,
  isProtocolKey?: (path: RedactionPath, key: string) => boolean,
): T {
  return redact(record, jsonField, {
    string(path, value) {
      const [body, field, , eventField, nestedField] = path;
      return (path.length === 1 && (body === "kind" || body === "direction"))
        || (path.length === 2 && body === "body" && (field === "kind" || (field === "code" && record.kind === "response")))
        || (eventPath(path) && ((path.length === 4 && (eventField === "kind"
          || (eventField === "result" && (value === "ok" || value === "failed"))))
          || (path.length === 5 && eventField === "outcome" && (nestedField === "kind" || nestedField === "failure"))))
        || isProtocolString?.(path, value) === true;
    },
    keys(path, key) {
      return path.length === 0 || (path.length === 1 && path[0] === "body")
        || (path.length === 3 && eventPath(path))
        || (path.length === 4 && eventPath(path) && path[3] === "outcome")
        || isProtocolKey?.(path, key) === true;
    },
  });
}

/**
 * Read a named runtime credential from an effective environment (including
 * values inherited from `process.env` when not cleared by `null`) and register
 * it on the redactor with the same length, path and URL rules as explicit
 * `SessionOptions.env`.
 */
export function readEnvironmentCredential(
  env: Readonly<NodeJS.ProcessEnv>,
  name: string,
  redactor?: Pick<CredentialRedactor, "add">,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const value = environmentValue(env, name, platform);
  if (redactor !== undefined) {
    redactor.add(value);
    for (const credential of urlCredentials(value)) { redactor.add(credential); }
  }
  return value;
}

export function rememberEnvironmentCredentials(
  redactor: Pick<CredentialRedactor, "add">,
  env: Readonly<NodeJS.ProcessEnv>,
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  for (const name of names) {
    readEnvironmentCredential(env, name, redactor, platform);
  }
}
