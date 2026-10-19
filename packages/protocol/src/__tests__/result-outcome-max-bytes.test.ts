import { describe, expect, it } from 'vitest';
import { checkResultSchema, resultOutcomeMaxBytes, validateResultOutcome, type ResultSchema } from '../result-schema';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const object = (value: ResultSchema): ResultSchema => ({ type: 'object', additionalProperties: false, properties: { n: value } });

describe('canonical outcome byte bounds', () => {
  it('covers the 25-byte number and 24-byte integer representations', () => {
    expect(bytes(-0.0000012345678901234567)).toBe(25);
    expect(bytes(-1.7976931348623157e308)).toBe(24);
    expect(resultOutcomeMaxBytes({ type: 'number' })).toBe(25);
    expect(resultOutcomeMaxBytes({ type: 'integer' })).toBe(24);
    expect(resultOutcomeMaxBytes(object({ type: 'number', minimum: -1, maximum: 1 }))).toBe(31);
    expect(resultOutcomeMaxBytes(object({ type: 'integer', minimum: 0, maximum: 1e21 }))).toBe(30);
    const value = { n: 999999999999999900000 };
    expect(validateResultOutcome(object({ type: 'integer', minimum: 0, maximum: 1e21 }), value).ok).toBe(true);
    expect(bytes(value)).toBeLessThanOrEqual(30);
  });
  it.each([[0, 100, 3], [-100, 100, 4], [0, 999999999999999900000, 21], [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 17]])
    ('tightens integer range %s to %s', (minimum, maximum, expected) => {
      expect(resultOutcomeMaxBytes({ type: 'integer', minimum, maximum })).toBe(expected);
    });
  it('counts escapes, empty containers, keys, and separators', () => {
    expect(resultOutcomeMaxBytes({ type: 'string', maxLength: 4 })).toBe(bytes('\u0001'.repeat(4)));
    expect(resultOutcomeMaxBytes({ type: 'array', maxItems: 0, items: {} })).toBe(2);
    expect(resultOutcomeMaxBytes({ type: 'array', maxItems: 0 })).toBe(2);
    expect(resultOutcomeMaxBytes({ type: 'object', additionalProperties: false })).toBe(2);
    expect(resultOutcomeMaxBytes({ type: 'array', maxItems: 3, items: { const: 'x' } })).toBe(bytes(['x', 'x', 'x']));
    expect(resultOutcomeMaxBytes({ type: 'object', additionalProperties: false, properties: { '\u0001': { const: true } } })).toBe(bytes({ '\u0001': true }));
  });
  it('uses the minimum reliable bound at intersections and the maximum at unions', () => {
    expect(resultOutcomeMaxBytes({ type: 'string', maxLength: 10, enum: ['a', 'bc'] })).toBe(4);
    expect(resultOutcomeMaxBytes({ oneOf: [{ const: 'a' }, { const: 'bc' }] })).toBe(4);
    expect(resultOutcomeMaxBytes({ type: ['string', 'null'], maxLength: 10 })).toBe(62);
    expect(resultOutcomeMaxBytes({ type: ['string', 'null'] })).toBeNull();
    expect(resultOutcomeMaxBytes({ oneOf: [{ type: 'string' }, { const: 1 }] })).toBeNull();
    expect(resultOutcomeMaxBytes({ type: 'object', const: { a: 1 } })).toBe(7);
  });
  it('does not call user serialization hooks or recurse through cycles', () => {
    let calls = 0;
    const schema = { const: { toJSON: () => { calls++; return 'x'; } } };
    expect(resultOutcomeMaxBytes(schema)).toBeNull();
    expect(calls).toBe(0);
    const value = { message: 'hi' };
    Object.defineProperty(value, 'toJSON', { value() { calls++; return { message: 'hi' }; } });
    expect(resultOutcomeMaxBytes({ const: value })).toBeNull();
    expect(calls).toBe(0);
    const accessor = {};
    Object.defineProperty(accessor, 'toJSON', { get() { calls++; return undefined; } });
    expect(resultOutcomeMaxBytes({ const: accessor })).toBeNull();
    expect(calls).toBe(0);
    const cycle: { type: 'object'; properties?: Record<string, ResultSchema> } = { type: 'object' };
    cycle.properties = { self: cycle };
    expect(resultOutcomeMaxBytes(cycle)).toBeNull();
  });
  it('accepts the full K7 subschema depth without adding a wrapper level', () => {
    let schema: ResultSchema = { const: 0 };
    for (let depth = 0; depth < 32; depth++) schema = { type: 'object', additionalProperties: false, properties: { x: schema } };
    expect(checkResultSchema(schema).ok).toBe(true);
    expect(resultOutcomeMaxBytes(schema)).toBe(32 * 6 + 1);
  });
  it('covers outcome over-cap regressions instead of underestimating arrays of numbers', () => {
    for (const [items, maxItems, value] of [
      [{ type: 'number', minimum: -1, maximum: 1 }, 2620, -0.0000012345678901234567],
      [{ type: 'integer', minimum: 0, maximum: 1e21 }, 3000, 999999999999999900000],
    ] as const) {
      const schema = object({ type: 'array', maxItems, items });
      const outcome = { n: Array(maxItems).fill(value) };
      expect(bytes(outcome)).toBeGreaterThan(65536);
      expect(resultOutcomeMaxBytes(schema)).toBeGreaterThanOrEqual(bytes(outcome));
      expect(validateResultOutcome(schema, outcome)).toMatchObject({ ok: false, reason: 'over-cap' });
    }
  });
});
