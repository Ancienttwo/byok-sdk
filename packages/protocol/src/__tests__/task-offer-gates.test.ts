/**
 * The gates of the one `task.offer` (#925 stage 2): a daemon whose decoder
 * does not know a gated field or value stops on it instead of stripping it,
 * the v7 gates of every v6 offer the oracle release shipped equal the gates
 * it derived, and the table names each gate once.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v6Release from 'byok-protocol-previous';

import {
  AgentMemorySelectionSchema,
  ExecutionTargetSchema,
  readDeclineCode,
  HostOfferPlainPayloadSchema,
  HostOfferSealedPayloadSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  SEALED_PAYLOAD_CATEGORIES,
  SessionSelectionSchema,
  TaskOfferPlainPayloadSchema,
  TaskOfferSealedPayloadSchema,
  WIRE_ADDITIONS,
  requiredReceiverCapabilities,
  type WireAddition,
} from '../index';

type Json = { [key: string]: unknown };
type OfferRow = WireAddition & { readonly field: string };
type OfferLine = { id: string; type: string; payload: Json };

const corpusOfferLines = readFileSync(new URL('golden/v7.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as OfferLine)
  .filter((line) => line.type === 'task.offer');
const corpusOffers = corpusOfferLines.map((line) => line.payload);
/**
 * The v6 offer lines the oracle's release shipped: the corpus prefix its
 * `golden/v6.releases.json` entry pins. The v7 corpus keeps each one's
 * envelope id (generate-v7-corpus.mjs), so each pairs with its v7 form.
 */
const oracleVersion = (JSON.parse(readFileSync(createRequire(import.meta.url).resolve('byok-protocol-previous/package.json'), 'utf8')) as { version: string }).version;
const oracleLines = (JSON.parse(readFileSync(new URL('golden/v6.releases.json', import.meta.url), 'utf8')) as {
  releases: { version: string; envelopes: { lines: number } }[];
}).releases.find((entry) => entry.version === oracleVersion)!.envelopes.lines;
const v6OfferLines = readFileSync(new URL('golden/v6.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .slice(0, oracleLines)
  .map((raw) => JSON.parse(raw) as OfferLine)
  .filter((line) => line.type === 'task.offer');

const offerRows = WIRE_ADDITIONS.filter((entry): entry is OfferRow => entry.surface === 'task.offer' && entry.field !== undefined);

function fieldOf(payload: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((parent, segment) => (parent !== null && typeof parent === 'object' ? (parent as Json)[segment] : undefined), payload);
}

/**
 * The strict decoder of the payload's branch, as a daemon that does not know
 * the row would have it: without the row's field, or with the row's value
 * missing from that field.
 */
function decoderWithout(row: OfferRow, payload: Json): z.ZodType {
  const { shape } = payload.sealing === undefined ? TaskOfferPlainPayloadSchema : TaskOfferSealedPayloadSchema;
  const top = row.field.split('.')[0]!;
  const { [top]: known, ...rest } = shape as Record<string, z.ZodType>;
  if (row.value === undefined) return z.strictObject(rest);
  if (row.field === 'agentMemory') {
    return z.strictObject({ ...rest, agentMemory: AgentMemorySelectionSchema.exclude([row.value as never]).optional() });
  }
  if (row.field === 'session.mode' && row.value === 'fresh') return z.strictObject({ ...rest, session: SessionSelectionSchema.options[0] });
  if (row.field === 'target.lane') {
    const lanes = ExecutionTargetSchema.options.filter((option) => option.shape.lane.value !== row.value);
    return z.strictObject({ ...rest, target: z.union(lanes as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) });
  }
  if (row.field === 'sealing.categories') {
    const categories = z.array(z.enum(SEALED_PAYLOAD_CATEGORIES).exclude([row.value as never]));
    return z.strictObject({ ...rest, sealing: z.strictObject({ scopeId: z.string(), epoch: z.number(), categories }) });
  }
  throw new Error(`no decoder without ${row.field}=${row.value} (known: ${String(known !== undefined)})`);
}

describe('task.offer gates: an unknown gated field stops the daemon (Q4)', () => {
  it.each(offerRows.map((row) => [`${row.field}${row.value === undefined ? '' : `=${row.value}`}`, row] as const))(
    'a decoder that does not know %s refuses every corpus offer that carries it',
    (_name, row) => {
      const lines = corpusOffers.filter((payload) => {
        const value = fieldOf(payload, row.field);
        return value !== undefined && (row.value === undefined || (Array.isArray(value) ? value.includes(row.value) : value === row.value));
      });
      expect(lines.length, 'the v7 corpus carries the row').toBeGreaterThan(0);
      for (const payload of lines) {
        expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success).toBe(true);
        expect(decoderWithout(row, payload).safeParse(payload).success).toBe(false);
      }
    },
  );
});

describe('task.offer gates: the published v6 oracle, with dispatchSelection moved to the target lanes (Q2)', () => {
  it('needs exactly the flags the oracle release derived for the v6 form of every offer line it shipped', () => {
    expect(v6OfferLines.length).toBeGreaterThan(0);
    for (const v6Line of v6OfferLines) {
      const v7Line = corpusOfferLines.find((line) => line.id === v6Line.id)!;
      expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(v7Line.payload).success).toBe(true);
      const v6 = v6Release.requiredReceiverCapabilities('task.offer', v6Line.payload as never) as string[];
      expect(new Set(requiredReceiverCapabilities('task.offer', v7Line.payload)), v6Line.id).toEqual(new Set(v6));
    }
  });
});

describe('WIRE_ADDITIONS', () => {
  it('names each gate once', () => {
    const keys = WIRE_ADDITIONS.map((entry) => JSON.stringify([
      entry.surface, entry.field ?? null,
      entry.value ?? null,
      entry.capability,
    ]));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });
});


describe('Host offer selection admission (#1671)', () => {
  const plain = { agentRef: { agentId: 'agent', profileRevision: 'revision' }, target: { lane: 'runtime', runtimeId: 'codex' },
    instruction: 'resume', session: { mode: 'resume', sessionRef: 'session' } };
  const fresh = corpusOffers.find(p => p.agentMemoryCommit !== undefined && p.sealing === undefined)!;
  const piTarget = { lane: 'runtime', runtimeId: 'pi' };
  const native = { session: fresh.session, egressPolicy: fresh.egressPolicy, agentMemory: 'none', nativeSessions: { fromMs: 1, toMs: 2 }, target: piTarget };
  const nativeRule = 'native_sessions_selection_invalid';
  const rules = [
    ['agentMemory', { homeAccess: 'memory-reader', agentMemory: 'read-write' }, 'agentMemory read-write requires a writer; a memory-reader Attempt reads memory only', 'agent_memory_selection_invalid'],
    ['agentMemory', { homeAccess: 'memory-reader', agentMemory: 'read-write-if-admitted' }, 'agentMemory read-write-if-admitted requires a writer; a memory-reader Attempt reads memory only', 'agent_memory_selection_invalid'],
    ['agentMemoryCommit', { homeAccess: 'memory-reader', agentMemoryCommit: 'on-success' }, 'agentMemoryCommit needs a writer; a memory-reader Attempt reads the live files', 'agent_memory_selection_invalid'],
    ['target', { ...native, target: { lane: 'auto' } }, 'nativeSessions needs an explicit Pi target', nativeRule],
    ['session', { ...native, session: { mode: 'resume', sessionRef: 's' } }, 'nativeSessions needs a fresh session', nativeRule],
    ['agentMemory', { ...native, agentMemory: 'read' }, 'nativeSessions needs agentMemory none', nativeRule],
    ['agentMemory', { ...native, agentMemory: undefined }, 'nativeSessions needs agentMemory none', nativeRule],
    ['terminalProjection', { ...native, terminalProjection: corpusOffers.find(p => (p.terminalProjection as Json)?.mode === 'result-document')!.terminalProjection }, 'nativeSessions forbids terminal projection', nativeRule],
    ...(['agentMemoryCommit', 'homeAccess', 'requiredToolsets', 'messageEgress'] as const).map(field =>
      [field, { ...native, [field]: corpusOffers.find(p => p[field] !== undefined)![field] }, `nativeSessions forbids ${field}`, nativeRule] as const),
    // Every rule fails at once: only the first, in the docs/protocol.md §3.2 order, is reported.
    ['agentMemory', { ...native, homeAccess: 'memory-reader', agentMemory: 'read-write', target: { lane: 'auto' } }, 'agentMemory read-write requires a writer; a memory-reader Attempt reads memory only', 'agent_memory_selection_invalid'],
    ['agentMemoryCommit', { ...native, homeAccess: 'memory-reader', agentMemoryCommit: 'on-success', target: { lane: 'auto' } }, 'agentMemoryCommit needs a writer; a memory-reader Attempt reads the live files', 'agent_memory_selection_invalid'],
    ['target', { ...native, session: { mode: 'resume', sessionRef: 's' }, agentMemory: 'read', target: { lane: 'harness', harnessId: 'custom' } }, 'nativeSessions needs an explicit Pi target', nativeRule],
    ['session', { ...native, session: { mode: 'resume', sessionRef: 's' }, agentMemory: 'read' }, 'nativeSessions needs a fresh session', nativeRule],
  ] as const;
  it.each([
    ...([
      ['plain', HostOfferPlainPayloadSchema, TaskOfferPlainPayloadSchema, plain],
      ['sealed', HostOfferSealedPayloadSchema, TaskOfferSealedPayloadSchema, corpusOffers.find(p => p.sealing !== undefined)!],
    ] as const).flatMap(([name, host, wire, base]) => rules.map(([path, patch, message, rule]) =>
      [name, host, wire, { ...base, ...patch }, path, message, rule] as const)),
    ['prepared', HostOfferPlainPayloadSchema, TaskOfferPlainPayloadSchema,
      { ...corpusOffers.find(p => p.preparation !== undefined)!, homeAccess: 'memory-reader', agentMemory: 'read-write' },
      'agentMemory', rules[0][2], rules[0][3]],
  ] as const)('refuses invalid selection on %s without tightening the wire', (_name, host, wire, payload, path, message, rule) => {
    expect(wire.safeParse(payload).success).toBe(true);
    const parsed = host.safeParse(payload);
    expect(parsed.error).toBeInstanceOf(z.ZodError);
    expect(parsed.error!.issues).toEqual([{ code: 'custom', path: [path], message, params: { rule } }]);
    expect(readDeclineCode(rule)).toEqual({ code: rule });
  });
});

describe('native session offer admission (#1526)', () => {
  const ordinary = corpusOffers.find(p => p.agentMemoryCommit !== undefined && p.sealing === undefined)!;
  const { agentMemoryCommit: _commit, ...base } = ordinary;
  const native = { ...base, agentMemory: 'none', nativeSessions: { fromMs: 1, toMs: 2 }, target: { lane: 'runtime', runtimeId: 'pi' } };
  it.each([undefined, { mode: 'none' }])('admits a fresh memory-only offer with projection %j', terminalProjection => {
    expect(TaskOfferPlainPayloadSchema.parse({ ...native, terminalProjection }).nativeSessions).toEqual({ fromMs: 1, toMs: 2 });
    expect(requiredReceiverCapabilities('task.offer', native)).toContain('native-sessions');
    expect(HostOfferPlainPayloadSchema.parse({ ...native, nativeSessions: { fromMs: 1, toMs: 2, ifAdvertised: true } }).nativeSessions).toEqual({ fromMs: 1, toMs: 2, ifAdvertised: true });
  });
  // The other nativeSessions combinations are offer selection rules (#1671 table above); a prepared shape stays structural.
  it('refuses nativeSessions with preparation in the wire decoder', () => {
    const result = TaskOfferPlainPayloadSchema.safeParse({ ...native, preparation: corpusOffers.find(p => p.preparation !== undefined)!.preparation });
    expect(result.error!.issues.some(issue => issue.path[0] === 'instruction')).toBe(true);
  });
});
