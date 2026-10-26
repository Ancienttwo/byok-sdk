import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as v3Release from 'byok-protocol-previous';
import { decodeEnvelope, encodeEnvelope, migrateWireV3Envelope, WIRE_V3_TO_V4_TYPES } from '../index';

const v3Lines = readFileSync(new URL('./golden/v3.envelopes.ndjson', import.meta.url), 'utf8').trimEnd().split('\n');
const v4Lines = readFileSync(new URL('./golden/v4.envelopes.ndjson', import.meta.url), 'utf8').trimEnd().split('\n');
const REMOVED = ['conn.ack', 'task.offer', 'task.offer_with_toolsets', 'task.offer_sealed', 'task.offer_with_toolsets_sealed'];
const APPROVALS = ['task.approve', 'task.reject', 'task.await_approval'];

describe('wire v3 -> v4 stored envelope migration (#925)', () => {
  it('maps exactly the message types of the last v3 release', () => {
    expect(v3Release.PROTOCOL_VERSION).toBe(3);
    expect(Object.keys(WIRE_V3_TO_V4_TYPES)).toEqual([...v3Release.MESSAGE_TYPES]);
    expect(Object.entries(WIRE_V3_TO_V4_TYPES).filter(([, v4]) => v4 === null).map(([v3]) => v3)).toEqual(REMOVED);
  });

  it.each(v3Lines.map((line, index) => [index + 1, line] as const))('migrates v3 line %i or refuses it by rule', (_n, line) => {
    const v3 = v3Release.decodeEnvelope(line);
    const result = migrateWireV3Envelope(line);
    if (REMOVED.includes(v3.type)) {
      expect(result).toEqual({ ok: false, type: v3.type, refusal: 'type_without_v4_form' });
      return;
    }
    if (APPROVALS.includes(v3.type) && (v3.payload as { approvalId?: string }).approvalId === undefined) {
      expect(result).toEqual({ ok: false, type: v3.type, refusal: 'invalid_under_v4' });
      return;
    }
    if (!result.ok) throw new Error(`v3 line refused: ${result.refusal}`);
    const v4 = decodeEnvelope(result.body);
    expect(v4.v).toBe(4);
    expect(encodeEnvelope(v4)).toBe(result.body);
    expect({ ...v4, v: 3 }).toEqual(v3);
  });

  it('refuses a body that is not a wire v3 envelope and changes nothing', () => {
    expect(migrateWireV3Envelope(v4Lines[0]!)).toMatchObject({ ok: false, refusal: 'not_wire_v3' });
    expect(migrateWireV3Envelope('not json')).toEqual({ ok: false, refusal: 'not_wire_v3' });
    expect(migrateWireV3Envelope('[]')).toEqual({ ok: false, refusal: 'not_wire_v3' });
    expect(migrateWireV3Envelope(JSON.stringify({ v: 3, type: 'task.unknown', payload: {} }))).toEqual({
      ok: false, type: 'task.unknown', refusal: 'type_without_v4_form',
    });
  });
});
