/**
 * The gates of the one `task.offer` (#925 stage 2): a daemon whose decoder
 * does not know a gated field or value stops on it instead of stripping it,
 * the v5 gates of every v4 offer equal the gates the last v4 release
 * derived for it, and the table names each gate once.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v4Release from 'byok-protocol-previous';

import {
  AgentMemorySelectionSchema,
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

const v5Offers = readFileSync(new URL('golden/v5.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: string; payload: Json })
  .filter((line) => line.type === 'task.offer')
  .map((line) => line.payload);
const v4Offers = readFileSync(new URL('golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
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
      const lines = v5Offers.filter((payload) => {
        const value = fieldOf(payload, row.field);
        return value !== undefined && (row.value === undefined || (Array.isArray(value) ? value.includes(row.value) : value === row.value));
      });
      expect(lines.length, 'the v5 corpus carries the row').toBeGreaterThan(0);
      for (const payload of lines) {
        expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success).toBe(true);
        expect(decoderWithout(row, payload).safeParse(payload).success).toBe(false);
      }
    },
  );
});

describe('task.offer gates: equal to the last v4 release (Q2)', () => {
  it('needs exactly the flags the last v4 release derived for every v4 offer line', () => {
    expect(v4Offers.length).toBeGreaterThan(0);
    for (const payload of v4Offers) {
      expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success).toBe(true);
      const v4 = v4Release.requiredReceiverCapabilities('task.offer', payload as never) as string[];
      expect(new Set(requiredReceiverCapabilities('task.offer', payload))).toEqual(new Set(v4));
    }
  });
});

describe('WIRE_ADDITIONS', () => {
  it('names each gate once', () => {
    const keys = WIRE_ADDITIONS.map((entry) => JSON.stringify([
      entry.kind, entry.rule, entry.surface, entry.field ?? null,
      entry.rule === 'gated' && entry.kind === 'envelope' ? entry.value ?? null : null,
      entry.rule === 'gated' && entry.kind === 'envelope' ? entry.capability : null,
    ]));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });
});
