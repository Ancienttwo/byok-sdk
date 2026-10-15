import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as floorRelease from 'byok-protocol-floor';
import * as previousRelease from 'byok-protocol-previous';
import * as currentModule from '../index';
import {
  CAPABILITY_FLAGS,
  CONTENT_HASH_RE,
  EnvelopeSchema,
  KNOWN_AGENT_EVENT_TYPES,
  MAX_MESSAGES_PER_BATCH,
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  TASK_STATES,
  TASK_TRANSITIONS,
  WIRE_ADDITIONS,
  decodeEnvelope,
  encodeEnvelope,
  isServerToDaemonType,
  requiredReceiverCapabilities,
  type MessageType,
  type WireAddition,
} from '../index';

/**
 * Executable v2 compatibility contract (docs/protocol.md "Freeze rule").
 *
 * Every v2 change is a version bump, a gated addition or a strip-safe
 * addition. The last two are declared in `WIRE_ADDITIONS` (production code,
 * the same table cloud admission reads). This file proves the declarations
 * against two PUBLISHED decoders pinned in package.json:
 *
 * - `byok-protocol-floor`: the oldest stable release v2 still supports
 *   (`golden/releases.json` `floor`). It checks gates directly.
 * - `byok-protocol-previous`: the latest or second-latest registered stable
 *   release. It knows the most context, so it catches nested regressions.
 *
 * The envelope and HTTP corpora are append-only. Registered releases pin
 * shipped prefixes; HTTP registration begins after the frozen pre-HTTP
 * releases, never by backfilling them. To register a release, add the entry
 * this file prints (docs/releases/README.md).
 */

const require = createRequire(import.meta.url);
const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));
const corpusPath = `${goldenDir}v2.envelopes.ndjson`;
const httpCorpusPath = `${goldenDir}v2.http.ndjson`;

interface ReleaseEntry {
  readonly version: string;
  readonly envelopes: { readonly lines: number; readonly sha256: string };
  readonly http?: { readonly lines: number; readonly sha256: string };
}
interface ReleaseRegistry {
  readonly floor: string;
  readonly releases: readonly ReleaseEntry[];
}

const registry = JSON.parse(readFileSync(`${goldenDir}releases.json`, 'utf8')) as ReleaseRegistry;
const corpusText = readFileSync(corpusPath, 'utf8');
const rawLines = corpusText.split('\n').filter((line) => line.length > 0);
const httpCorpusText = readFileSync(httpCorpusPath, 'utf8');
// Retain empty lines: silently filtering them would hide a byte mutation.
const httpRawLines = httpCorpusText.split('\n');
if (httpRawLines.at(-1) === '') httpRawLines.pop();

// These releases shipped only the envelope corpus. Freeze the complete
// historical entries: adding an HTTP member would fabricate shipped bytes.
const PRE_HTTP_RELEASES: readonly ReleaseEntry[] = [
  { version: '0.25.0', envelopes: { lines: 32, sha256: '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04' } },
  { version: '0.26.0', envelopes: { lines: 32, sha256: '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04' } },
  { version: '0.26.1', envelopes: { lines: 32, sha256: '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04' } },
];

interface CorpusLine {
  readonly index: number;
  readonly raw: string;
  readonly type: MessageType;
  readonly payload: Record<string, unknown>;
}

const corpus: readonly CorpusLine[] = rawLines.map((raw, index) => {
  const parsed = JSON.parse(raw) as { type: MessageType; payload: Record<string, unknown> };
  return { index, raw, type: parsed.type, payload: parsed.payload };
});

function packageVersion(specifier: string): string {
  return (JSON.parse(readFileSync(require.resolve(`${specifier}/package.json`), 'utf8')) as { version: string }).version;
}

function prefixHash(lines: readonly string[], length: number): { lines: number; sha256: string } {
  const prefix = lines.slice(0, length).map((line) => `${line}\n`).join('');
  return { lines: length, sha256: createHash('sha256').update(prefix).digest('hex') };
}

function prefixEntry(version: string, lines: number, httpLines?: number): ReleaseEntry {
  return {
    version, envelopes: prefixHash(rawLines, lines),
    ...(httpLines === undefined ? {} : { http: prefixHash(httpRawLines, httpLines) }),
  };
}

/** The first post-legacy entry is the HTTP boundary; there is no second marker. */
function assertHttpLedger(entries: readonly ReleaseEntry[], bytes: readonly string[] = httpRawLines): void {
  expect(entries.slice(0, PRE_HTTP_RELEASES.length), 'pre-HTTP historical entries must not be changed or backfilled').toEqual(PRE_HTTP_RELEASES);
  let previousLines = 0;
  for (const entry of entries.slice(PRE_HTTP_RELEASES.length)) {
    expect(entry.http, `HTTP prefix required for post-legacy release ${entry.version}`).toBeDefined();
    const http = entry.http!;
    expect(http.lines).toBeGreaterThan(0);
    expect(Number.isSafeInteger(http.lines)).toBe(true);
    expect(http.lines).toBeGreaterThanOrEqual(previousLines);
    expect(http.lines).toBeLessThanOrEqual(bytes.length);
    expect(http, `HTTP bytes released with ${entry.version} are append-only`).toEqual(prefixHash(bytes, http.lines));
    previousLines = http.lines;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---------------------------------------------------------------------------
// Release registry
// ---------------------------------------------------------------------------

describe('compat: release registry', () => {
  it('registered versions are stable and strictly ascending, and their corpus prefixes never shrink', () => {
    const versions = registry.releases.map((entry) => entry.version);
    for (const version of versions) expect(version, 'prereleases are not registered').toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 1; i < registry.releases.length; i += 1) {
      expect(compareVersions(versions[i - 1]!, versions[i]!)).toBeLessThan(0);
      expect(registry.releases[i]!.envelopes.lines).toBeGreaterThanOrEqual(registry.releases[i - 1]!.envelopes.lines);
    }
  });

  it.each(registry.releases.map((entry) => [entry.version, entry] as const))(
    'the corpus prefix released with %s is unchanged',
    (_version, entry) => {
      expect(entry.envelopes.lines).toBeLessThanOrEqual(rawLines.length);
      expect(
        prefixEntry(entry.version, entry.envelopes.lines, entry.http?.lines),
        `golden/v2.envelopes.ndjson lines 1-${entry.envelopes.lines} shipped with ${entry.version} and are append-only`,
      ).toEqual(entry);
    },
  );

  it('historical entries have no invented HTTP evidence and every subsequent release pins HTTP bytes', () => {
    assertHttpLedger(registry.releases);
  });

  it('rejects backfilled historical HTTP bytes', () => {
    const entries = structuredClone(PRE_HTTP_RELEASES) as ReleaseEntry[];
    entries[2] = { ...entries[2]!, http: prefixHash(httpRawLines, httpRawLines.length) };
    expect(() => assertHttpLedger(entries)).toThrow('pre-HTTP historical entries');
  });

  it('requires HTTP evidence at the first subsequent release, and pins the literal bytes', () => {
    const candidate = prefixEntry('0.27.0', rawLines.length, httpRawLines.length);
    // Synthetic candidate, never appended to the real release ledger here.
    const entries = [...PRE_HTTP_RELEASES, candidate];
    expect(() => assertHttpLedger(entries)).not.toThrow();
    expect(() => assertHttpLedger([...PRE_HTTP_RELEASES, { version: candidate.version, envelopes: candidate.envelopes }]))
      .toThrow('HTTP prefix required');
    const changed = [...httpRawLines];
    changed[0] = `${changed[0]} `;
    expect(() => assertHttpLedger(entries, changed)).toThrow('HTTP bytes released');
    const shortened = { ...candidate, version: '0.28.0', http: prefixHash(httpRawLines, 1) };
    expect(() => assertHttpLedger([...entries, shortened])).toThrow();
  });

  it('the current stable package version is registered', () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) return;
    const entry = registry.releases.find((candidate) => candidate.version === version);
    expect(
      entry,
      `@byok-sdk/protocol ${version} is not in golden/releases.json. Append this entry: ${JSON.stringify(prefixEntry(version, rawLines.length, httpRawLines.length))}`,
    ).toBeDefined();
  });

  it('the floor alias pins the registry floor, which is the first registered release', () => {
    expect(registry.releases[0]?.version).toBe(registry.floor);
    expect(packageVersion('byok-protocol-floor')).toBe(registry.floor);
  });

  it('the previous alias pins the latest or second-latest registered release', () => {
    const latest = registry.releases.slice(-2).map((entry) => entry.version);
    expect(latest).toContain(packageVersion('byok-protocol-previous'));
  });
});

// ---------------------------------------------------------------------------
// Released surface is never narrowed
// ---------------------------------------------------------------------------

type ProtocolModule = typeof floorRelease;
const PINNED: readonly (readonly [string, ProtocolModule])[] = [
  [`floor ${packageVersion('byok-protocol-floor')}`, floorRelease],
  [`previous ${packageVersion('byok-protocol-previous')}`, previousRelease as unknown as ProtocolModule],
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type HttpSurface = Extract<WireAddition, { kind: 'http' }>['surface'];
interface HttpCorpusLine {
  readonly index: number;
  readonly surface: HttpSurface;
  /** Literal wire body; the expected value is authored independently. */
  readonly body: string;
  readonly value: Record<string, unknown>;
  readonly batchLength?: number;
}
const httpCorpus: readonly HttpCorpusLine[] = httpRawLines.map((raw, index) => ({
  ...(JSON.parse(raw) as Omit<HttpCorpusLine, 'index'>), index,
}));

function httpSchema(module: ProtocolModule | typeof currentModule, surface: HttpSurface): {
  parse(input: unknown): Record<string, unknown>;
  shape: Record<string, unknown>;
} {
  const schema = (module as Record<string, unknown>)[`${surface}Schema`];
  if (schema === undefined) throw new Error(`missing HTTP schema: ${surface}`);
  return schema as ReturnType<typeof httpSchema>;
}

function assertBatchCounts(line: HttpCorpusLine, decoded: Record<string, unknown>): void {
  if (line.surface !== 'MessagesSendResponse') return;
  expect((decoded.accepted as number) + (decoded.rejected === undefined ? 0 : decoded.rejected as number),
    'accepted + rejected must account for the entire submitted batch').toBe(line.batchLength);
  const outcomes = decoded.outcomes as readonly { readonly outcome: string }[] | undefined;
  if (outcomes === undefined) return;
  // Outcomes are observation only; they must agree with the authoritative counts.
  expect(outcomes.length, 'outcomes must correlate every submitted envelope').toBe(line.batchLength);
  expect(outcomes.filter((entry) => entry.outcome !== 'rejected').length,
    'accepted counts accepted and duplicate outcomes').toBe(decoded.accepted);
  expect(outcomes.filter((entry) => entry.outcome === 'rejected').length,
    'rejected counts rejected outcomes').toBe(decoded.rejected ?? 0);
}

function assertCurrentHttp(line: HttpCorpusLine): void {
  const decoded = httpSchema(currentModule, line.surface).parse(JSON.parse(line.body));
  expect(decoded, 'the current HTTP decoder dropped or changed the independently committed value').toEqual(line.value);
  assertBatchCounts(line, decoded);
}

function assertReleasedHttp(release: ProtocolModule, line: HttpCorpusLine, additions: readonly WireAddition[] = WIRE_ADDITIONS): void {
  const decoded = httpSchema(release, line.surface).parse(JSON.parse(line.body));
  const dropped: string[] = [];
  droppedPaths(line.value, decoded, '', dropped);
  const undeclared = dropped.filter((path) => !additions.some((entry) =>
    entry.kind === 'http' && entry.surface === line.surface && entry.field === path));
  expect(undeclared, 'released HTTP decoder lost an undeclared field').toEqual([]);
  const retained = structuredClone(line.value);
  for (const path of dropped) delete retained[path];
  expect(decoded, 'released HTTP decoder changed a retained value').toEqual(retained);
  assertBatchCounts(line, decoded);
}

// These published *protocol* decoders do not execute the old client-private
// parsers. A newer alias must trigger review rather than silently extend this
// explicitly bounded exclusion. This is an evidence boundary, not a fallback.
const PRIVATE_CLIENT_HTTP_EXCLUSIONS = [
  {
    surface: 'EventsPollResponse', through: '0.26.1',
    reason: 'LongPollTransport validates the outer page privately, then decodes entries individually to preserve unknown-event cursor stalls.',
  },
  {
    surface: 'ChallengeResponse', through: '0.26.1',
    reason: 'AuthManager reads nonce from a client-private response cast rather than ChallengeResponseSchema.',
  },
  {
    surface: 'TokenResponse', through: '0.26.1',
    reason: 'AuthManager reads accessToken/expiresAt from a client-private response cast rather than TokenResponseSchema.',
  },
] as const satisfies readonly { surface: HttpSurface; through: string; reason: string }[];

describe('compat: HTTP corpus evidence boundary', () => {
  it('covers all eight scoped HTTP route schemas with owned bodies and independent expected values', () => {
    const surfaces: readonly HttpSurface[] = ['ChallengeRequest', 'ChallengeResponse', 'TokenRequest', 'TokenResponse',
      'EventsPollQuery', 'EventsPollResponse', 'MessagesSendRequest', 'MessagesSendResponse'];
    expect([...new Set(httpCorpus.map((line) => line.surface))].sort()).toEqual([...surfaces].sort());
    expect(httpCorpusText.endsWith('\n'), 'literal corpus lines must be newline terminated').toBe(true);
    for (const line of httpCorpus) {
      expect(typeof line.body).toBe('string');
      expect(JSON.parse(line.body)).toEqual(line.value);
      if (line.surface === 'MessagesSendResponse') {
        expect(Number.isSafeInteger(line.batchLength)).toBe(true);
        expect(line.batchLength).toBeGreaterThanOrEqual(0);
      } else expect(line.batchLength).toBeUndefined();
    }
  });

  it('keeps the three private-client exclusions typed, explained and bounded to reviewed releases', () => {
    expect(PRIVATE_CLIENT_HTTP_EXCLUSIONS.map((entry) => entry.surface)).toEqual([
      'EventsPollResponse', 'ChallengeResponse', 'TokenResponse',
    ]);
    for (const entry of PRIVATE_CLIENT_HTTP_EXCLUSIONS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      for (const [, release] of PINNED) {
        expect(httpSchema(release, entry.surface)).toBeDefined();
      }
      for (const alias of ['byok-protocol-floor', 'byok-protocol-previous']) {
        expect(compareVersions(packageVersion(alias), entry.through),
          'a newer published alias requires removing or explicitly reviewing the private-client exclusion').toBeLessThanOrEqual(0);
      }
    }
  });

  it('detects a changed literal body independently of the expected value', () => {
    const line = httpCorpus.find((entry) => entry.surface === 'ChallengeResponse')!;
    expect(() => assertCurrentHttp({ ...line, body: JSON.stringify({ nonce: 'changed-nonce' }) })).toThrow('independently committed');
  });

  it('rejects unaccounted batch members in current and published decoders', () => {
    const line = httpCorpus.find((entry) => entry.surface === 'MessagesSendResponse' && entry.batchLength === 2)!;
    const changed = { ...line, batchLength: 3 };
    expect(() => assertCurrentHttp(changed)).toThrow('entire submitted batch');
    for (const [, release] of PINNED) expect(() => assertReleasedHttp(release, changed)).toThrow('entire submitted batch');
  });

  it('rejects undeclared HTTP loss using the actual published decoders', () => {
    const line = httpCorpus.find((entry) => entry.surface === 'MessagesSendResponse' && Object.hasOwn(entry.value, 'capabilities'))!;
    const withoutHttp = WIRE_ADDITIONS.filter((entry) => entry.kind !== 'http');
    for (const [, release] of PINNED) expect(() => assertReleasedHttp(release, line, withoutHttp)).toThrow('undeclared field');
  });
});

describe('compat: current HTTP decoders read committed literal bodies', () => {
  it.each(httpCorpus.map((line) => [line.index + 1, line.surface, line] as const))(
    'HTTP line %i (%s) deep-equals its independent expected value and accounts for its batch',
    (_index, _surface, line) => assertCurrentHttp(line),
  );
});

describe.each(PINNED)('compat: published HTTP decoders %s read current bodies', (_label, release) => {
  it.each(httpCorpus.map((line) => [line.index + 1, line.surface, line] as const))(
    'HTTP line %i (%s) retains values and loses only declared strip-safe fields',
    (_index, _surface, line) => assertReleasedHttp(release, line),
  );
});

function jsonSchema(schema: unknown): Json {
  return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Json;
}

/**
 * Keywords of `released` that `current` removed or changed. Additions are
 * allowed only where they widen: a new key in a `properties` map, a new
 * union branch, or new `enum` values. Any other added keyword (a bound, a
 * pattern, `additionalProperties`, a `required` entry) narrows and is reported.
 */
function narrowing(released: Json, current: Json, path: string, out: string[]): void {
  if (Array.isArray(released)) {
    if (!Array.isArray(current) || JSON.stringify(released) !== JSON.stringify(current)) out.push(`${path}: changed`);
    return;
  }
  if (released === null || typeof released !== 'object') {
    if (released !== current) out.push(`${path}: ${JSON.stringify(released)} -> ${JSON.stringify(current)}`);
    return;
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    out.push(`${path}: changed kind`);
    return;
  }
  for (const [key, value] of Object.entries(released)) {
    const next = `${path}/${key}`;
    if (!(key in current)) {
      out.push(`${next}: removed`);
      continue;
    }
    const currentValue = current[key]!;
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, property] of Object.entries(value)) {
        const currentProperties = currentValue as { [name: string]: Json };
        if (!(name in currentProperties)) out.push(`${next}/${name}: removed`);
        else narrowing(property, currentProperties[name]!, `${next}/${name}`, out);
      }
    } else if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value) && Array.isArray(currentValue)) {
      value.forEach((branch, index) => {
        if (index >= currentValue.length) out.push(`${next}/${index}: removed`);
        else narrowing(branch, currentValue[index]!, `${next}/${index}`, out);
      });
    } else if (key === 'enum' && Array.isArray(value) && Array.isArray(currentValue)) {
      for (const member of value) {
        if (!currentValue.some((candidate) => JSON.stringify(candidate) === JSON.stringify(member))) {
          out.push(`${next}: removed ${JSON.stringify(member)}`);
        }
      }
    } else {
      narrowing(value, currentValue, next, out);
    }
  }
  for (const key of Object.keys(current)) {
    if (!(key in released) && key !== 'description') out.push(`${path}/${key}: added ${JSON.stringify(current[key])}`);
  }
}

describe.each(PINNED)('compat: the surface released in %s is never narrowed', (_label, release) => {
  it('message types, capability flags, task states and AgentEvent types are all still known', () => {
    const subset = (released: readonly string[], current: readonly string[]) => released.filter((value) => !current.includes(value));
    expect(subset(release.MESSAGE_TYPES, MESSAGE_TYPES)).toEqual([]);
    expect(subset(release.CAPABILITY_FLAGS, CAPABILITY_FLAGS)).toEqual([]);
    expect(subset(release.TASK_STATES, TASK_STATES)).toEqual([]);
    expect(subset(release.KNOWN_AGENT_EVENT_TYPES, KNOWN_AGENT_EVENT_TYPES)).toEqual([]);
  });

  it('every released task-state transition is still legal', () => {
    const missing: string[] = [];
    for (const [from, targets] of Object.entries(release.TASK_TRANSITIONS as Record<string, readonly string[]>)) {
      const current = (TASK_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [];
      for (const to of targets) if (!current.includes(to)) missing.push(`${from} -> ${to}`);
    }
    expect(missing).toEqual([]);
  });

  it('batch and content-hash bounds are unchanged', () => {
    expect(MAX_MESSAGES_PER_BATCH).toBe(release.MAX_MESSAGES_PER_BATCH);
    expect(CONTENT_HASH_RE.source).toBe(release.CONTENT_HASH_RE.source);
  });

  it('every released message type still flows in the same direction', () => {
    expect(release.MESSAGE_TYPES.filter((type) => release.isServerToDaemonType(type) !== isServerToDaemonType(type))).toEqual([]);
  });

  it('no exported schema keyword was removed, changed or narrowed', () => {
    const found: string[] = [];
    for (const [type, schema] of Object.entries(release.MESSAGE_PAYLOAD_SCHEMAS)) {
      narrowing(jsonSchema(schema), jsonSchema(MESSAGE_PAYLOAD_SCHEMAS[type as MessageType]), type, found);
    }
    for (const [name, schema] of Object.entries(release)) {
      if (!name.endsWith('Schema')) continue;
      const current = (currentModule as Record<string, unknown>)[name];
      if (current === undefined) found.push(`${name}: export removed`);
      else narrowing(jsonSchema(schema), jsonSchema(current), name, found);
    }
    expect(
      found,
      'a released shape was removed, changed or narrowed (a bound, an enum value, strictness, a required field). ' +
        'That is the version-bump path in docs/protocol.md "Freeze rule"; restore the released shape instead.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The current decoder reads released bytes
// ---------------------------------------------------------------------------

describe('compat: the current decoder reads every corpus line exactly', () => {
  it.each(corpus.map((line) => [line.index + 1, line.type, line] as const))(
    'line %i (%s) decodes, round-trips and deep-equals the committed JSON',
    (_n, _type, line) => {
      const decoded = decodeEnvelope(line.raw);
      expect(decodeEnvelope(encodeEnvelope(decoded))).toEqual(decoded);
      expect(decoded, 'the current decoder dropped or changed a field a released peer put on the wire').toEqual(JSON.parse(line.raw));
    },
  );
});

// ---------------------------------------------------------------------------
// Released decoders read current bytes
// ---------------------------------------------------------------------------

/** Paths present in `sent` that `received` no longer carries. */
function droppedPaths(sent: unknown, received: unknown, path: string, out: string[]): void {
  if (sent === null || typeof sent !== 'object') return;
  if (received === null || typeof received !== 'object') {
    out.push(path);
    return;
  }
  if (Array.isArray(sent)) {
    sent.forEach((item, index) => droppedPaths(item, (received as unknown[])[index], `${path}[${index}]`, out));
    return;
  }
  for (const [key, value] of Object.entries(sent)) {
    if (value === undefined) continue;
    if (!(key in (received as Record<string, unknown>))) out.push(path === '' ? key : `${path}.${key}`);
    else droppedPaths(value, (received as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`, out);
  }
}

function fieldEntries(type: MessageType, field: string): WireAddition[] {
  return WIRE_ADDITIONS.filter((entry) => entry.kind === 'envelope' && entry.surface === type && entry.field === field);
}

/**
 * A dropped path the release may lose: declared strip-safe at exactly that
 * path, or under a top-level field gated by a flag the release does not know
 * (such a release never receives the field at all).
 */
function declaredForRelease(type: MessageType, path: string, releasedFlags: readonly string[]): boolean {
  const topLevel = path.split(/[.[]/)[0]!;
  return (
    fieldEntries(type, path).some((entry) => entry.rule === 'strip-safe') ||
    fieldEntries(type, topLevel).some((entry) => entry.rule === 'gated' && !releasedFlags.includes(entry.capability))
  );
}

function decodeWith(release: ProtocolModule, raw: string): { ok: true; payload: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, payload: release.decodeEnvelope(raw).payload };
  } catch (error) {
    return { ok: false, error };
  }
}

describe.each(PINNED)('compat: the released decoder %s reads current bytes', (_label, release) => {
  const releasedFlags: readonly string[] = release.CAPABILITY_FLAGS;

  it.each(corpus.map((line) => [line.index + 1, line.type, line] as const))(
    'line %i (%s) is accepted, gated by an unknown flag, or loses only declared fields',
    (_n, type, line) => {
      const result = decodeWith(release, line.raw);
      if (!result.ok && result.error instanceof release.UnknownMessageTypeError) {
        const unknownFlags = requiredReceiverCapabilities(type, line.payload).filter((flag) => !releasedFlags.includes(flag));
        expect(
          unknownFlags,
          `this release does not know ${type}. Gate the type in WIRE_ADDITIONS with a capability this release does not know.`,
        ).not.toEqual([]);
        return;
      }
      if (!result.ok) {
        const gated = Object.keys(line.payload).filter((field) =>
          fieldEntries(type, field).some((entry) => entry.rule === 'gated' && !releasedFlags.includes(entry.capability)),
        );
        expect(gated, `this release rejects line ${line.index + 1} (${type}): ${String(result.error)}. Gate the new field in WIRE_ADDITIONS with a capability this release does not know, or bump PROTOCOL_VERSION.`).not.toEqual([]);
        const stripped = JSON.parse(line.raw) as { payload: Record<string, unknown> };
        for (const field of gated) delete stripped.payload[field];
        const retry = decodeWith(release, JSON.stringify(stripped));
        expect(retry.ok, `without its gated fields (${gated.join(', ')}) line ${line.index + 1} must be accepted; something else is incompatible`).toBe(true);
        return;
      }
      const dropped: string[] = [];
      droppedPaths(line.payload, result.payload, '', dropped);
      const undeclared = dropped.filter((path) => !declaredForRelease(type, path, releasedFlags));
      expect(
        undeclared,
        `this release silently drops these fields of ${type}. Declare each as strip-safe in WIRE_ADDITIONS only if dropping it ` +
          'cannot change what the receiver executes or acknowledges; otherwise gate it.',
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// WIRE_ADDITIONS is well formed and the corpus exercises it
// ---------------------------------------------------------------------------

function carries(line: CorpusLine, entry: WireAddition): boolean {
  if (entry.kind !== 'envelope' || line.type !== entry.surface) return false;
  if (entry.field === undefined) return true;
  const value = line.payload[entry.field];
  if (value === undefined) return false;
  return entry.rule !== 'gated' || entry.value === undefined || value === entry.value;
}

describe('compat: WIRE_ADDITIONS', () => {
  it('every entry names a current message type and capability, in the right direction', () => {
    for (const entry of WIRE_ADDITIONS) {
      if (entry.kind === 'http') {
        expect(Object.keys(httpSchema(currentModule, entry.surface).shape)).toContain(entry.field);
        if (entry.surface === 'MessagesSendResponse') expect(['accepted', 'rejected']).not.toContain(entry.field);
        continue;
      }
      expect(MESSAGE_TYPES).toContain(entry.surface);
      if (entry.rule !== 'gated') continue;
      expect(CAPABILITY_FLAGS).toContain(entry.capability);
      expect(entry.advertisedBy, `${entry.surface} flows ${isServerToDaemonType(entry.surface) ? 'to the daemon' : 'to the server'}`).toBe(
        isServerToDaemonType(entry.surface) ? 'device' : 'server',
      );
    }
  });

  it('every entry is exercised by a corpus line', () => {
    const unused = WIRE_ADDITIONS.filter((entry) => entry.kind === 'envelope'
      ? !corpus.some((line) => carries(line, entry))
      : !httpCorpus.some((line) => line.surface === entry.surface && Object.hasOwn(line.value, entry.field))).map(
      (entry) => `${entry.surface}${entry.field === undefined ? '' : `.${entry.field}`}${entry.rule === 'gated' && entry.value !== undefined ? `=${entry.value}` : ''}`,
    );
    expect(unused, 'append a corpus line that carries each of these (golden/v2.envelopes.ndjson is append-only)').toEqual([]);
  });

  it('every message type appears in the corpus', () => {
    const seen = new Set(corpus.map((line) => line.type));
    expect(MESSAGE_TYPES.filter((type) => !seen.has(type))).toEqual([]);
  });

  it('every top-level key a payload gained since the floor appears in the corpus', () => {
    const missing: string[] = [];
    for (const [type, schema] of Object.entries(MESSAGE_PAYLOAD_SCHEMAS)) {
      const released = (floorRelease.MESSAGE_PAYLOAD_SCHEMAS as Record<string, unknown>)[type];
      const releasedKeys = new Set(released === undefined ? [] : topLevelKeys(released));
      const corpusKeys = new Set(corpus.filter((line) => line.type === type).flatMap((line) => Object.keys(line.payload)));
      for (const key of topLevelKeys(schema)) if (!releasedKeys.has(key) && !corpusKeys.has(key)) missing.push(`${type}.${key}`);
    }
    expect(missing, 'the released decoders cannot see a key no corpus line carries; append a line with it').toEqual([]);
  });

  it('requiredReceiverCapabilities derives field and value gates from the table', () => {
    expect(requiredReceiverCapabilities('task.offer_for_agent', { homeAccess: 'memory-reader' })).toEqual([
      'agent-home-contract',
      'agent-home-readers',
    ]);
    expect(requiredReceiverCapabilities('task.offer_for_agent', {})).toEqual(['agent-home-contract']);
    expect(requiredReceiverCapabilities('agent.content.read', { surface: 'transcript' })).toContain('agent-content-transcript-read');
    expect(requiredReceiverCapabilities('agent.content.read', { surface: 'transcript' })).not.toContain('agent-content-workspace-read');
    expect(requiredReceiverCapabilities('task.progress', {})).toEqual([]);
  });
});

/** Top-level keys of a payload schema (every branch of a union). */
function topLevelKeys(schema: unknown): string[] {
  const def = (schema as { _zod: { def: { type: string; options?: unknown[] } } })._zod.def;
  if (def.type === 'union') return (def.options ?? []).flatMap(topLevelKeys);
  if (def.type !== 'object') throw new Error(`unsupported payload schema kind: ${def.type}`);
  return Object.keys((schema as { shape: Record<string, unknown> }).shape);
}

// ---------------------------------------------------------------------------
// Corpus completeness: every recursive path and every enum/literal value
// ---------------------------------------------------------------------------

/**
 * Paths are derived from the real current schemas (`z.toJSONSchema`, input
 * mode), never hand-maintained. Segments: `.key` for a property, `[]` for array
 * items, `.*` for record values, `|i` for union branch `i` (anyOf/oneOf), and
 * `#name` for a shared/recursive definition, which is enumerated once and
 * covered by every value that reaches it. `path=<json>` is an enum or literal
 * value. A value counts toward the first union branch that structurally
 * accepts it (types, literals, required keys, patterns and bounds; refinements
 * are not representable), mirroring zod's ordered union decoding.
 */
interface SchemaCoverage {
  readonly paths: Set<string>;
  readonly values: Set<string>;
}

type SchemaNode = { [key: string]: Json };

function schemaNode(node: Json | undefined): SchemaNode | undefined {
  return node !== null && typeof node === 'object' && !Array.isArray(node) ? node : undefined;
}

function definition(root: SchemaNode, ref: Json): { name: string; node: SchemaNode } {
  const match = typeof ref === 'string' ? /^#\/\$defs\/(.+)$/.exec(ref) : null;
  const node = match === null ? undefined : schemaNode(schemaNode(root.$defs)?.[match[1]!]);
  if (match === null || node === undefined) throw new Error(`unresolvable $ref ${JSON.stringify(ref)}`);
  return { name: match[1]!, node };
}

function recordValues(node: SchemaNode): SchemaNode | undefined {
  const values = schemaNode(node.additionalProperties);
  if (values === undefined) return undefined;
  return 'propertyNames' in node || Object.keys(values).length > 0 ? values : undefined;
}

function branches(node: SchemaNode): readonly SchemaNode[] {
  return [...(Array.isArray(node.anyOf) ? node.anyOf : []), ...(Array.isArray(node.oneOf) ? node.oneOf : [])]
    .map((branch) => schemaNode(branch)!);
}

function requiredCoverage(root: SchemaNode, prefix: string, exempt: (path: string) => boolean): SchemaCoverage {
  const required: SchemaCoverage = { paths: new Set(), values: new Set() };
  const visit = (node: SchemaNode, path: string): void => {
    // An exempt subtree is not enumerated, so neither are definitions only it reaches.
    if (exempt(path)) return;
    required.paths.add(path);
    if (node.$ref !== undefined) {
      const { name, node: target } = definition(root, node.$ref);
      const canonical = `${prefix}#${name}`;
      if (!required.paths.has(canonical)) visit(target, canonical);
    }
    for (const part of Array.isArray(node.allOf) ? node.allOf : []) visit(schemaNode(part)!, path);
    branches(node).forEach((branch, index) => visit(branch, `${path}|${index}`));
    if ('const' in node) required.values.add(`${path}=${JSON.stringify(node.const)}`);
    if (Array.isArray(node.enum)) for (const member of node.enum) required.values.add(`${path}=${JSON.stringify(member)}`);
    for (const [key, property] of Object.entries(schemaNode(node.properties) ?? {})) visit(schemaNode(property)!, `${path}.${key}`);
    const items = schemaNode(node.items);
    if (items !== undefined) visit(items, `${path}[]`);
    const values = recordValues(node);
    if (values !== undefined) visit(values, `${path}.*`);
  };
  visit(root, prefix);
  return required;
}

/** Structural acceptance, used only to attribute a value to union branches. */
function accepts(root: SchemaNode, node: SchemaNode, value: unknown): boolean {
  if (node.$ref !== undefined && !accepts(root, definition(root, node.$ref).node, value)) return false;
  if (Array.isArray(node.allOf) && !node.allOf.every((part) => accepts(root, schemaNode(part)!, value))) return false;
  const options = branches(node);
  if (options.length > 0 && !options.some((branch) => accepts(root, branch, value))) return false;
  if ('const' in node && JSON.stringify(node.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(node.enum) && !node.enum.some((member) => JSON.stringify(member) === JSON.stringify(value))) return false;
  if (typeof node.type === 'string') {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = node.type === 'integer' ? Number.isInteger(value) : node.type === 'number' ? typeof value === 'number' : node.type === kind;
    if (!ok) return false;
  }
  if (typeof value === 'string') {
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) return false;
    if (typeof node.minLength === 'number' && [...value].length < node.minLength) return false;
    if (typeof node.maxLength === 'number' && [...value].length > node.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) return false;
    if (typeof node.maximum === 'number' && value > node.maximum) return false;
    if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) return false;
    if (typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) return false;
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) return false;
    const items = schemaNode(node.items);
    if (items !== undefined && !value.every((item) => accepts(root, items, item))) return false;
  } else if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    if (Array.isArray(node.required) && !node.required.every((key) => typeof key === 'string' && key in fields)) return false;
    const properties = schemaNode(node.properties) ?? {};
    for (const [key, field] of Object.entries(fields)) {
      const property = schemaNode(properties[key]);
      if (property !== undefined) {
        if (!accepts(root, property, field)) return false;
      } else if (node.additionalProperties === false) {
        return false;
      } else {
        const values = schemaNode(node.additionalProperties);
        if (values !== undefined && !accepts(root, values, field)) return false;
      }
    }
  }
  return true;
}

function observedCoverage(root: SchemaNode, prefix: string, samples: readonly unknown[]): SchemaCoverage {
  const seen: SchemaCoverage = { paths: new Set(), values: new Set() };
  const visit = (node: SchemaNode, value: unknown, path: string): void => {
    seen.paths.add(path);
    if (node.$ref !== undefined) {
      const { name, node: target } = definition(root, node.$ref);
      visit(target, value, `${prefix}#${name}`);
    }
    for (const part of Array.isArray(node.allOf) ? node.allOf : []) visit(schemaNode(part)!, value, path);
    // zod tries union options in order, so a value exercises the first accepting branch.
    const options = branches(node);
    const chosen = options.findIndex((branch) => accepts(root, branch, value));
    if (chosen >= 0) visit(options[chosen]!, value, `${path}|${chosen}`);
    if (('const' in node || Array.isArray(node.enum)) && accepts(root, { ...node, anyOf: [], oneOf: [] }, value)) {
      seen.values.add(`${path}=${JSON.stringify(value)}`);
    }
    if (Array.isArray(value)) {
      const items = schemaNode(node.items);
      if (items !== undefined) for (const item of value) visit(items, item, `${path}[]`);
    } else if (value !== null && typeof value === 'object') {
      const properties = schemaNode(node.properties) ?? {};
      const values = recordValues(node);
      for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
        const property = schemaNode(properties[key]);
        if (property !== undefined) visit(property, field, `${path}.${key}`);
        else if (values !== undefined) visit(values, field, `${path}.*`);
      }
    }
  };
  for (const sample of samples) visit(root, sample, prefix);
  return seen;
}

/**
 * Subtrees no corpus line of this surface needs to carry. Each names the exact
 * required path whose descendants it exempts (the path itself stays required)
 * and why. The reason is enforced mechanically, not trusted: the test pins the
 * exact set of exempted paths, requires the JSON Schema node at each one (and
 * the definitions it resolves against) to deep-equal the `EnvelopeSchema`
 * derivation, and requires the envelope corpus to cover every payload path
 * and value (per message type) and every header path and value (the
 * `envelope-header` surface). An exemption that prunes nothing also fails.
 */
const COMPLETENESS_EXEMPTIONS: readonly { readonly below: string; readonly reason: string }[] = [
  {
    below: 'http:EventsPollResponse.events[]',
    reason: 'The node is exactly EnvelopeSchema; the envelope corpus covers every payload path/value per message type and every header path/value.',
  },
  {
    below: 'http:MessagesSendRequest.messages[]',
    reason: 'The node is exactly EnvelopeSchema; the envelope corpus covers every payload path/value per message type and every header path/value.',
  },
];

const EXPECTED_EXEMPTION_PATHS: readonly string[] = [
  'http:EventsPollResponse.events[]',
  'http:MessagesSendRequest.messages[]',
];

const HEADER_PREFIX = 'envelope-header';

/** Resolve a `.key` / `[]` path (the only segments exemptions use) inside a surface schema. */
function nodeAtPath(root: SchemaNode, relative: string): SchemaNode {
  let node = root;
  for (const segment of relative.match(/\.[^.[\]|#]+|\[\]/g) ?? []) {
    const next = segment === '[]' ? schemaNode(node.items) : schemaNode(schemaNode(node.properties)?.[segment.slice(1)]);
    if (next === undefined) throw new Error(`exemption path does not resolve at ${segment}`);
    node = next;
  }
  return node;
}

/** Exemptions whose stated reason ("the node is exactly EnvelopeSchema") does not hold. */
function exemptionMismatches(): string[] {
  const { $schema: _schema, $defs: envelopeDefs, ...envelopeNode } = jsonSchema(EnvelopeSchema) as SchemaNode;
  const problems: string[] = [];
  for (const entry of COMPLETENESS_EXEMPTIONS) {
    const match = /^http:([A-Za-z]+)(.*)$/.exec(entry.below);
    if (match === null || (match[2] ?? '') === '') {
      problems.push(`${entry.below}: not an http surface sub-path`);
      continue;
    }
    const root = schemaNode(jsonSchema(httpSchema(currentModule, match[1]! as HttpSurface)))!;
    let node: SchemaNode;
    try {
      node = nodeAtPath(root, match[2]!);
    } catch (error) {
      problems.push(`${entry.below}: ${(error as Error).message}`);
      continue;
    }
    if (JSON.stringify(node) !== JSON.stringify(envelopeNode)) problems.push(`${entry.below}: node differs from the EnvelopeSchema JSON Schema`);
    if (JSON.stringify(root.$defs) !== JSON.stringify(envelopeDefs)) problems.push(`${entry.below}: definitions differ from the EnvelopeSchema JSON Schema`);
  }
  return problems;
}

/**
 * The envelope header (every EnvelopeSchema field except `payload`, which is
 * covered per message type) as one object schema. Branch headers differ only
 * in `type` (merged into one enum) and in `task_id` requiredness/forbiddance
 * (a forbidden `task_id` can never be present, so it is not a path to carry).
 */
function envelopeHeaderRoot(): SchemaNode {
  const schema = schemaNode(jsonSchema(EnvelopeSchema))!;
  const properties: Record<string, Json[]> = {};
  for (const branch of branches(schema)) {
    for (const [key, property] of Object.entries(schemaNode(branch.properties) ?? {})) {
      if (key === 'payload' || JSON.stringify(property) === '{"not":{}}') continue;
      (properties[key] ??= []).push(property);
    }
  }
  const merged: Record<string, Json> = {};
  for (const [key, nodes] of Object.entries(properties)) {
    if (key === 'type') {
      merged[key] = { enum: nodes.map((node) => schemaNode(node)!.const!) };
      continue;
    }
    const distinct = [...new Map(nodes.map((node) => [JSON.stringify(node), node])).values()];
    merged[key] = distinct.length === 1 ? distinct[0]! : { anyOf: distinct };
  }
  return { type: 'object', properties: merged };
}

function isBelow(path: string, ancestor: string): boolean {
  return path.length > ancestor.length && path.startsWith(ancestor) && '.|[#'.includes(path[ancestor.length]!);
}

function completeness(): { missingPaths: string[]; missingValues: string[]; unusedExemptions: string[] } {
  const required: SchemaCoverage = { paths: new Set(), values: new Set() };
  const seen: SchemaCoverage = { paths: new Set(), values: new Set() };
  const used = new Set<number>();
  const exempt = (path: string): boolean => {
    const index = COMPLETENESS_EXEMPTIONS.findIndex((entry) => isBelow(path, entry.below));
    if (index >= 0) used.add(index);
    return index >= 0;
  };
  const merge = (into: SchemaCoverage, from: SchemaCoverage) => {
    for (const path of from.paths) into.paths.add(path);
    for (const value of from.values) into.values.add(value);
  };
  for (const type of MESSAGE_TYPES) {
    const root = schemaNode(jsonSchema(MESSAGE_PAYLOAD_SCHEMAS[type]))!;
    const prefix = `envelope:${type}`;
    merge(required, requiredCoverage(root, prefix, exempt));
    merge(seen, observedCoverage(root, prefix, corpus.filter((line) => line.type === type).map((line) => line.payload)));
  }
  const header = envelopeHeaderRoot();
  merge(required, requiredCoverage(header, HEADER_PREFIX, () => false));
  merge(seen, observedCoverage(header, HEADER_PREFIX, corpus.map((line) => {
    const { payload: _payload, ...fields } = JSON.parse(line.raw) as Record<string, unknown>;
    return fields;
  })));
  for (const surface of [...new Set(httpCorpus.map((line) => line.surface))]) {
    const root = schemaNode(jsonSchema(httpSchema(currentModule, surface)))!;
    const prefix = `http:${surface}`;
    merge(required, requiredCoverage(root, prefix, exempt));
    merge(seen, observedCoverage(root, prefix, httpCorpus.filter((line) => line.surface === surface).map((line) => JSON.parse(line.body) as unknown)));
  }
  return {
    missingPaths: [...required.paths].filter((path) => !seen.paths.has(path)).sort(),
    missingValues: [...required.values].filter((value) => !seen.values.has(value)).sort(),
    unusedExemptions: COMPLETENESS_EXEMPTIONS.filter((_, index) => !used.has(index)).map((entry) => entry.below),
  };
}

describe('compat: corpus completeness', () => {
  it('every recursive payload/header/body path and every enum or literal value appears in at least one corpus line', () => {
    const result = completeness();
    expect(COMPLETENESS_EXEMPTIONS.map((entry) => entry.below), 'the exempted subtrees are pinned; adding one needs a reviewed change here').toEqual(EXPECTED_EXEMPTION_PATHS);
    expect(exemptionMismatches(), 'an exempted node must be exactly the envelope schema the envelope corpus proves').toEqual([]);
    expect(result.unusedExemptions, 'a completeness exemption no longer matches any required path; delete it').toEqual([]);
    expect(result.missingPaths, 'append a corpus line carrying each path (both corpora are append-only)').toEqual([]);
    expect(result.missingValues, 'append a corpus line carrying each enum/literal value').toEqual([]);
  });
});
