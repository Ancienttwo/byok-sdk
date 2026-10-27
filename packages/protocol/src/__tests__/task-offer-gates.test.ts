/**
 * The gates of the one `task.offer` (#925 stage 2): a daemon whose decoder
 * does not know a gated field or value stops on it instead of stripping it,
 * the v4 gates of every v3 Agent offer equal the gates the last v3 release
 * derived for it, and the table names each gate once.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v3Release from 'byok-protocol-previous';

import {
  AgentMemorySelectionSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  SessionSelectionSchema,
  TaskOfferPlainPayloadSchema,
  TaskOfferSealedPayloadSchema,
  WIRE_ADDITIONS,
  requiredReceiverCapabilities,
  type WireAddition,
} from '../index';

type Json = { [key: string]: unknown };
type OfferRow = Extract<WireAddition, { rule: 'gated' }> & { readonly field: string };

const v4Offers = readFileSync(new URL('golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: string; payload: Json })
  .filter((line) => line.type === 'task.offer')
  .map((line) => line.payload);
const v3Lines = readFileSync(new URL('golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: string; payload: Json });

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
  throw new Error(`no decoder without ${row.field}=${row.value} (known: ${String(known !== undefined)})`);
}

describe('task.offer gates: an unknown gated field stops the daemon (Q4)', () => {
  it.each(offerRows.map((row) => [`${row.field}${row.value === undefined ? '' : `=${row.value}`}`, row] as const))(
    'a decoder that does not know %s refuses every corpus offer that carries it',
    (_name, row) => {
      const lines = v4Offers.filter((payload) => {
        const value = fieldOf(payload, row.field);
        return value !== undefined && (row.value === undefined || value === row.value);
      });
      expect(lines.length, 'the v4 corpus carries the row').toBeGreaterThan(0);
      for (const payload of lines) {
        expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success).toBe(true);
        expect(decoderWithout(row, payload).safeParse(payload).success).toBe(false);
      }
    },
  );
});

describe('task.offer gates: equal to the last v3 release (Q2)', () => {
  const V3_AGENT_OFFERS = [
    'task.offer_for_agent', 'task.offer_for_agent_with_egress', 'task.offer_for_agent_with_egress_fresh', 'task.offer_prepared',
    'task.offer_for_agent_sealed', 'task.offer_for_agent_with_egress_sealed', 'task.offer_for_agent_with_egress_fresh_sealed',
  ];

  /**
   * The flags v4 adds over 0.30.2 on purpose. One offer type has one
   * `agentMemory` row, so a prepared offer's selection takes it too (a daemon
   * advertises it with `agent-home-contract`). Stage 1 gates `harnessId` on
   * every Agent offer (#1019).
   */
  /** The `session` each v3 offer type meant: a v3 resume offer named it in `sessionRef`. */
  const V3_SESSION: Readonly<Record<string, 'resume' | 'fresh'>> = {
    'task.offer_for_agent': 'resume', 'task.offer_for_agent_with_egress': 'resume',
    'task.offer_for_agent_sealed': 'resume', 'task.offer_for_agent_with_egress_sealed': 'resume',
    'task.offer_for_agent_with_egress_fresh': 'fresh', 'task.offer_for_agent_with_egress_fresh_sealed': 'fresh',
    'task.offer_prepared': 'fresh',
  };

  /** The v4 `task.offer` payload a v3 corpus offer line stands for. */
  function asV4Offer(v3Type: string, payload: Json): Json {
    const { sessionRef, ...rest } = payload;
    return V3_SESSION[v3Type] === 'fresh' ? { ...rest, session: { mode: 'fresh' } } : { ...rest, session: { mode: 'resume', sessionRef } };
  }

  function knownAdditions(v3Type: string, payload: Json): string[] {
    return [
      ...(v3Type === 'task.offer_prepared' ? ['agent-memory-selection'] : []),
      ...(payload.harnessId !== undefined ? ['custom-harness'] : []),
    ];
  }

  it('needs exactly the v3 flags of every v3 Agent offer line, plus the known additions', () => {
    const lines = v3Lines.filter((line) => V3_AGENT_OFFERS.includes(line.type));
    expect(new Set(lines.map((line) => line.type))).toEqual(new Set(V3_AGENT_OFFERS));
    for (const line of lines) {
      const payload = asV4Offer(line.type, line.payload);
      expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse(payload).success, line.type).toBe(true);
      const v3 = v3Release.requiredReceiverCapabilities(line.type as never, line.payload) as string[];
      const v4 = requiredReceiverCapabilities('task.offer', payload);
      expect(new Set(v4), line.type).toEqual(new Set([...v3, ...knownAdditions(line.type, line.payload)]));
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
