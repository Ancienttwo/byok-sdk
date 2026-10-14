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
 * The corpus `golden/v2.envelopes.ndjson` is append-only. Each registered
 * release pins a sha256 of the corpus prefix it shipped with; editing a
 * released line fails here. To register a release, add the entry this file
 * prints (docs/releases/README.md).
 */

const require = createRequire(import.meta.url);
const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));
const corpusPath = `${goldenDir}v2.envelopes.ndjson`;

interface ReleaseEntry {
  readonly version: string;
  readonly envelopes: { readonly lines: number; readonly sha256: string };
}
interface ReleaseRegistry {
  readonly floor: string;
  readonly releases: readonly ReleaseEntry[];
}

const registry = JSON.parse(readFileSync(`${goldenDir}releases.json`, 'utf8')) as ReleaseRegistry;
const corpusText = readFileSync(corpusPath, 'utf8');
const rawLines = corpusText.split('\n').filter((line) => line.length > 0);

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

function prefixEntry(version: string, lines: number): ReleaseEntry {
  const prefix = rawLines.slice(0, lines).map((line) => `${line}\n`).join('');
  return { version, envelopes: { lines, sha256: createHash('sha256').update(prefix).digest('hex') } };
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
        prefixEntry(entry.version, entry.envelopes.lines),
        `golden/v2.envelopes.ndjson lines 1-${entry.envelopes.lines} shipped with ${entry.version} and are append-only`,
      ).toEqual(entry);
    },
  );

  it('the current stable package version is registered', () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) return;
    const entry = registry.releases.find((candidate) => candidate.version === version);
    expect(
      entry,
      `@byok-sdk/protocol ${version} is not in golden/releases.json. Append this entry: ${JSON.stringify(prefixEntry(version, rawLines.length))}`,
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
  return WIRE_ADDITIONS.filter((entry) => entry.surface === type && entry.field === field);
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
  if (line.type !== entry.surface) return false;
  if (entry.field === undefined) return true;
  const value = line.payload[entry.field];
  if (value === undefined) return false;
  return entry.rule !== 'gated' || entry.value === undefined || value === entry.value;
}

describe('compat: WIRE_ADDITIONS', () => {
  it('every entry names a current message type and capability, in the right direction', () => {
    for (const entry of WIRE_ADDITIONS) {
      expect(MESSAGE_TYPES).toContain(entry.surface);
      if (entry.rule !== 'gated') continue;
      expect(CAPABILITY_FLAGS).toContain(entry.capability);
      expect(entry.advertisedBy, `${entry.surface} flows ${isServerToDaemonType(entry.surface) ? 'to the daemon' : 'to the server'}`).toBe(
        isServerToDaemonType(entry.surface) ? 'device' : 'server',
      );
    }
  });

  it('every entry is exercised by a corpus line', () => {
    const unused = WIRE_ADDITIONS.filter((entry) => !corpus.some((line) => carries(line, entry))).map(
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
