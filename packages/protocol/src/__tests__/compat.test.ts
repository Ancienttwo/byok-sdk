import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v3Release from 'byok-protocol-previous';
import * as currentModule from '../index';
import {
  AgentMemorySelectionSchema,
  CAPABILITY_FLAGS,
  EnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  EnvelopeValidationError,
  UnknownMessageTypeError,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  WIRE_ADDITIONS,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  isServerToDaemonType,
  parseMessage,
  requiredReceiverCapabilities,
  type MessageType,
  type WireAddition,
} from '../index';

/**
 * Executable wire-major-4 compatibility evidence (docs/protocol.md "Freeze
 * rule", docs/releases/README.md).
 *
 * v4 has no v3 reader, and no v4 release has been published yet, so there is
 * no published v4 decoder to prove additions against. This file keeps:
 *
 * 1. Retired v2 evidence. `golden/v2.envelopes.ndjson`, `golden/v2.http.ndjson`
 *    and the v2 release registry `golden/releases.json` are byte-identical to
 *    what v2 shipped. They are a negative oracle: the current decoder rejects
 *    every v2 envelope on its protocol version and nothing else.
 * 2. Retired v3 evidence. `golden/v3.envelopes.ndjson`, `golden/v3.http.ndjson`
 *    and `golden/v3.releases.json` (0.27.0 through 0.30.2) are byte-identical
 *    to what v3 shipped. The current decoder rejects every v3 envelope on its
 *    protocol version.
 * 3. v4 self-consistency. `golden/v4.envelopes.ndjson` and
 *    `golden/v4.http.ndjson` are append-only and the current decoder reads
 *    them exactly. `golden/v4.releases.json` has no release and no floor yet.
 * 4. Published rejection oracle. `byok-protocol-previous` (0.30.2, the last
 *    v3 release) rejects every v4 corpus line and a v4 `conn.hello`: a v3
 *    peer cannot read v4 bytes. None of its bytes is v4 evidence.
 */

const require = createRequire(import.meta.url);
const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));

function readGolden(name: string): string {
  return readFileSync(`${goldenDir}${name}`, 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Keeps empty lines: silently filtering them would hide a byte mutation. */
function ndjsonLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function packageVersion(specifier: string): string {
  return (JSON.parse(readFileSync(require.resolve(`${specifier}/package.json`), 'utf8')) as { version: string }).version;
}

function prefixHash(lines: readonly string[], length: number): { lines: number; sha256: string } {
  return { lines: length, sha256: sha256(lines.slice(0, length).map((line) => `${line}\n`).join('')) };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

interface ReleaseEntry {
  readonly version: string;
  readonly envelopes: { readonly lines: number; readonly sha256: string };
  readonly http?: { readonly lines: number; readonly sha256: string };
}

interface CorpusLine {
  readonly index: number;
  readonly raw: string;
  readonly type: MessageType;
  readonly payload: Record<string, unknown>;
}

function corpusOf(lines: readonly string[]): CorpusLine[] {
  return lines.map((raw, index) => {
    const parsed = JSON.parse(raw) as { type: MessageType; payload: Record<string, unknown> };
    return { index, raw, type: parsed.type, payload: parsed.payload };
  });
}

type HttpSurface = 'ChallengeRequest' | 'ChallengeResponse' | 'TokenRequest' | 'TokenResponse'
  | 'EventsPollQuery' | 'EventsPollResponse' | 'MessagesSendRequest' | 'MessagesSendResponse';

interface HttpCorpusLine {
  readonly index: number;
  readonly surface: HttpSurface;
  /** Literal wire body; the expected value is authored independently. */
  readonly body: string;
  readonly value: Record<string, unknown>;
  readonly batchLength?: number;
}

function httpCorpusOf(lines: readonly string[]): HttpCorpusLine[] {
  return lines.map((raw, index) => ({ ...(JSON.parse(raw) as Omit<HttpCorpusLine, 'index'>), index }));
}

function httpSchema(module: object, surface: HttpSurface): { safeParse(input: unknown): { success: boolean; data?: unknown }; parse(input: unknown): Record<string, unknown> } {
  const schema = (module as Record<string, unknown>)[`${surface}Schema`];
  if (schema === undefined) throw new Error(`missing HTTP schema: ${surface}`);
  return schema as ReturnType<typeof httpSchema>;
}

/** HTTP bodies that carry envelopes, and therefore a wire major. */
function carriesEnvelopes(line: HttpCorpusLine): boolean {
  const envelopes = line.value.events ?? line.value.messages;
  return Array.isArray(envelopes) && envelopes.length > 0;
}

/**
 * #386: the one HTTP body whose envelopes its own schema leaves undecoded. The
 * events page schema carries `events` as `unknown[]`; the client decodes each
 * entry on its own with `parseMessage`, so one unknown or invalid entry stalls
 * only its own sequence. Every envelope assertion on such a body therefore runs
 * `parseMessage` over each entry. Pinned: any other surface still decodes its
 * envelopes in the body schema.
 */
const ENTRY_DECODED_ENVELOPES: Readonly<Partial<Record<HttpSurface, 'events'>>> = { EventsPollResponse: 'events' };

function undecodedEntries(line: HttpCorpusLine, decoded: Record<string, unknown>): readonly unknown[] | undefined {
  const key = ENTRY_DECODED_ENVELOPES[line.surface];
  if (key === undefined) return undefined;
  const entries = decoded[key];
  if (!Array.isArray(entries)) throw new Error(`${line.surface}.${key} did not decode to an array`);
  return entries;
}

/**
 * A retired-major line is rejected on its protocol version. A type a later
 * major removed (v4: the handshake answer and the runtime-only offers) is unknown to the
 * current decoder before its version is read.
 */
function expectRetiredMajorRejected(line: CorpusLine, message: string): void {
  let error: unknown;
  try {
    decodeEnvelope(line.raw);
  } catch (caught) {
    error = caught;
  }
  if (!MESSAGE_TYPES.includes(line.type)) {
    expect(error, message).toBeInstanceOf(UnknownMessageTypeError);
    return;
  }
  expect(error, message).toBeInstanceOf(EnvelopeValidationError);
  expect((error as EnvelopeValidationError).issues.issues.some((issue) => issue.path[0] === 'v')).toBe(true);
}

// ---------------------------------------------------------------------------
// 1. Retired v2 evidence: frozen bytes, negative oracle
// ---------------------------------------------------------------------------

const V2_ENVELOPES = readGolden('v2.envelopes.ndjson');
const V2_HTTP = readGolden('v2.http.ndjson');
const V2_REGISTRY = readGolden('releases.json');
const v2Lines = ndjsonLines(V2_ENVELOPES);
const v2Corpus = corpusOf(v2Lines);
const v2HttpCorpus = httpCorpusOf(ndjsonLines(V2_HTTP));
const v2Registry = JSON.parse(V2_REGISTRY) as { readonly floor: string; readonly releases: readonly ReleaseEntry[] };

/** The v2 releases, pinned literally. v2 shipped no HTTP prefix; none may be invented. */
const V2_RELEASES: readonly ReleaseEntry[] = [
  { version: '0.25.0', envelopes: { lines: 32, sha256: '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04' } },
  { version: '0.26.0', envelopes: { lines: 32, sha256: '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04' } },
  { version: '0.26.1', envelopes: { lines: 32, sha256: '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04' } },
];

describe('compat: retired v2 evidence is frozen', () => {
  it('the v2 corpora and the v2 release registry are byte-identical to the v2 cut', () => {
    expect(sha256(V2_ENVELOPES), 'golden/v2.envelopes.ndjson is retired v2 evidence and read-only').toBe(
      'ba572f88a4254f5d155caa090aa12084c51e5187e2c8ed4a2ebed4d666a33680',
    );
    expect(sha256(V2_HTTP), 'golden/v2.http.ndjson is retired v2 evidence and read-only').toBe(
      'cba040218806666329351ee577f63a062b6268deb8b8c5f880358020c1a1cd63',
    );
    expect(sha256(V2_REGISTRY), 'golden/releases.json is the retired v2 registry and read-only').toBe(
      '086cdb1035de6fe32aeace87f69528edd9b5db88f63b50757244928148ca67da',
    );
  });

  it('the v2 registry still pins the prefixes v2 releases shipped with', () => {
    expect(v2Registry.floor).toBe('0.25.0');
    expect(v2Registry.releases).toEqual(V2_RELEASES);
    for (const entry of v2Registry.releases) {
      expect(prefixHash(v2Lines, entry.envelopes.lines), `v2 lines 1-${entry.envelopes.lines} shipped with ${entry.version}`).toEqual(entry.envelopes);
    }
  });
});

describe('compat: the current decoder rejects every v2 envelope on its protocol version', () => {
  it.each(v2Corpus.map((line) => [line.index + 1, line.type, line] as const))(
    'v2 line %i (%s) is rejected at the retired wire-major boundary',
    (_n, _type, line) => expectRetiredMajorRejected(line, 'there is no v2 reader'),
  );

  it.each(v2HttpCorpus.filter(carriesEnvelopes).map((line) => [line.index + 1, line.surface, line] as const))(
    'v2 HTTP line %i (%s) carries v2 envelopes and is rejected by the current HTTP decoder',
    (_n, surface, line) => {
      const page = httpSchema(currentModule, surface).safeParse(JSON.parse(line.body));
      const entries = page.success ? undecodedEntries(line, page.data as Record<string, unknown>) : undefined;
      if (entries === undefined) {
        expect(page.success, 'the body schema decodes its envelopes').toBe(false);
        return;
      }
      // The page carries its entries undecoded; each v2 entry is rejected on its own.
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        let error: unknown;
        try {
          parseMessage(entry);
        } catch (caught) {
          error = caught;
        }
        expect(error, 'there is no v2 reader').toBeInstanceOf(EnvelopeValidationError);
        expect((error as EnvelopeValidationError).issues.issues.some((issue) => issue.path[0] === 'v')).toBe(true);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Retired v3 evidence: frozen bytes, negative oracle
// ---------------------------------------------------------------------------

const V3_ENVELOPES = readGolden('v3.envelopes.ndjson');
const V3_HTTP = readGolden('v3.http.ndjson');
const V3_REGISTRY = readGolden('v3.releases.json');
const v3Lines = ndjsonLines(V3_ENVELOPES);
const v3Corpus = corpusOf(v3Lines);
const v3HttpCorpus = httpCorpusOf(ndjsonLines(V3_HTTP));
const v3Registry = JSON.parse(V3_REGISTRY) as { readonly floor: string; readonly releases: readonly ReleaseEntry[] };

describe('compat: retired v3 evidence is frozen', () => {
  it('the v3 corpora and the v3 release registry are byte-identical to the last v3 release (0.30.2)', () => {
    expect(sha256(V3_ENVELOPES), 'golden/v3.envelopes.ndjson is retired v3 evidence and read-only').toBe(
      '3d31c5d4c539d09cac4de2b481501bec30bf83cbad7d1857b41e2eb9c0df4102',
    );
    expect(sha256(V3_HTTP), 'golden/v3.http.ndjson is retired v3 evidence and read-only').toBe(
      'c24f0d3e67aa8712a8f2c5f651363bcc87d62744c0e946122d47dfd39a95e43d',
    );
    expect(sha256(V3_REGISTRY), 'golden/v3.releases.json is the retired v3 registry and read-only').toBe(
      '6803cb12d6c3e3e170ad87b4943bb9827fcc105bb4296c52ea71a3305367e941',
    );
  });

  it('the v3 registry still pins the prefixes v3 releases shipped with', () => {
    expect(v3Registry.floor).toBe('0.27.0');
    expect(v3Registry.releases.at(-1)?.version).toBe('0.30.2');
    for (const entry of v3Registry.releases) {
      expect(prefixHash(v3Lines, entry.envelopes.lines), `v3 envelope lines shipped with ${entry.version}`).toEqual(entry.envelopes);
      expect(prefixHash(ndjsonLines(V3_HTTP), entry.http!.lines), `v3 HTTP lines shipped with ${entry.version}`).toEqual(entry.http);
    }
  });
});

describe('compat: the current decoder rejects every v3 envelope on its protocol version', () => {
  it.each(v3Corpus.map((line) => [line.index + 1, line.type, line] as const))(
    'v3 line %i (%s) is rejected at the retired wire-major boundary',
    (_n, _type, line) => expectRetiredMajorRejected(line, 'there is no v3 reader'),
  );

  it.each(v3HttpCorpus.filter(carriesEnvelopes).map((line) => [line.index + 1, line.surface, line] as const))(
    'v3 HTTP line %i (%s) carries v3 envelopes and is rejected by the current decoder',
    (_n, surface, line) => {
      const decoded = httpSchema(currentModule, surface).safeParse(JSON.parse(line.body));
      if (!decoded.success) return;
      // The page carries its entries undecoded; each v3 entry is rejected on its own.
      const entries = undecodedEntries(line, decoded.data as Record<string, unknown>);
      expect(entries, `${surface} decoded v3 envelopes in its body schema`).toBeDefined();
      for (const entry of entries!) expect(() => parseMessage(entry), 'there is no v3 reader').toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// 3. v4: self-consistency only — no published v4 decoder exists yet
// ---------------------------------------------------------------------------

const v4Lines = ndjsonLines(readGolden('v4.envelopes.ndjson'));
const v4Corpus = corpusOf(v4Lines);
const v4HttpText = readGolden('v4.http.ndjson');
const v4HttpLines = ndjsonLines(v4HttpText);
const v4HttpCorpus = httpCorpusOf(v4HttpLines);
const v4Registry = JSON.parse(readGolden('v4.releases.json')) as { readonly releases: readonly ReleaseEntry[] };

describe('compat v4 registry: no published v4 decoder exists yet, so cross-release gates are unproven', () => {
  it('the v4 registry has releases only, and no floor until a v4 release is supported', () => {
    expect(Object.keys(v4Registry)).toEqual(['releases']);
    expect(Array.isArray(v4Registry.releases)).toBe(true);
    expect(v4Registry.releases.map((entry) => entry.version).filter((version) =>
      V2_RELEASES.some((v2) => v2.version === version) || v3Registry.releases.some((v3) => v3.version === version)),
    'a v2 or v3 release is never v4 evidence').toEqual([]);
  });

  it('registered v4 releases are stable, ascending, pin both corpora, and their prefixes are unchanged', () => {
    let previous: ReleaseEntry | undefined;
    for (const entry of v4Registry.releases) {
      expect(entry.version, 'prereleases are not registered').toMatch(/^\d+\.\d+\.\d+$/);
      if (previous !== undefined) {
        expect(compareVersions(previous.version, entry.version)).toBeLessThan(0);
        expect(entry.envelopes.lines).toBeGreaterThanOrEqual(previous.envelopes.lines);
        expect(entry.http!.lines).toBeGreaterThanOrEqual(previous.http!.lines);
      }
      expect(entry.http, `HTTP prefix required for ${entry.version}`).toBeDefined();
      expect(prefixHash(v4Lines, entry.envelopes.lines), `v4 envelope lines shipped with ${entry.version} are append-only`).toEqual(entry.envelopes);
      expect(prefixHash(v4HttpLines, entry.http!.lines), `v4 HTTP lines shipped with ${entry.version} are append-only`).toEqual(entry.http);
      previous = entry;
    }
  });

  it('the current stable package version is registered in v4, unless the manifest still names a v3 release', () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) return;
    // Feature PRs leave the manifest at the current train; v4 bytes have not
    // been released while it still names a v3 release.
    if (v3Registry.releases.some((entry) => entry.version === version)) return;
    expect(
      v4Registry.releases.find((entry) => entry.version === version),
      `@byok-sdk/protocol ${version} is not in golden/v4.releases.json. Append this entry: ${JSON.stringify({
        version, envelopes: prefixHash(v4Lines, v4Lines.length), http: prefixHash(v4HttpLines, v4HttpLines.length),
      })}`,
    ).toBeDefined();
  });
});

describe('compat v4: the current decoder reads every v4 corpus line exactly (self-consistency; no published v4 decoder yet)', () => {
  it.each(v4Corpus.map((line) => [line.index + 1, line.type, line] as const))(
    'v4 line %i (%s) decodes, round-trips and deep-equals the committed JSON',
    (_n, _type, line) => {
      const decoded = decodeEnvelope(line.raw);
      expect(decoded.v).toBe(4);
      expect(decodeEnvelope(encodeEnvelope(decoded))).toEqual(decoded);
      expect(decoded, 'the current decoder dropped or changed a committed field').toEqual(JSON.parse(line.raw));
    },
  );

  it('every approval request and decision names its approval', () => {
    for (const type of ['task.await_approval', 'task.approve', 'task.reject'] as const) {
      const lines = v4Corpus.filter((line) => line.type === type);
      expect(lines.length, type).toBeGreaterThan(0);
      for (const line of lines) expect(typeof line.payload.approvalId, `${type} line ${line.index + 1}`).toBe('string');
      expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse({ summary: 'x', reason: 'x' }).success, `${type} without approvalId`).toBe(false);
    }
  });
});

function carries(line: CorpusLine, entry: WireAddition): boolean {
  if (entry.kind !== 'envelope' || line.type !== entry.surface) return false;
  if (entry.field === undefined) return true;
  const values = entry.field.split('.').reduce<unknown[]>((parents, segment) => parents.flatMap(parent => {
    if (parent === null || typeof parent !== 'object') return [];
    const array = segment.endsWith('[]');
    const value = (parent as Record<string, unknown>)[array ? segment.slice(0, -2) : segment];
    return array ? (Array.isArray(value) ? value : []) : [value];
  }), [line.payload]);
  const value = values.find(value => value !== undefined);
  if (value === undefined) return false;
  return entry.rule !== 'gated' || entry.value === undefined || value === entry.value;
}

/** The four Agent offer lanes of `task.offer`, by payload. */
const OFFER_LANE = {
  resume: (payload: Record<string, unknown>) => (payload.session as { mode: string }).mode === 'resume' && payload.egressPolicy === undefined,
  'resume with egress': (payload: Record<string, unknown>) => (payload.session as { mode: string }).mode === 'resume' && payload.egressPolicy !== undefined,
  fresh: (payload: Record<string, unknown>) => (payload.session as { mode: string }).mode === 'fresh' && payload.preparation === undefined,
  prepared: (payload: Record<string, unknown>) => payload.preparation !== undefined,
} as const;
const OFFER_LANES = Object.keys(OFFER_LANE) as (keyof typeof OFFER_LANE)[];

/** Whether a corpus prepared offer still parses with `agentMemory` replaced. */
function preparedWithMemory(agentMemory: string): boolean {
  const prepared = v4Corpus.find((line) => line.type === 'task.offer' && OFFER_LANE.prepared(line.payload))!;
  expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(prepared.payload).success).toBe(true);
  return MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse({ ...prepared.payload, agentMemory }).success;
}

describe('compat v4: corpus coverage and WIRE_ADDITIONS', () => {
  it('declares exactly one server gate for draft frames', () => {
    expect(WIRE_ADDITIONS.filter(entry => entry.surface === 'agent.message.draft')).toEqual([
      { kind: 'envelope', rule: 'gated', surface: 'agent.message.draft', capability: 'agent-message-draft', advertisedBy: 'server' },
    ]);
    expect(requiredReceiverCapabilities('agent.message.draft', {})).toEqual(['agent-message-draft']);
  });

  it('every message type appears in the v4 corpus', () => {
    const seen = new Set(v4Corpus.map((line) => line.type));
    expect(MESSAGE_TYPES.filter((type) => !seen.has(type))).toEqual([]);
  });

  it('every Agent offer lane carrying terminalProjection has a result-document line with a schema, and a task.complete carries a document', () => {
    for (const lane of OFFER_LANES) {
      expect(v4Corpus.some((line) => {
        const projection = line.payload.terminalProjection as { mode?: string; schema?: unknown } | undefined;
        return line.type === 'task.offer' && OFFER_LANE[lane](line.payload) && projection?.mode === 'result-document' && projection.schema !== undefined;
      }), `${lane} result-document line`).toBe(true);
    }
    expect(v4Corpus.some((line) => line.type === 'task.complete' && line.payload.document !== undefined)).toBe(true);
  });

  it('every entry names a current message type and capability, in the right direction', () => {
    for (const entry of WIRE_ADDITIONS) {
      if (entry.kind === 'http') {
        expect(Object.keys((httpSchema(currentModule, entry.surface) as unknown as { shape: object }).shape)).toContain(entry.field);
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

  it('every entry is exercised by a v4 corpus line', () => {
    const unused = WIRE_ADDITIONS.filter((entry) => entry.kind === 'envelope'
      ? !v4Corpus.some((line) => carries(line, entry))
      : !v4HttpCorpus.some((line) => line.surface === entry.surface && Object.hasOwn(line.value, entry.field))).map(
      (entry) => `${entry.surface}${entry.field === undefined ? '' : `.${entry.field}`}${entry.rule === 'gated' && entry.value !== undefined ? `=${entry.value}` : ''}`,
    );
    expect(unused, 'append a v4 corpus line that carries each of these (golden/v4.envelopes.ndjson is append-only)').toEqual([]);
  });

  it('gates the per-task agentMemory selection on every offer that carries it (#614)', () => {
    for (const agentMemory of ['none', 'read', 'read-write'] as const) {
      expect(requiredReceiverCapabilities('task.offer', { agentMemory }), agentMemory).toContain('agent-memory-selection');
    }
    expect(requiredReceiverCapabilities('task.offer', {})).not.toContain('agent-memory-selection');
    // v4 has one offer type, so a prepared offer's required selection takes the same gate. A daemon
    // advertises agent-memory-selection with agent-home-contract, so admission does not change.
    const prepared = v4Corpus.find((line) => line.type === 'task.offer' && OFFER_LANE.prepared(line.payload))!;
    expect(requiredReceiverCapabilities('task.offer', prepared.payload)).toContain('agent-memory-selection');
  });

  it('gates agentMemory read-if-admitted on its own flag, on the ordinary Agent offers only (#815)', () => {
    expect(requiredReceiverCapabilities('task.offer', { agentMemory: 'read-if-admitted' }))
      .toEqual(expect.arrayContaining(['agent-memory-selection', 'agent-memory-read-if-admitted']));
    for (const agentMemory of ['none', 'read', 'read-write'] as const) {
      expect(requiredReceiverCapabilities('task.offer', { agentMemory }), agentMemory).not.toContain('agent-memory-read-if-admitted');
    }
    expect(AgentMemorySelectionSchema.options).toEqual(['none', 'read', 'read-write', 'read-if-admitted', 'read-write-if-admitted']);
    // The prepared offer keeps the three prepared modes.
    expect(preparedWithMemory('read-if-admitted')).toBe(false);
  });

  it('gates agentMemory read-write-if-admitted on its own flag, on the plain and sealed ordinary Agent offers only (#833)', () => {
    const sealing = v4Corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined)!.payload.sealing;
    for (const extra of [{}, { sealing }]) {
      const required = requiredReceiverCapabilities('task.offer', { ...extra, agentMemory: 'read-write-if-admitted' });
      expect(required).toEqual(expect.arrayContaining(['agent-memory-selection', 'agent-memory-read-write-if-admitted']));
      expect(required).not.toContain('agent-memory-read-if-admitted');
      for (const agentMemory of ['none', 'read', 'read-write', 'read-if-admitted'] as const) {
        expect(requiredReceiverCapabilities('task.offer', { ...extra, agentMemory }), agentMemory).not.toContain('agent-memory-read-write-if-admitted');
      }
    }
    // The prepared offer keeps the three prepared modes.
    expect(preparedWithMemory('read-write-if-admitted')).toBe(false);
  });

  it('requiredReceiverCapabilities derives field and value gates from the table; document and the v2 strip-safe fields need none', () => {
    expect(requiredReceiverCapabilities('task.offer', { homeAccess: 'memory-reader' })).toEqual([
      'agent-home-contract',
      'agent-home-readers',
    ]);
    expect(requiredReceiverCapabilities('task.offer', {})).toEqual(['agent-home-contract']);
    expect(requiredReceiverCapabilities('agent.content.read', { surface: 'transcript' })).toContain('agent-content-transcript-read');
    expect(requiredReceiverCapabilities('agent.content.read', { surface: 'transcript' })).not.toContain('agent-content-workspace-read');
    expect(requiredReceiverCapabilities('task.progress', {})).toEqual([]);
    expect(requiredReceiverCapabilities('task.progress', { events: [
      { type: 'tool_use', tool: 'mcp__server__tool', mcp: { server: 'server', tool: 'tool' } },
      { type: 'tool_result', tool: 'mcp__server__tool', mcp: { server: 'server', tool: 'tool' } },
    ] })).toEqual([]);
    expect(requiredReceiverCapabilities('task.complete', { document: {}, finalMessage: 'x' })).toEqual([]);
    expect(requiredReceiverCapabilities('task.decline', { code: 'agent_home_writer_busy' })).toEqual([]);
    expect(WIRE_ADDITIONS.filter((entry) => entry.rule === 'strip-safe'), 'only declared optional observability fields are registered; v2 rows remain baseline').toEqual([
      { kind: 'envelope', rule: 'strip-safe', surface: 'conn.hello', field: 'runtimes[].capabilities.messageDraft' },
      { kind: 'envelope', rule: 'strip-safe', surface: 'conn.hello', field: 'harnesses[].capabilities.messageDraft' },
      { kind: 'envelope', rule: 'strip-safe', surface: 'task.claim', field: 'capabilities.messageDraft' },
      { kind: 'envelope', rule: 'strip-safe', surface: 'task.progress', field: 'events[].mcp' },
    ]);
  });
});

function assertBatchCounts(line: HttpCorpusLine, decoded: Record<string, unknown>): void {
  if (line.surface !== 'MessagesSendResponse') return;
  expect((decoded.accepted as number) + (decoded.rejected === undefined ? 0 : decoded.rejected as number),
    'accepted + rejected must account for the entire submitted batch').toBe(line.batchLength);
  const outcomes = decoded.outcomes as readonly { readonly outcome: string }[];
  // Outcomes are required and must agree with the authoritative counts.
  expect(outcomes.length, 'outcomes must correlate every submitted envelope').toBe(line.batchLength);
  expect(outcomes.filter((entry) => entry.outcome !== 'rejected').length,
    'accepted counts accepted and duplicate outcomes').toBe(decoded.accepted);
  expect(outcomes.filter((entry) => entry.outcome === 'rejected').length,
    'rejected counts rejected outcomes').toBe(decoded.rejected ?? 0);
}

function assertCurrentHttp(line: HttpCorpusLine): void {
  const decoded = httpSchema(currentModule, line.surface).parse(JSON.parse(line.body));
  expect(decoded, 'the current HTTP decoder dropped or changed the independently committed value').toEqual(line.value);
  for (const entry of undecodedEntries(line, decoded) ?? []) {
    expect(parseMessage(entry), 'the current envelope decoder dropped or changed a committed page entry').toEqual(entry);
  }
  assertBatchCounts(line, decoded);
}

describe('compat v4: HTTP corpus (self-consistency; no published v4 decoder yet)', () => {
  it('covers all eight scoped HTTP route schemas with owned bodies and independent expected values', () => {
    const surfaces: readonly HttpSurface[] = ['ChallengeRequest', 'ChallengeResponse', 'TokenRequest', 'TokenResponse',
      'EventsPollQuery', 'EventsPollResponse', 'MessagesSendRequest', 'MessagesSendResponse'];
    expect([...new Set(v4HttpCorpus.map((line) => line.surface))].sort()).toEqual([...surfaces].sort());
    expect(v4HttpText.endsWith('\n'), 'literal corpus lines must be newline terminated').toBe(true);
    for (const line of v4HttpCorpus) {
      expect(typeof line.body).toBe('string');
      expect(JSON.parse(line.body)).toEqual(line.value);
      if (line.surface === 'MessagesSendResponse') {
        expect(Number.isSafeInteger(line.batchLength)).toBe(true);
        expect(line.batchLength).toBeGreaterThanOrEqual(0);
      } else expect(line.batchLength).toBeUndefined();
    }
  });

  it.each(v4HttpCorpus.map((line) => [line.index + 1, line.surface, line] as const))(
    'v4 HTTP line %i (%s) deep-equals its independent expected value and accounts for its batch',
    (_index, _surface, line) => assertCurrentHttp(line),
  );

  it('detects a changed literal body independently of the expected value', () => {
    const line = v4HttpCorpus.find((entry) => entry.surface === 'ChallengeResponse')!;
    expect(() => assertCurrentHttp({ ...line, body: JSON.stringify({ nonce: 'changed-nonce' }) })).toThrow('independently committed');
  });

  it('rejects unaccounted batch members', () => {
    const line = v4HttpCorpus.find((entry) => entry.surface === 'MessagesSendResponse' && entry.batchLength === 2)!;
    expect(() => assertCurrentHttp({ ...line, batchLength: 3 })).toThrow('entire submitted batch');
  });
});

// ---------------------------------------------------------------------------
// 4. Published rejection oracle: a published v3 decoder cannot read v4 bytes
// ---------------------------------------------------------------------------

describe('compat: published 0.30.2 (byok-protocol-previous) is the v4 rejection oracle', () => {
  it('the alias pins the last registered v3 release and never enters the v4 registry', () => {
    const version = packageVersion('byok-protocol-previous');
    expect(version).toBe('0.30.2');
    expect(v3Registry.releases.at(-1)?.version).toBe(version);
    expect(v4Registry.releases.some((entry) => entry.version === version)).toBe(false);
    expect(v3Release.PROTOCOL_VERSION).toBe(3);
  });

  it.each(v4Corpus.map((line) => [line.index + 1, line.type, line] as const))(
    'rejects v4 line %i (%s)',
    (_n, _type, line) => {
      if ((v3Release.MESSAGE_TYPES as readonly string[]).includes(line.type)) {
        expect(() => v3Release.decodeEnvelope(line.raw)).toThrow(v3Release.EnvelopeValidationError);
      } else {
        // A type added after 0.30.2 is unknown to it before its version is read.
        expect(() => v3Release.decodeEnvelope(line.raw)).toThrow(v3Release.UnknownMessageTypeError);
      }
    },
  );

  it('rejects a v4 conn.hello: a v3 server cannot admit a v4 daemon', () => {
    const hello = createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: [],
      deviceId: 'device-v4',
      productId: 'acme-agent',
    });
    expect(hello.v).toBe(4);
    expect(() => v3Release.decodeEnvelope(encodeEnvelope(hello))).toThrow(v3Release.EnvelopeValidationError);
  });

  it.each(v4HttpCorpus.filter(carriesEnvelopes).map((line) => [line.index + 1, line.surface, line] as const))(
    'rejects v4 HTTP line %i (%s), which carries v4 envelopes',
    (_n, surface, line) => {
      const decoded = httpSchema(v3Release, surface).safeParse(JSON.parse(line.body));
      if (!decoded.success) return;
      const entries = undecodedEntries(line, decoded.data as Record<string, unknown>);
      expect(entries, `${surface} decoded v4 envelopes in its body schema`).toBeDefined();
      for (const entry of entries!) expect(() => v3Release.parseMessage(entry)).toThrow();
    },
  );
});
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
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function jsonSchema(schema: unknown): Json {
  return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Json;
}

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
    // A field that accepts no value (`z.never()`, for example a sealed member
    // on a plaintext type) cannot appear in a valid line, so it needs no line.
    if (Object.keys(node).length === 1 && JSON.stringify(node.not) === '{}') return;
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
  // A field that accepts no value marks the other branch, for example `sealed` on a plaintext branch.
  if (Object.keys(node).length === 1 && JSON.stringify(node.not) === '{}') return false;
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
    below: 'http:MessagesSendRequest.messages[]',
    reason: 'The node is exactly EnvelopeSchema; the envelope corpus covers every payload path/value per message type and every header path/value.',
  },
];

const EXPECTED_EXEMPTION_PATHS: readonly string[] = [
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
    merge(seen, observedCoverage(root, prefix, v4Corpus.filter((line) => line.type === type).map((line) => line.payload)));
  }
  const header = envelopeHeaderRoot();
  merge(required, requiredCoverage(header, HEADER_PREFIX, () => false));
  merge(seen, observedCoverage(header, HEADER_PREFIX, v4Corpus.map((line) => {
    const { payload: _payload, ...fields } = JSON.parse(line.raw) as Record<string, unknown>;
    return fields;
  })));
  for (const surface of [...new Set(v4HttpCorpus.map((line) => line.surface))]) {
    const root = schemaNode(jsonSchema(httpSchema(currentModule, surface)))!;
    const prefix = `http:${surface}`;
    merge(required, requiredCoverage(root, prefix, exempt));
    merge(seen, observedCoverage(root, prefix, v4HttpCorpus.filter((line) => line.surface === surface).map((line) => JSON.parse(line.body) as unknown)));
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

  it('the events page is the only body carrying undecoded entries, and they are exactly unknown (#386)', () => {
    expect(ENTRY_DECODED_ENVELOPES, 'adding an undecoded envelope path needs a reviewed change here').toEqual({ EventsPollResponse: 'events' });
    const root = schemaNode(jsonSchema(httpSchema(currentModule, 'EventsPollResponse')))!;
    expect(nodeAtPath(root, '.events[]'), 'the page schema must not decode, narrow or default its entries').toEqual({});
    expect(root.required, 'events stays a required page field').toContain('events');
    expect(nodeAtPath(root, '.events'), 'events is a plain array: no default, bound or other constraint').toEqual({ type: 'array', items: {} });
  });
});
