import { describe, expect, it, vi } from 'vitest';
import * as cfworker from '@cfworker/json-schema';
import {
  RESULT_ISSUES_MAX_BYTES,
  RESULT_ISSUES_MAX_COUNT,
  RESULT_JSON_MAX_DEPTH,
  RESULT_OUTCOME_MAX_BYTES,
  RESULT_SCHEMA_KEYWORDS,
  RESULT_SCHEMA_MAX_BYTES,
  RESULT_SCHEMA_MAX_DEPTH,
  ResultDocumentSchemaSchema,
  TerminalProjectionSelectionSchema,
  checkResultSchema,
  validateResultOutcome,
  type ResultSchemaCheck,
  type ResultOutcomeCheck,
} from '../index';

vi.mock('@cfworker/json-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cfworker/json-schema')>();
  return { ...actual, Validator: vi.fn(function (this: unknown, ...args: ConstructorParameters<typeof actual.Validator>) { return new actual.Validator(...args); }) };
});

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

function root(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'object', ...extra };
}

/** A root object schema whose canonical JSON is exactly `bytes` bytes. */
function schemaOfExactBytes(bytes: number): Record<string, unknown> {
  const base = root({ description: '' });
  const padding = bytes - byteLength(base);
  return root({ description: 'x'.repeat(padding) });
}

function rejected<T extends ResultSchemaCheck | ResultOutcomeCheck>(check: T): Extract<T, { ok: false }> {
  expect(check.ok, JSON.stringify(check)).toBe(false);
  return check as Extract<T, { ok: false }>;
}

const outcomeSchema = root({ properties: { value: {} } });

function outcome(schemaUnderValue: Record<string, unknown>, value: unknown): ResultOutcomeCheck {
  return validateResultOutcome(root({ properties: { value: schemaUnderValue }, required: ['value'] }), { value });
}

describe('result schema subset: allowed keywords accept and validate', () => {
  it('names exactly the fifteen PRD §8.3 keywords', () => {
    expect([...RESULT_SCHEMA_KEYWORDS].sort()).toEqual([
      'additionalProperties', 'const', 'description', 'enum', 'items', 'maxItems', 'maxLength', 'maximum',
      'minItems', 'minLength', 'minimum', 'oneOf', 'properties', 'required', 'type',
    ]);
  });

  const cases: readonly (readonly [string, Record<string, unknown>, unknown, unknown])[] = [
    ['type', { type: 'integer' }, 3, 3.5],
    ['type (array form)', { type: ['string', 'null'] }, null, 1],
    ['properties', { type: 'object', properties: { a: { type: 'string' } } }, { a: 'x' }, { a: 1 }],
    ['required', { type: 'object', required: ['a'] }, { a: 1 }, {}],
    ['additionalProperties', { type: 'object', properties: { a: {} }, additionalProperties: false }, { a: 1 }, { a: 1, b: 2 }],
    ['items', { type: 'array', items: { type: 'number' } }, [1, 2], [1, 'x']],
    ['enum', { enum: ['a', { b: [1] }] }, { b: [1] }, { b: [2] }],
    ['const', { const: { k: [1, 'x'] } }, { k: [1, 'x'] }, { k: [1, 'y'] }],
    ['oneOf', { oneOf: [{ type: 'string' }, { type: 'number' }] }, 'x', true],
    ['oneOf (exactly one)', { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5, 1],
    ['minLength', { type: 'string', minLength: 2 }, 'ab', 'a'],
    ['minLength (code points)', { type: 'string', maxLength: 1 }, '😀', 'ab'],
    ['maxLength', { type: 'string', maxLength: 2 }, 'ab', 'abc'],
    ['minItems', { type: 'array', minItems: 1 }, [1], []],
    ['maxItems', { type: 'array', maxItems: 1 }, [1], [1, 2]],
    ['minimum', { type: 'number', minimum: 0 }, 0, -1],
    ['maximum', { type: 'number', maximum: 10 }, 10, 10.5],
    ['description', { type: 'string', description: 'free text' }, 'x', 1],
  ];

  it.each(cases)('%s: admitted, accepts a matching outcome and rejects a violating one', (_keyword, subschema, good, bad) => {
    expect(checkResultSchema(root({ properties: { value: subschema } })).ok).toBe(true);
    const accepted = outcome(subschema, good);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const refused = rejected(outcome(subschema, bad));
    expect(refused.reason).toBe('schema-mismatch');
    expect(refused.issues.length).toBeGreaterThan(0);
    for (const issue of refused.issues) expect(issue.pointer === '' || issue.pointer.startsWith('/')).toBe(true);
  });

  it('additionalProperties: false at the root is honoured', () => {
    const schema = root({ properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false });
    expect(validateResultOutcome(schema, { a: 'x' }).ok).toBe(true);
    const refused = rejected(validateResultOutcome(schema, { a: 'x', extra: 1 }));
    expect(refused.issues.map((issue) => issue.keyword)).toContain('additionalProperties');
  });

  it('root oneOf beside type: object is admitted (R2)', () => {
    const schema = root({ oneOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] });
    expect(checkResultSchema(schema).ok).toBe(true);
    expect(validateResultOutcome(schema, { a: 1 }).ok).toBe(true);
    expect(rejected(validateResultOutcome(schema, { a: 1, b: 2 })).reason).toBe('schema-mismatch');
  });

  it('presence is own-property only: inherited names never satisfy required or crash properties', () => {
    expect(rejected(validateResultOutcome(root({ required: ['constructor'] }), {})).reason).toBe('schema-mismatch');
    expect(validateResultOutcome(root({ properties: { toString: { type: 'string' } } }), {}).ok).toBe(true);
    expect(validateResultOutcome(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), JSON.parse('{"__proto__":"x"}')).ok).toBe(true);
    expect(rejected(validateResultOutcome(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), JSON.parse('{"__proto__":1}'))).reason).toBe('schema-mismatch');
  });

  it('reports the instance pointer in RFC 6901 form', () => {
    const schema = root({ properties: { 'a/b~c': { type: 'array', items: { type: 'string' } } } });
    const refused = rejected(validateResultOutcome(schema, { 'a/b~c': ['ok', 2] }));
    expect(refused.issues.map((issue) => issue.pointer)).toContain('/a~1b~0c/1');
  });

  it('returns the canonical snapshot and its byte count', () => {
    const value = { value: { nested: [1, 'é'] } };
    const accepted = validateResultOutcome(outcomeSchema, value);
    expect(accepted).toEqual({ ok: true, bytes: byteLength(value), canonical: value });
    if (accepted.ok) expect(accepted.canonical).not.toBe(value);
  });
});

describe('result schema subset: the guard refuses everything else before the library', () => {
  const forbidden: readonly (readonly [string, Record<string, unknown>])[] = [
    ['$ref', { $ref: '#/$defs/x' }],
    ['$defs', { $defs: { x: { type: 'string' } } }],
    ['$schema', { $schema: 'https://json-schema.org/draft/2020-12/schema' }],
    ['$id', { $id: 'https://example.com/s' }],
    ['$dynamicRef', { $dynamicRef: '#x' }],
    ['pattern', { pattern: '^a+$' }],
    ['format', { format: 'email' }],
    ['patternProperties', { patternProperties: { '^a': {} } }],
    ['allOf', { allOf: [{}] }],
    ['anyOf', { anyOf: [{}] }],
    ['not', { not: {} }],
    ['if', { if: {}, then: {} }],
    ['prefixItems', { prefixItems: [{}] }],
    ['contains', { contains: {} }],
    ['uniqueItems', { uniqueItems: true }],
    ['propertyNames', { propertyNames: {} }],
    ['dependentRequired', { dependentRequired: {} }],
    ['unevaluatedProperties', { unevaluatedProperties: false }],
    ['minProperties', { minProperties: 1 }],
    ['exclusiveMinimum', { exclusiveMinimum: 0 }],
    ['multipleOf', { multipleOf: 2 }],
    ['title', { title: 't' }],
    ['default', { default: 1 }],
    ['examples', { examples: [1] }],
  ];

  it.each(forbidden)('%s is refused at the root and in a nested subschema, before the validator is constructed', (keyword, fragment) => {
    const validator = vi.mocked(cfworker.Validator);
    validator.mockClear();
    for (const schema of [root(fragment), root({ properties: { a: { type: 'object', ...fragment } } })]) {
      const refused = rejected(checkResultSchema(schema));
      expect(refused.reason).toBe('not-subset');
      expect(refused.issues.map((issue) => issue.keyword)).toContain(keyword);
      const outcomeCheck = rejected(validateResultOutcome(schema, {}));
      expect(outcomeCheck.reason).toBe('schema-not-admitted');
    }
    expect(validator).not.toHaveBeenCalled();
  });

  it('names the JSON pointer of the refused keyword', () => {
    const refused = rejected(checkResultSchema(root({ properties: { 'a/b': { items: { pattern: 'x' } } } })));
    expect(refused.issues).toContainEqual(expect.objectContaining({ pointer: '/properties/a~1b/items/pattern', keyword: 'pattern' }));
  });

  it.each([
    ['true', true],
    ['an empty-object schema', {}],
    ['a schema object', { type: 'string' }],
  ] as const)('additionalProperties as %s is refused', (_label, value) => {
    const refused = rejected(checkResultSchema(root({ additionalProperties: value })));
    expect(refused.issues).toContainEqual(expect.objectContaining({ pointer: '/additionalProperties', keyword: 'additionalProperties' }));
    expect(rejected(checkResultSchema(root({ properties: { a: { type: 'object', additionalProperties: value } } }))).issues)
      .toContainEqual(expect.objectContaining({ pointer: '/properties/a/additionalProperties', keyword: 'additionalProperties' }));
  });

  it.each([
    ['no type', {}],
    ["type: 'array'", { type: 'array' }],
    ["type: ['object']", { type: ['object'] }],
    ['only oneOf', { oneOf: [{ type: 'object' }] }],
  ] as const)('a root with %s is refused (root must be type: object)', (_label, schema) => {
    const refused = rejected(checkResultSchema(schema));
    expect(refused.issues).toContainEqual(expect.objectContaining({ pointer: '/type', keyword: 'type' }));
  });

  it.each([
    ['an array', []],
    ['a string', 'object'],
    ['null', null],
    ['true', true],
  ] as const)('a root that is %s is refused', (_label, schema) => {
    expect(checkResultSchema(schema).ok).toBe(false);
  });

  it.each([
    ['type', { type: 'date' }],
    ['type', { type: [] }],
    ['type', { type: ['string', 'string'] }],
    ['properties', { properties: [] }],
    ['required', { required: 'a' }],
    ['required', { required: ['a', 'a'] }],
    ['items', { items: [{}] }],
    ['items', { items: true }],
    ['enum', { enum: [] }],
    ['oneOf', { oneOf: [] }],
    ['oneOf', { oneOf: {} }],
    ['minLength', { minLength: -1 }],
    ['maxLength', { maxLength: 1.5 }],
    ['minItems', { minItems: '1' }],
    ['maxItems', { maxItems: null }],
    ['minimum', { minimum: '0' }],
    ['maximum', { maximum: true }],
    ['description', { description: 1 }],
  ] as const)('a malformed %s value is refused', (keyword, fragment) => {
    const refused = rejected(checkResultSchema(root({ properties: { a: fragment } })));
    expect(refused.issues.map((issue) => issue.keyword)).toContain(keyword);
  });

  it('a boolean or non-object subschema is refused', () => {
    expect(rejected(checkResultSchema(root({ properties: { a: true } }))).issues)
      .toContainEqual(expect.objectContaining({ pointer: '/properties/a', keyword: 'schema' }));
    expect(rejected(checkResultSchema(root({ oneOf: [{}, false] }))).issues)
      .toContainEqual(expect.objectContaining({ pointer: '/oneOf/1', keyword: 'schema' }));
  });

  it('const and enum values are data, not schemas: keyword-like keys inside them are fine', () => {
    expect(checkResultSchema(root({ properties: { a: { const: { $ref: '#', pattern: 'x' } } } })).ok).toBe(true);
    expect(checkResultSchema(root({ properties: { a: { enum: [{ allOf: [] }] } } })).ok).toBe(true);
  });

  it('property names are names, not keywords', () => {
    expect(checkResultSchema(root({ properties: { $ref: { type: 'string' }, pattern: {}, allOf: {} } })).ok).toBe(true);
  });
});

describe('result schema subset: plain JSON and size', () => {
  it(`admits a schema of exactly ${RESULT_SCHEMA_MAX_BYTES} canonical bytes and refuses one byte more`, () => {
    expect(RESULT_SCHEMA_MAX_BYTES).toBe(16_384);
    const atCap = schemaOfExactBytes(RESULT_SCHEMA_MAX_BYTES);
    expect(byteLength(atCap)).toBe(16_384);
    expect(checkResultSchema(atCap)).toMatchObject({ ok: true, bytes: 16_384 });
    const overCap = schemaOfExactBytes(RESULT_SCHEMA_MAX_BYTES + 1);
    expect(byteLength(overCap)).toBe(16_385);
    expect(rejected(checkResultSchema(overCap))).toMatchObject({ reason: 'over-cap', bytes: 16_385 });
  });

  it('measures UTF-8 bytes, not characters', () => {
    const base = byteLength(root({ description: '' }));
    const chars = Math.floor((RESULT_SCHEMA_MAX_BYTES - base) / 2) + 1;
    const multibyte = root({ description: 'é'.repeat(chars) });
    expect(JSON.stringify(multibyte).length).toBeLessThan(RESULT_SCHEMA_MAX_BYTES);
    expect(rejected(checkResultSchema(multibyte)).reason).toBe('over-cap');
  });

  it.each([
    ['undefined', { type: 'object', description: undefined }],
    ['a Date', { type: 'object', properties: { a: { const: new Date(0) } } }],
    ['NaN', { type: 'object', properties: { a: { minimum: Number.NaN } } }],
    ['a Map', { type: 'object', properties: new Map([['a', {}]]) }],
    ['a lone surrogate', { type: 'object', properties: { '\uD800': {} } }],
  ] as const)('refuses a schema containing %s as not plain JSON', (_label, schema) => {
    expect(rejected(checkResultSchema(schema)).reason).toBe('not-plain-json');
  });

  it('refuses a non-serializable schema', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    expect(rejected(checkResultSchema(cyclic)).reason).toBe('not-serializable');
    expect(rejected(checkResultSchema(undefined)).reason).toBe('not-serializable');
    expect(rejected(checkResultSchema({ type: 'object', n: 1n })).reason).toBe('not-serializable');
  });

  it(`admits an outcome of exactly ${RESULT_OUTCOME_MAX_BYTES} canonical bytes and refuses one byte more, before validation`, () => {
    expect(RESULT_OUTCOME_MAX_BYTES).toBe(65_536);
    const framing = byteLength({ value: '' });
    const atCap = { value: 'x'.repeat(RESULT_OUTCOME_MAX_BYTES - framing) };
    expect(byteLength(atCap)).toBe(65_536);
    expect(validateResultOutcome(outcomeSchema, atCap)).toMatchObject({ ok: true, bytes: 65_536 });
    const overCap = { value: 'x'.repeat(RESULT_OUTCOME_MAX_BYTES - framing + 1) };
    const validator = vi.mocked(cfworker.Validator);
    validator.mockClear();
    expect(rejected(validateResultOutcome(outcomeSchema, overCap))).toMatchObject({ reason: 'over-cap', bytes: 65_537 });
    expect(validator).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined, 'not-serializable'],
    ['a function-valued key', { value: () => 1 }, 'not-plain-json'],
    ['a lone surrogate', { value: '\uDC00' }, 'not-plain-json'],
    ['a lone-surrogate key', { ['\uD800']: 1 }, 'not-plain-json'],
  ] as const)('refuses an outcome that is %s', (_label, value, reason) => {
    expect(rejected(validateResultOutcome(outcomeSchema, value)).reason).toBe(reason);
  });
});

describe('result schema subset: bounded depth and bounded issues', () => {
  function nested(levels: number): Record<string, unknown> {
    let node: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < levels; index += 1) node = { type: 'array', items: node };
    return root({ properties: { a: node } });
  }

  it(`admits ${RESULT_SCHEMA_MAX_DEPTH} levels of subschema nesting and refuses one more`, () => {
    expect(RESULT_SCHEMA_MAX_DEPTH).toBe(32);
    // properties/a is level 1; each items adds one.
    expect(checkResultSchema(nested(RESULT_SCHEMA_MAX_DEPTH - 1)).ok).toBe(true);
    const refused = rejected(checkResultSchema(nested(RESULT_SCHEMA_MAX_DEPTH)));
    expect(refused.reason).toBe('not-subset');
    expect(refused.issues.map((issue) => issue.keyword)).toEqual(['depth']);
  });

  it(`refuses JSON nesting deeper than ${RESULT_JSON_MAX_DEPTH} in a schema or an outcome without exhausting the stack`, () => {
    let deep: unknown = 1;
    for (let index = 0; index < RESULT_JSON_MAX_DEPTH; index += 1) deep = [deep];
    expect(checkResultSchema(root({ properties: { a: { const: deep } } }))).toMatchObject({ ok: false, reason: 'too-deep' });
    expect(validateResultOutcome(outcomeSchema, { value: deep })).toMatchObject({ ok: false, reason: 'too-deep' });
    // Far deeper than JSON.stringify itself supports: refused (the engine's
    // serializer gives up first, so the reason is not-serializable), never thrown.
    const veryDeep = JSON.parse(`${'['.repeat(30_000)}${']'.repeat(30_000)}`) as unknown;
    expect(validateResultOutcome(outcomeSchema, { value: veryDeep }).ok).toBe(false);
    expect(validateResultOutcome(outcomeSchema, { value: [[[1]]] }).ok).toBe(true);
  });

  it('validates a broad outcome through nested oneOf at the admitted depth limit', () => {
    // 15 oneOf/items pairs + properties + the leaf items = 32 subschema levels.
    // This exercises the interpreted validator, not just the admission guard.
    let node: Record<string, unknown> = { type: 'array', items: { type: 'integer' } };
    let valid: unknown = Array.from({ length: 4_096 }, (_, index) => index);
    let invalid: unknown = [...valid as number[], 'invalid'];
    for (let index = 0; index < 15; index += 1) {
      node = { oneOf: [{ type: 'array', items: node }, { type: 'null' }] };
      valid = [valid];
      invalid = [invalid];
    }
    const schema = root({ properties: { value: node }, required: ['value'] });
    expect(checkResultSchema(schema).ok).toBe(true);
    expect(byteLength({ value: valid })).toBeLessThan(RESULT_OUTCOME_MAX_BYTES);
    expect(validateResultOutcome(schema, { value: valid }).ok).toBe(true);
    expect(rejected(validateResultOutcome(schema, { value: invalid })).reason).toBe('schema-mismatch');
  });

  it(`caps the issue list at ${RESULT_ISSUES_MAX_COUNT} entries and marks the cut`, () => {
    const properties = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`p${index}`, { pattern: 'x' }]));
    const refused = rejected(checkResultSchema(root({ properties })));
    expect(refused.issues).toHaveLength(RESULT_ISSUES_MAX_COUNT);
    expect(refused.truncated).toBe(true);
  });

  it(`caps the issue list at ${RESULT_ISSUES_MAX_BYTES} bytes of JSON and cuts long strings`, () => {
    // Each name is 300 control characters: 6 escaped bytes each, so one
    // issue is about 800 bytes once its pointer is cut to 128 units.
    const properties = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`${'\u0001'.repeat(300)}${index}`, { pattern: 'x' }]));
    const refused = rejected(checkResultSchema(root({ properties })));
    expect(refused.issues.length).toBeGreaterThan(0);
    expect(byteLength(refused.issues)).toBeLessThanOrEqual(RESULT_ISSUES_MAX_BYTES);
    expect(refused.truncated).toBe(true);
    for (const issue of refused.issues) expect(issue.pointer.length).toBeLessThanOrEqual(128);
  });

  it('a single issue whose strings are fully escaped still fits, so a failure always reports one', () => {
    const name = '\u0001'.repeat(2000);
    const refused = rejected(checkResultSchema(root({ properties: { [name]: { pattern: 'x' } } })));
    expect(refused.issues).toHaveLength(1);
    expect(byteLength(refused.issues)).toBeLessThanOrEqual(RESULT_ISSUES_MAX_BYTES);
  });
});

describe('terminal projection: result-document carries a guarded schema', () => {
  const schema = root({ properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false });

  it('accepts { mode, contract, schema } and keeps the schema exactly as sent', () => {
    const parsed = TerminalProjectionSelectionSchema.parse({ mode: 'result-document', contract: 'example.answer.v1', schema });
    expect(parsed).toEqual({ mode: 'result-document', contract: 'example.answer.v1', schema });
  });

  it('refuses the schema-less v2 shape, an extra key, and a schema outside the subset', () => {
    expect(TerminalProjectionSelectionSchema.safeParse({ mode: 'result-document', contract: 'example.answer.v1' }).success).toBe(false);
    expect(TerminalProjectionSelectionSchema.safeParse({ mode: 'result-document', contract: 'example.answer.v1', schema, extra: 1 }).success).toBe(false);
    const result = TerminalProjectionSelectionSchema.safeParse({ mode: 'result-document', contract: 'example.answer.v1', schema: { ...schema, $ref: '#' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('schema');
      expect(result.error.issues.map((issue) => issue.message).join('\n')).toContain("at '/$ref' ($ref)");
    }
  });

  it('{ mode: none } is unchanged and takes no schema', () => {
    expect(TerminalProjectionSelectionSchema.parse({ mode: 'none' })).toEqual({ mode: 'none' });
    expect(TerminalProjectionSelectionSchema.safeParse({ mode: 'none', schema }).success).toBe(false);
  });

  it('the standalone schema decoder reports a capped issue list', () => {
    const properties = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`p${index}`, { format: 'x' }]));
    const result = ResultDocumentSchemaSchema.safeParse(root({ properties }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(RESULT_ISSUES_MAX_COUNT + 1);
  });
});
