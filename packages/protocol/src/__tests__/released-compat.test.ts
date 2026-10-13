import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeEnvelope as decodeWithReleased,
  MESSAGE_PAYLOAD_SCHEMAS as RELEASED_PAYLOAD_SCHEMAS,
  UnknownMessageTypeError as ReleasedUnknownMessageTypeError,
} from '@byok-sdk/protocol-released';
import {
  AGENT_HOME_READERS_CAPABILITY,
  CAPABILITY_FLAGS,
  decodeEnvelope,
  MESSAGE_PAYLOAD_SCHEMAS,
  type CapabilityFlag,
} from '../index';

/**
 * Executable compatibility check against a RELEASED decoder.
 *
 * `freeze-guard` fingerprints the current schemas; it cannot tell whether a
 * new strict field breaks a client that is already in the field. This file
 * decodes the current envelope corpus with the oldest client release the
 * server must still support (the `@byok-sdk/protocol-released` devDependency
 * alias in package.json) and fails on any envelope that decoder rejects unless
 * a capability flag is named for it below. A structural case closes the blind
 * spot that a field no corpus line carries is invisible to that decoding: every
 * new top-level key of a strict payload must appear in the live corpus. This
 * file checks only the decoder half; that the server and hosted cloud refuse
 * an undeclared device is tested elsewhere (for example
 * packages/cloud/src/__tests__/agent-home-readers.test.ts). See "Freeze rule"
 * in docs/protocol.md and "Protocol compatibility baseline" in
 * docs/releases/README.md.
 */

const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));
const compatDir = `${goldenDir}compat/`;

/** Live corpora: the base file has one line per message type; the gated file holds the capability-gated samples. */
const CORPUS_FILES = ['v2.envelopes.ndjson', 'v2.gated.ndjson'] as const;

interface CorpusLine {
  readonly file: string;
  readonly index: number;
  readonly raw: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function readLines(path: string, file: string): CorpusLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((raw, index) => {
      const parsed = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
      return { file, index, raw, type: parsed.type, payload: parsed.payload };
    });
}

const liveLines = CORPUS_FILES.flatMap((file) => readLines(`${goldenDir}${file}`, file));

// ---------------------------------------------------------------------------
// Part 1 — the released decoder against the current corpus
// ---------------------------------------------------------------------------

/**
 * One entry per (message type, field) the released decoder rejects. `field` is
 * the strict payload key the released schema does not know; `null` means the
 * released decoder does not know the message type at all (an old daemon skips
 * it, so the type itself is the gate). `capability` is the flag a device must
 * durably declare before a server or the hosted cloud may send the message:
 * they refuse undeclared devices before creating the task or appending to the
 * mailbox. Removing an entry makes Part 1 fail; adding a top-level strict
 * payload key with no entry makes Part 1 fail too (the key must appear in the
 * live corpus, and the released decoder then rejects that line). A message
 * type the released decoder does not know is rejected with
 * UnknownMessageTypeError, so a new message type needs a `field: null` entry.
 */
interface GateEntry {
  readonly type: string;
  readonly field: string | null;
  readonly capability: CapabilityFlag;
}

const RELEASED_BASELINE_GATES: readonly GateEntry[] = [
  { type: 'task.offer_for_agent', field: 'homeAccess', capability: AGENT_HOME_READERS_CAPABILITY },
  { type: 'task.offer_for_agent_with_egress', field: 'homeAccess', capability: AGENT_HOME_READERS_CAPABILITY },
  { type: 'task.offer_for_agent_with_egress_fresh', field: 'homeAccess', capability: AGENT_HOME_READERS_CAPABILITY },
  { type: 'task.offer_prepared', field: 'homeAccess', capability: AGENT_HOME_READERS_CAPABILITY },
];

/**
 * Top-level keys of a payload schema's strict object shapes (a discriminated
 * union contributes the keys of every strict branch). A payload that is not
 * strict strips unknown keys, so the released decoder tolerates a new key and
 * it needs no gate. A schema of an unexpected kind fails loudly.
 */
function strictPayloadKeys(schema: unknown): Set<string> {
  const def = (schema as { _zod: { def: { type: string; catchall?: { _zod: { def: { type: string } } }; options?: unknown[] } } })._zod.def;
  if (def.type === 'union') {
    return new Set((def.options ?? []).flatMap((option) => [...strictPayloadKeys(option)]));
  }
  if (def.type !== 'object') throw new Error(`unsupported payload schema kind: ${def.type}`);
  if (def.catchall?._zod.def.type !== 'never') return new Set();
  return new Set(Object.keys((schema as { shape: Record<string, unknown> }).shape));
}

function releasedAccepts(raw: string): boolean {
  try {
    decodeWithReleased(raw);
    return true;
  } catch {
    return false;
  }
}

function releasedRejection(raw: string): unknown {
  try {
    decodeWithReleased(raw);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Finds the gate that explains why the released decoder rejects `line`, or undefined. */
function explainingGate(line: CorpusLine, gates: readonly GateEntry[]): GateEntry | undefined {
  const rejection = releasedRejection(line.raw);
  if (rejection === undefined) return undefined;
  if (rejection instanceof ReleasedUnknownMessageTypeError) {
    return gates.find((gate) => gate.type === line.type && gate.field === null);
  }
  const gate = gates.find((entry) => entry.type === line.type && entry.field !== null && entry.field in line.payload);
  if (gate === undefined) return undefined;
  // The gated field must be the whole reason: without it the released decoder accepts the line.
  const stripped = JSON.parse(line.raw) as { payload: Record<string, unknown> };
  delete stripped.payload[gate.field as string];
  return releasedAccepts(JSON.stringify(stripped)) ? gate : undefined;
}

describe('released-compat: the released decoder against the current corpus', () => {
  it.each(liveLines.map((line) => [`${line.file}:${line.index} (${line.type})`, line] as const))(
    '%s is accepted by the released decoder or gated by a capability flag',
    (_label, line) => {
      const rejection = releasedRejection(line.raw);
      if (rejection === undefined) return;
      const gate = explainingGate(line, RELEASED_BASELINE_GATES);
      expect(
        gate,
        `the released decoder rejects ${line.file}:${line.index} (${line.type}): ${String(rejection)}. ` +
          'Gate the new field or message type with a capability flag that the server and hosted cloud check before ' +
          'task creation or mailbox append, then list it in RELEASED_BASELINE_GATES (docs/protocol.md "Freeze rule"; ' +
          'a new message type needs a `field: null` entry because the released decoder rejects an unknown type); ' +
          'otherwise bump PROTOCOL_VERSION.',
      ).toBeDefined();
    },
  );

  it('every gate entry matches a rejected corpus line (no stale or unexercised gate)', () => {
    for (const gate of RELEASED_BASELINE_GATES) {
      const matched = liveLines.some((line) => explainingGate(line, [gate]) === gate);
      expect(matched, `gate ${gate.type}/${gate.field ?? '<type>'} has no corpus line the released decoder rejects`).toBe(true);
    }
  });

  it('every gate names a capability flag that exists', () => {
    for (const gate of RELEASED_BASELINE_GATES) {
      expect(CAPABILITY_FLAGS, `${gate.type}/${gate.field ?? '<type>'}`).toContain(gate.capability);
    }
  });

  it('the Agent offer carrying homeAccess is in the corpus, and the released decoder rejects it', () => {
    const sample = liveLines.find((line) => line.type === 'task.offer_for_agent' && 'homeAccess' in line.payload);
    expect(sample).toBeDefined();
    expect(releasedAccepts((sample as CorpusLine).raw)).toBe(false);
  });

  it('every top-level key a strict payload gained since the released baseline appears in the live corpus', () => {
    const missing: string[] = [];
    for (const [type, schema] of Object.entries(MESSAGE_PAYLOAD_SCHEMAS)) {
      const releasedSchema = (RELEASED_PAYLOAD_SCHEMAS as Record<string, unknown>)[type];
      // A type the released decoder does not know is gated as a whole by a `field: null` entry.
      if (releasedSchema === undefined) continue;
      const releasedKeys = strictPayloadKeys(releasedSchema);
      const corpusKeys = new Set(liveLines.filter((line) => line.type === type).flatMap((line) => Object.keys(line.payload)));
      for (const key of strictPayloadKeys(schema)) {
        if (releasedKeys.has(key) || corpusKeys.has(key)) continue;
        missing.push(`${type}.${key}`);
      }
    }
    expect(
      missing,
      'these strict payload keys are new since the released baseline and no live corpus line carries them, so ' +
        'the decoding cases above cannot see them. Add a corpus line with the key to golden/v2.gated.ndjson and gate ' +
        'it with a capability flag in RELEASED_BASELINE_GATES (docs/protocol.md "Freeze rule"). Only top-level ' +
        'keys of a strict payload are checked; nested strict schemas are not.',
    ).toEqual([]);
  });

  it('the current decoder accepts every gated sample', () => {
    for (const line of liveLines) {
      expect(() => decodeEnvelope(line.raw), `${line.file}:${line.index} (${line.type})`).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — released corpora are append-only and the current decoder reads them
// ---------------------------------------------------------------------------

/**
 * sha256 of every file in every released compat directory. A released
 * directory is never edited: changing a file, adding one to it or deleting one
 * fails here, and the only way to make it pass is a visible edit to this
 * table, which review rejects. A new release adds a new directory and a new
 * row (docs/releases/README.md).
 */
const COMPAT_PINS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '0.26.1': {
    'v2.envelopes.ndjson': '56f21c931838d41dd18a89ea360b4b48ff5712add5e43871f65b3b2fb0356e04',
    'v2.gated.ndjson': 'd92584e9519cc4a9a211a76db6ed4c59789dd30a8fa69cb1320ab2d4e35e4e2f',
  },
};

/**
 * Message types a protocol version bump explicitly retired. The current
 * decoder is not required to parse a retired type's lines in the compat
 * corpora. Empty today: nothing is retired.
 */
const RETIRED_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>();

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('released-compat: released corpora are append-only', () => {
  it('the compat directories are exactly the pinned releases', () => {
    const directories = readdirSync(compatDir, { withFileTypes: true });
    expect(directories.every((entry) => entry.isDirectory())).toBe(true);
    expect(directories.map((entry) => entry.name).sort()).toEqual(Object.keys(COMPAT_PINS).sort());
  });

  for (const [version, pins] of Object.entries(COMPAT_PINS)) {
    it(`golden/compat/${version}/ holds exactly the pinned files with the pinned contents`, () => {
      const directory = `${compatDir}${version}/`;
      const files = readdirSync(directory).sort();
      expect(files, `files in golden/compat/${version}/`).toEqual(Object.keys(pins).sort());
      for (const file of files) {
        expect(
          sha256(`${directory}${file}`),
          `golden/compat/${version}/${file} is a released artifact and is append-only; ` +
            'a new release gets a new directory instead of an edit',
        ).toBe(pins[file]);
      }
    });

    it(`the current decoder parses every non-retired line of golden/compat/${version}/`, () => {
      for (const file of Object.keys(pins)) {
        for (const line of readLines(`${compatDir}${version}/${file}`, file)) {
          if (RETIRED_MESSAGE_TYPES.has(line.type)) continue;
          expect(
            () => decodeEnvelope(line.raw),
            `golden/compat/${version}/${file}:${line.index} (${line.type}) no longer decodes; ` +
              'retire the type with a PROTOCOL_VERSION bump in RETIRED_MESSAGE_TYPES, or restore compatibility',
          ).not.toThrow();
        }
      }
    });
  }
});
