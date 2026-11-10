/**
 * The gates of the one `task.offer` (#925 stage 2): a daemon whose decoder
 * does not know a gated field or value stops on it instead of stripping it,
 * the v6 gates of every v5 offer the oracle release shipped equal the gates
 * it derived, and the table names each gate once.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v5Release from 'byok-protocol-previous';

import {
  AgentMemorySelectionSchema,
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
type OfferRow = Extract<WireAddition, { rule: 'gated' }> & { readonly field: string };

const v6Offers = readFileSync(new URL('golden/v6.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: string; payload: Json })
  .filter((line) => line.type === 'task.offer')
  .map((line) => line.payload);
/**
 * The v5 offer lines the oracle's release shipped: the corpus prefix its
 * `golden/v5.releases.json` entry pins. Later v5 lines may carry gates that
 * release does not know.
 */
const oracleVersion = (JSON.parse(readFileSync(createRequire(import.meta.url).resolve('byok-protocol-previous/package.json'), 'utf8')) as { version: string }).version;
const oracleLines = (JSON.parse(readFileSync(new URL('golden/v5.releases.json', import.meta.url), 'utf8')) as {
  releases: { version: string; envelopes: { lines: number } }[];
}).releases.find((entry) => entry.version === oracleVersion)!.envelopes.lines;
const v5Offers = readFileSync(new URL('golden/v5.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .slice(0, oracleLines)
  .map((raw) => JSON.parse(raw) as { type: string; payload: Json })
  .filter((line) => line.type === 'task.offer')
  .map((line) => line.payload);

const offerRows = WIRE_ADDITIONS.filter((entry): entry is OfferRow =>
  entry.kind === 'envelope' && entry.rule === 'gated' && entry.surface === 'task.offer' && entry.field !== undefined);

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
      const lines = v6Offers.filter((payload) => {
        const value = fieldOf(payload, row.field);
        return value !== undefined && (row.value === undefined || (Array.isArray(value) ? value.includes(row.value) : value === row.value));
      });
      expect(lines.length, 'the v6 corpus carries the row').toBeGreaterThan(0);
      for (const payload of lines) {
        expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success).toBe(true);
        expect(decoderWithout(row, payload).safeParse(payload).success).toBe(false);
      }
    },
  );
});

describe('task.offer gates: the published v5 oracle less the two offer gates v6 retired (Q2)', () => {
  it('needs exactly the flags the oracle release derived for every v5 offer line it shipped, without the retired ones', () => {
    const retired = ['custom-harness', 'terminal-projection-selection'];
    expect(v5Offers.length).toBeGreaterThan(0);
    for (const payload of v5Offers) {
      expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success).toBe(true);
      const v5 = v5Release.requiredReceiverCapabilities('task.offer', payload as never) as string[];
      expect(new Set(requiredReceiverCapabilities('task.offer', payload))).toEqual(new Set(v5.filter((flag) => !retired.includes(flag))));
    }
  });
});

describe('WIRE_ADDITIONS', () => {
  it('names each gate once', () => {
    const keys = WIRE_ADDITIONS.map((entry) => JSON.stringify([
      entry.kind, entry.rule, entry.surface, entry.field ?? null,
      entry.value ?? null,
      entry.capability,
    ]));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });
});


describe('Host offer selection admission (#1671)', () => {
  const plain = { agentRef: { agentId: 'agent', profileRevision: 'revision' }, runtime: 'codex',
    instruction: 'resume', session: { mode: 'resume', sessionRef: 'session' } };
  const selection = { lane: 'subscription', runtimeId: 'claude', providerId: null, modelId: 'model' };
  const rules = [
    ['agentMemory', { homeAccess: 'memory-reader', agentMemory: 'read-write' }, 'agentMemory read-write requires a writer; a memory-reader Attempt reads memory only', 'agent_memory_selection_invalid'],
    ['agentMemory', { homeAccess: 'memory-reader', agentMemory: 'read-write-if-admitted' }, 'agentMemory read-write-if-admitted requires a writer; a memory-reader Attempt reads memory only', 'agent_memory_selection_invalid'],
    ['runtime', { dispatchSelection: selection }, 'runtime codex does not match dispatchSelection.runtimeId claude', 'runtime_selection_mismatch'],
    ['harnessId', { harnessId: 'custom' }, 'harnessId conflicts with built-in runtime selection', 'harness_selection_conflict'],
    ['harnessId', { runtime: undefined, harnessId: 'custom', dispatchSelection: selection }, 'harnessId conflicts with built-in runtime selection', 'harness_selection_conflict'],
    // Every rule fails at once: only the first, in reader -> runtime -> harness order, is reported.
    ['agentMemory', { homeAccess: 'memory-reader', agentMemory: 'read-write', dispatchSelection: selection, harnessId: 'custom' }, 'agentMemory read-write requires a writer; a memory-reader Attempt reads memory only', 'agent_memory_selection_invalid'],
    ['runtime', { dispatchSelection: selection, harnessId: 'custom' }, 'runtime codex does not match dispatchSelection.runtimeId claude', 'runtime_selection_mismatch'],
  ] as const;
  it.each([
    ...([
      ['plain', HostOfferPlainPayloadSchema, TaskOfferPlainPayloadSchema, plain],
      ['sealed', HostOfferSealedPayloadSchema, TaskOfferSealedPayloadSchema, v6Offers.find(p => p.sealing !== undefined)!],
    ] as const).flatMap(([name, host, wire, base]) => rules.map(([path, patch, message, rule]) =>
      [name, host, wire, { ...base, runtime: 'codex', ...patch }, path, message, rule] as const)),
    ['prepared', HostOfferPlainPayloadSchema, TaskOfferPlainPayloadSchema,
      { ...v6Offers.find(p => p.preparation !== undefined)!, homeAccess: 'memory-reader', agentMemory: 'read-write' },
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
  const ordinary = v6Offers.find(p => p.agentMemoryCommit !== undefined && p.sealing === undefined)!;
  const { agentMemoryCommit: _commit, ...base } = ordinary;
  const native = { ...base, agentMemory: 'none', nativeSessions: { fromMs: 1, toMs: 2 } };
  it.each([undefined, { mode: 'none' }])('admits a fresh memory-only offer with projection %j', terminalProjection => {
    expect(TaskOfferPlainPayloadSchema.parse({ ...native, terminalProjection }).nativeSessions).toEqual({ fromMs: 1, toMs: 2 });
    expect(requiredReceiverCapabilities('task.offer', native)).toContain('native-sessions');
    expect(HostOfferPlainPayloadSchema.parse({ ...native, nativeSessions: { fromMs: 1, toMs: 2, ifAdvertised: true } }).nativeSessions).toEqual({ fromMs: 1, toMs: 2, ifAdvertised: true });
  });
  it.each([
    ['session', { mode: 'resume', sessionRef: 's' }], ['agentMemory', 'read'], ['agentMemory', undefined],
    ['terminalProjection', v6Offers.find(p => (p.terminalProjection as Json)?.mode === 'result-document')!.terminalProjection],
    ...['agentMemoryCommit', 'homeAccess', 'preparation', 'requiredToolsets', 'messageEgress', 'harnessId'].map(field =>
      [field, v6Offers.find(p => p[field] !== undefined)![field]]),
  ])('refuses nativeSessions with %s=%j', (field, value) => {
    const result = TaskOfferPlainPayloadSchema.safeParse({ ...native, [field as string]: value });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some(issue => issue.path[0] === field)).toBe(true);
  });
});
