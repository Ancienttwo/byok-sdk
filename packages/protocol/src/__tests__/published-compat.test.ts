import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as floorRelease from 'byok-protocol-floor';
import * as currentModule from '../index';
import {
  MESSAGE_TYPES, MESSAGE_PAYLOAD_SCHEMAS, CAPABILITY_FLAGS, TASK_STATES,
  KNOWN_AGENT_EVENT_TYPES, TASK_TRANSITIONS, MAX_MESSAGES_PER_BATCH,
  CONTENT_HASH_RE, WIRE_ADDITIONS, isServerToDaemonType,
  requiredReceiverCapabilities, type MessageType, type WireAddition,
} from '../index';

// The registry tarball is independent of the workspace source. The retired
// v2 decoder remains a rejection oracle in compat.test.ts.
const require = createRequire(import.meta.url);
const golden = new URL('./golden/', import.meta.url);
const registry = JSON.parse(readFileSync(new URL('v3.releases.json', golden), 'utf8')) as {
  floor: string; releases: readonly { version: string }[];
};
function packageVersion(name: string): string {
  return (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
}
const corpus = readFileSync(new URL('v3.envelopes.ndjson', golden), 'utf8').trimEnd().split('\n').map((raw, index) => {
  const envelope = JSON.parse(raw) as { type: MessageType; payload: Record<string, unknown> };
  return { raw, index, ...envelope };
});
type ProtocolModule = typeof floorRelease;
const PINNED: readonly (readonly [string, ProtocolModule])[] = [
  [`floor ${packageVersion('byok-protocol-floor')}`, floorRelease],
];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function jsonSchema(schema: unknown): Json {
  return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Json;
}

describe('compat v3: independent published floor identity', () => {
  it('pins the first registered v3 release by its registry tarball URL', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(packageVersion('byok-protocol-floor')).toBe(registry.floor);
    expect(registry.releases[0]?.version).toBe(registry.floor);
    expect(floorRelease.PROTOCOL_VERSION).toBe(currentModule.PROTOCOL_VERSION);
    expect(manifest.devDependencies['byok-protocol-floor']).toBe(
      `https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-${registry.floor}.tgz`,
    );
    expect(realpathSync(require.resolve('byok-protocol-floor/package.json'))).not.toBe(
      realpathSync(fileURLToPath(new URL('../../package.json', import.meta.url))),
    );
  });
});

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
      if (schema === null || typeof schema !== 'object' || !('_zod' in schema)) continue;
      const current = (currentModule as Record<string, unknown>)[name];
      if (current === null || typeof current !== 'object' || !('_zod' in current)) found.push(`${name}: schema export removed`);
      else narrowing(jsonSchema(schema), jsonSchema(current), name, found);
    }
    expect(
      found,
      'a released shape was removed, changed or narrowed (a bound, an enum value, strictness, a required field). ' +
        'That is the version-bump path in docs/protocol.md "Freeze rule"; restore the released shape instead.',
    ).toEqual([]);
  });
});

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
function unknownGatedFields(type: MessageType, payload: unknown, releasedFlags: readonly string[]): string[] {
  const fields = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const required = requiredReceiverCapabilities(type, payload);
  return Object.keys(fields).filter(field => fields[field] !== undefined && fieldEntries(type, field).some(entry =>
    entry.rule === 'gated' && required.includes(entry.capability) && !releasedFlags.includes(entry.capability)
    && (entry.value === undefined || fields[field] === entry.value),
  ));
}

function declaredForRelease(type: MessageType, path: string, releasedFlags: readonly string[], payload: unknown): boolean {
  const normalized = path.replace(/\[\d+\]/g, '[]');
  const topLevel = normalized.split(/[.[]/)[0]!;
  return (
    fieldEntries(type, normalized).some((entry) => entry.rule === 'strip-safe') ||
    unknownGatedFields(type, payload, releasedFlags).includes(topLevel)
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
        const required = requiredReceiverCapabilities(type, line.payload);
        const unknownFlags = WIRE_ADDITIONS.flatMap(entry => entry.kind === 'envelope' && entry.rule === 'gated'
          && entry.surface === type && entry.field === undefined && required.includes(entry.capability)
          && !releasedFlags.includes(entry.capability) ? [entry.capability] : []);
        expect(
          unknownFlags,
          `this release does not know ${type}. Gate the type in WIRE_ADDITIONS with a capability this release does not know.`,
        ).not.toEqual([]);
        return;
      }
      if (!result.ok) {
        const gated = unknownGatedFields(type, line.payload, releasedFlags);
        expect(gated, `this release rejects line ${line.index + 1} (${type}): ${String(result.error)}. Gate the new field in WIRE_ADDITIONS with a capability this release does not know, or bump PROTOCOL_VERSION.`).not.toEqual([]);
        const stripped = JSON.parse(line.raw) as { payload: Record<string, unknown> };
        for (const field of gated) delete stripped.payload[field];
        const retry = decodeWith(release, JSON.stringify(stripped));
        expect(retry.ok, `without its gated fields (${gated.join(', ')}) line ${line.index + 1} must be accepted; something else is incompatible`).toBe(true);
        if (retry.ok) assertReceivedPayload(stripped.payload, retry.payload, type, releasedFlags);
        return;
      }
      assertReceivedPayload(line.payload, result.payload, type, releasedFlags);
    },
  );
});


/** Remove only paths the real published decoder demonstrably omitted. */
function withoutPaths(value: unknown, removed: ReadonlySet<string>, path = ''): unknown {
  if (Array.isArray(value)) return value.map((item, index) => withoutPaths(item, removed, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const next = path === '' ? key : `${path}.${key}`;
    return removed.has(next) ? [] : [[key, withoutPaths(item, removed, next)]];
  }));
}

function assertReceivedPayload(sent: unknown, received: unknown, type: MessageType, flags: readonly string[]): void {
  const dropped: string[] = [];
  droppedPaths(sent, received, '', dropped);
  expect(dropped.filter(path => !declaredForRelease(type, path, flags, sent)),
    `published decoder dropped undeclared ${type} fields`).toEqual([]);
  expect(received, 'published decoder changed a value beyond declared field loss').toEqual(withoutPaths(sent, new Set(dropped)));
}

type HttpSurface = 'ChallengeRequest' | 'ChallengeResponse' | 'TokenRequest' | 'TokenResponse'
  | 'EventsPollQuery' | 'EventsPollResponse' | 'MessagesSendRequest' | 'MessagesSendResponse';
interface HttpLine { surface: HttpSurface; body: string; value: Record<string, unknown> }
const httpCorpus = readFileSync(new URL('v3.http.ndjson', golden), 'utf8').trimEnd().split('\n')
  .map(raw => JSON.parse(raw) as HttpLine);
function assertPublishedHttp(line: HttpLine): void {
  const schema = (floorRelease as unknown as Record<string, { parse(value: unknown): Record<string, unknown> }>)[`${line.surface}Schema`];
  expect(schema, `published ${line.surface} schema exists`).toBeDefined();
  const decoded = schema!.parse(JSON.parse(line.body));
  const dropped: string[] = [];
  droppedPaths(line.value, decoded, '', dropped);
  const allowed = (path: string) => {
    const top = path.split(/[.[]/)[0]!;
    return WIRE_ADDITIONS.some(entry => entry.kind === 'http' && entry.rule === 'strip-safe'
      && entry.surface === line.surface && entry.field === top);
  };
  expect(dropped.filter(path => !allowed(path)), `published HTTP decoder dropped undeclared ${line.surface} fields`).toEqual([]);
  expect(decoded).toEqual(withoutPaths(line.value, new Set(dropped)));
  // EventsPollResponse deliberately leaves entries unknown. Prove them with
  // the published envelope decoder too, rather than trusting the outer page.
  if (line.surface === 'EventsPollResponse') {
    for (const event of decoded.events as readonly unknown[]) {
      const sent = event as { type: MessageType; payload: unknown };
      const received = floorRelease.parseMessage(event);
      assertReceivedPayload(sent.payload, received.payload, sent.type, floorRelease.CAPABILITY_FLAGS);
    }
  }
}

describe('compat v3: published HTTP decoder', () => {
  it.each(httpCorpus.map((line, index) => [index + 1, line.surface, line] as const))(
    'reads HTTP line %i (%s) with only declared strip-safe loss', (_index, _surface, line) => assertPublishedHttp(line),
  );
});

describe('compat v3: value-gate controls', () => {
  const withoutWorkspace = floorRelease.CAPABILITY_FLAGS.filter(flag => flag !== 'agent-content-workspace-read');
  it('does not apply a workspace value gate to transcript requests', () => {
    const payload = { surface: 'transcript' };
    expect(requiredReceiverCapabilities('agent.content.read', payload)).not.toContain('agent-content-workspace-read');
    expect(declaredForRelease('agent.content.read', 'surface', withoutWorkspace, payload)).toBe(false);
    expect(unknownGatedFields('agent.content.read', payload, withoutWorkspace)).toEqual([]);
  });
  it('applies the gate only when its value matches', () => {
    const payload = { surface: 'workspace' };
    expect(requiredReceiverCapabilities('agent.content.read', payload)).toContain('agent-content-workspace-read');
    expect(declaredForRelease('agent.content.read', 'surface', withoutWorkspace, payload)).toBe(true);
    expect(unknownGatedFields('agent.content.read', payload, withoutWorkspace)).toEqual(['surface']);
  });
});

describe('compat v3: guard negative controls', () => {
  it('detects enum removal and a new bound, while allowing new enum values', () => {
    const removed: string[] = [];
    narrowing({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] }, 'control', removed);
    expect(removed).not.toEqual([]);
    const bound: string[] = [];
    narrowing({ type: 'string' }, { type: 'string', maxLength: 1 }, 'control', bound);
    expect(bound).not.toEqual([]);
    const widened: string[] = [];
    narrowing({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] }, 'control', widened);
    expect(widened).toEqual([]);
  });

  it('detects undeclared loss through the real published envelope decoder', () => {
    const line = corpus.find(entry => entry.type === 'task.progress')!;
    const sent = { ...line.payload, undeclaredCompatProbe: true };
    const decoded = floorRelease.decodeEnvelope(JSON.stringify({ ...JSON.parse(line.raw), payload: sent }));
    expect(() => assertReceivedPayload(sent, decoded.payload, line.type, floorRelease.CAPABILITY_FLAGS)).toThrow('undeclared');
  });

  it('detects undeclared HTTP loss through the real published HTTP decoder', () => {
    const line = httpCorpus.find(entry => entry.surface === 'ChallengeResponse')!;
    const value = { ...line.value, undeclaredCompatProbe: true };
    expect(() => assertPublishedHttp({ ...line, body: JSON.stringify(value), value })).toThrow('undeclared');
  });
});
