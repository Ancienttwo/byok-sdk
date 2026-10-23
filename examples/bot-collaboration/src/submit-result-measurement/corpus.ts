// The frozen `submit-result-v1` corpus of docs/submit-result-measurement.md.
// The case values below are the doc's JavaScript without change. Do not edit
// them: a changed byte is a different corpus and needs its own revision.
import { createHash } from 'node:crypto';
import { checkResultSchema, validateResultOutcome } from '@byok-sdk/protocol';
import { resultDigest } from './digest';

export const CORPUS_REVISION = 'submit-result-v1';

type JsonSchema = Record<string, unknown>;
const object = (properties: Record<string, unknown>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const cases = [
  { id: 'C01-small', schema: object({ text: { type: 'string', maxLength: 64 } }),
    target: { text: 'measurement-ok' } },
  { id: 'C02-scalars', schema: object({
      action: { type: 'string', enum: ['ask_user', 'none'] },
      count: { type: 'integer', minimum: 0, maximum: 5 },
      confirmed: { type: 'boolean' },
    }), target: { action: 'ask_user', count: 3, confirmed: false } },
  { id: 'C03-array', schema: object({ items: { type: 'array', minItems: 3, maxItems: 3,
      items: object({ id: { type: 'integer' }, text: { type: 'string', maxLength: 32 } }),
    } }), target: { items: [1, 2, 3].map(id => ({ id, text: `item-${id}` })) } },
  { id: 'C04-union', schema: { type: 'object', oneOf: [
      object({ kind: { const: 'question' }, question: { type: 'string', maxLength: 64 } }),
      object({ kind: { const: 'done' }, summary: { type: 'string', maxLength: 64 } }),
    ] }, target: { kind: 'question', question: 'Continue?' } },
  { id: 'C05-unicode', schema: object({ text: { type: 'string', maxLength: 1024 } }),
    target: { text: '记忆🙂\n"quoted"\\'.repeat(32) } },
  { id: 'C06-large', schema: object({ text: { type: 'string', maxLength: 64000 } }),
    target: { text: 'x'.repeat(64000) } },
];
const instruction = (target: unknown) =>
  'Call submit_result exactly once with the following JSON value. ' +
  'Do not perform external actions. Do not replace the tool call with final prose.\n' +
  JSON.stringify(target);

export interface CorpusCase {
  readonly id: string;
  readonly schema: JsonSchema;
  readonly target: unknown;
  readonly instruction: string;
  /** Hex SHA-256 of the exact UTF-8 bytes of `JSON.stringify(schema)`, `JSON.stringify(target)` and the instruction. */
  readonly hashes: { readonly schema: string; readonly target: string; readonly instruction: string };
  readonly bytes: { readonly target: number; readonly instruction: number };
  /** The SDK content digest of the target (`sha256:<hex>` of key-sorted JSON). */
  readonly targetDigest: string;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

export const CORPUS: readonly CorpusCase[] = Object.freeze(cases.map((entry) => {
  const text = instruction(entry.target);
  return Object.freeze({
    id: entry.id, schema: entry.schema, target: entry.target, instruction: text,
    hashes: { schema: sha256(JSON.stringify(entry.schema)), target: sha256(JSON.stringify(entry.target)), instruction: sha256(text) },
    bytes: { target: utf8(JSON.stringify(entry.target)), instruction: utf8(text) },
    targetDigest: resultDigest(entry.target),
  });
}));

export function corpusCase(id: string): CorpusCase {
  const found = CORPUS.find(entry => entry.id === id);
  if (!found) throw new Error(`unknown corpus case ${id}`);
  return found;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly failures: readonly { readonly caseId: string; readonly step: 'checkResultSchema' | 'validateResultOutcome'; readonly reason: string }[];
}

/**
 * Corpus preflight with the pinned protocol package. A failure voids the run
 * before any trial: the corpus or the pinned package is wrong.
 */
export function preflightCorpus(corpus: readonly CorpusCase[] = CORPUS): PreflightResult {
  const failures: { caseId: string; step: 'checkResultSchema' | 'validateResultOutcome'; reason: string }[] = [];
  for (const entry of corpus) {
    const schema = checkResultSchema(entry.schema);
    if (!schema.ok) { failures.push({ caseId: entry.id, step: 'checkResultSchema', reason: schema.reason }); continue; }
    const outcome = validateResultOutcome(entry.schema, entry.target);
    if (!outcome.ok) failures.push({ caseId: entry.id, step: 'validateResultOutcome', reason: outcome.reason });
  }
  return { ok: failures.length === 0, failures };
}
