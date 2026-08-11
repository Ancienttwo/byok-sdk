import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_FLAGS,
  MESSAGE_PAYLOAD_SCHEMAS,
  RESULT_DOCUMENT_MAX_BYTES,
  TaskCompletePayloadSchema,
  checkResultDocument,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
} from '../index';
import { BlobRefSchema } from '../blob';

/**
 * `task.complete.document` (additive-minor) — the bounded, schema-neutral
 * structured-result channel, its cap semantics, and the capability flag that
 * gates its emission. See `messages.ts`'s `RESULT_DOCUMENT_MAX_BYTES` /
 * `checkResultDocument` and `version.ts`'s `result-document` flag.
 */

/**
 * Builds a document whose canonical JSON encoding is EXACTLY `bytes` bytes.
 * `{"a":"…"}` is 8 ASCII bytes of framing plus one byte per padding
 * character, so the padding length is the target minus that framing.
 */
function documentOfExactJsonBytes(bytes: number): unknown {
  const framing = JSON.stringify({ a: '' }).length; // 8
  return { a: 'x'.repeat(bytes - framing) };
}

// ---------------------------------------------------------------------------
// Falsifier — the premise the capability gate rests on
// ---------------------------------------------------------------------------

/**
 * The whole reason `document` emission is gated on a capability flag (rather
 * than sent unconditionally the way `task.await_approval.approvalId` is) is
 * that a PRE-`document` server does not reject the field — it silently
 * strips it, so the task's primary structured result would vanish with no
 * error anywhere. That premise is a claim about zod's default (non-`.strict()`)
 * object behavior, so it is pinned here directly instead of assumed.
 *
 * `PreDocumentTaskCompletePayloadSchema` is a verbatim replica of
 * `TaskCompletePayloadSchema` as it stood immediately before this change —
 * an old server's parser, reconstructed. The same assertion was first run
 * against the REAL pre-change `TaskCompletePayloadSchema` (green: the field
 * was stripped) before the field was added, and against the post-change
 * schema (red: the field survives) — see
 * `tasks/notes/20260812-0351-result-document-channel.notes.md`. Keeping the
 * replica is what lets both halves of that story stay asserted forever in
 * one file.
 */
const PreDocumentTaskCompletePayloadSchema = z.object({
  summary: z.string(),
  sessionRef: z.string(),
  artifactRefs: z.array(BlobRefSchema).optional(),
});

describe('falsifier: the old-server strip premise behind the capability gate', () => {
  it('a pre-`document` server SILENTLY STRIPS the field — it does not reject it, and does not pass it through', () => {
    const parsed = PreDocumentTaskCompletePayloadSchema.parse({
      summary: 'done',
      sessionRef: 'sess-1',
      document: { kind: 'invoice', total: 42 },
    });

    expect('document' in parsed).toBe(false);
    expect(parsed).toEqual({ summary: 'done', sessionRef: 'sess-1' });
  });

  it('a `result-document`-capable server retains it — the exact behavior difference the flag advertises', () => {
    const parsed = TaskCompletePayloadSchema.parse({
      summary: 'done',
      sessionRef: 'sess-1',
      document: { kind: 'invoice', total: 42 },
    });

    expect(parsed.document).toEqual({ kind: 'invoice', total: 42 });
  });
});

// ---------------------------------------------------------------------------
// Cap boundary — the four cases
// ---------------------------------------------------------------------------

describe('task.complete.document: byte cap boundary', () => {
  it('RESULT_DOCUMENT_MAX_BYTES is 1 MiB', () => {
    expect(RESULT_DOCUMENT_MAX_BYTES).toBe(1_048_576);
  });

  it('accepts a document whose canonical JSON is EXACTLY at the cap', () => {
    const document = documentOfExactJsonBytes(RESULT_DOCUMENT_MAX_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(document)).length).toBe(RESULT_DOCUMENT_MAX_BYTES);

    const result = TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document });
    expect(result.success).toBe(true);
  });

  it('rejects a document ONE BYTE over the cap (reject at the boundary, never truncate)', () => {
    const document = documentOfExactJsonBytes(RESULT_DOCUMENT_MAX_BYTES + 1);
    expect(new TextEncoder().encode(JSON.stringify(document)).length).toBe(RESULT_DOCUMENT_MAX_BYTES + 1);

    const result = TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document });
    expect(result.success).toBe(false);
  });

  it('measures UTF-8 BYTES, not characters — a multi-byte document under the character count but over the byte cap is rejected', () => {
    // 'é' is 2 UTF-8 bytes, so half-the-cap characters is exactly at the cap
    // in bytes; one more character is 2 bytes over.
    const framing = JSON.stringify({ a: '' }).length;
    const atCap = { a: 'é'.repeat((RESULT_DOCUMENT_MAX_BYTES - framing) / 2) };
    const overCap = { a: 'é'.repeat((RESULT_DOCUMENT_MAX_BYTES - framing) / 2 + 1) };

    expect(checkResultDocument(atCap)).toEqual({ ok: true, bytes: RESULT_DOCUMENT_MAX_BYTES, canonical: atCap });
    expect(checkResultDocument(overCap)).toEqual({ ok: false, reason: 'over-cap', bytes: RESULT_DOCUMENT_MAX_BYTES + 2 });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: overCap }).success).toBe(false);
  });

  it('rejects a non-JSON-serializable document (circular reference, BigInt, function root)', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    for (const document of [circular, { big: 10n }, () => 'not data', { toJSON() { throw new Error('nope'); } }]) {
      expect(checkResultDocument(document)).toEqual({ ok: false, reason: 'not-serializable' });
      expect(
        TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document }).success,
        `must reject non-serializable document: ${String(document)}`,
      ).toBe(false);
    }
  });

  it('accepts a payload with NO document at all — the field is optional and its absence is the pre-existing shape', () => {
    const result = TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1' });
    expect(result.success).toBe(true);
    expect(result.success && 'document' in result.data).toBe(false);
  });

  it('accepts every JSON root shape, not just objects — the channel is schema-neutral', () => {
    for (const document of [[1, 2, 3], 'a string', 42, true, null, {}]) {
      expect(
        TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document }).success,
        `must accept JSON root: ${JSON.stringify(document)}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Plain-JSON-data contract (codex adversarial review, F1+F2)
// ---------------------------------------------------------------------------

/**
 * "JSON.stringify succeeded" is NOT the contract, and measuring the value at
 * the ROOT is not a bound on what the codec later writes nested inside the
 * envelope. Both holes close by the same mechanism: the value must equal its
 * own JSON round trip (so nothing was silently transformed), and the
 * CANONICAL SNAPSHOT — pure data, no `toJSON`, no getters — is what every
 * sender actually puts on the wire.
 */
describe('task.complete.document must be plain JSON data', () => {
  it('REJECTS a contextual toJSON(key) object — it answers small at the root and huge when nested, so a root-only measurement is no bound at all', () => {
    const huge = { a: 'x'.repeat(RESULT_DOCUMENT_MAX_BYTES * 2) };
    const smuggler = {
      toJSON(key: string): unknown {
        // '' is the root (where a naive check measures); 'document' is the
        // key this value actually sits under inside the payload.
        return key === '' ? { tiny: true } : huge;
      },
    };

    // The attack it would have enabled: measured tiny, written huge.
    expect(new TextEncoder().encode(JSON.stringify(smuggler)).length).toBeLessThan(100);
    expect(new TextEncoder().encode(JSON.stringify({ document: smuggler })).length).toBeGreaterThan(RESULT_DOCUMENT_MAX_BYTES);

    expect(checkResultDocument(smuggler)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: smuggler }).success).toBe(false);
  });

  it('REJECTS silently-lossy values that JSON.stringify accepts: an undefined-valued key, NaN, and undefined inside an array', () => {
    const lossy = { required: undefined, n: NaN, arr: [undefined] };

    // Proof of the loss this rejection prevents: stringify "succeeds", and
    // the result is a well-formed, under-cap document that is NOT what the
    // producer had — `required` gone, `NaN` and the array hole both `null`.
    expect(JSON.stringify(lossy)).toBe('{"n":null,"arr":[null]}');

    expect(checkResultDocument(lossy)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: lossy }).success).toBe(false);
  });

  it('REJECTS a Date instance — it serializes "successfully" into a string that is no longer the value the producer held', () => {
    const withDate = { at: new Date('2026-01-01T00:00:00.000Z') };

    expect(checkResultDocument(withDate)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(checkResultDocument(new Date('2026-01-01T00:00:00.000Z'))).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: withDate }).success).toBe(false);
  });

  it('REJECTS an unstable getter — a value that answers differently on a second read cannot be measured at all', () => {
    let reads = 0;
    const unstable = {
      get counter(): number {
        reads += 1;
        return reads;
      },
    };

    expect(checkResultDocument(unstable)).toEqual({ ok: false, reason: 'not-plain-json' });
  });

  it('NEUTRALIZES a stable getter: the accepted canonical snapshot is pure data, so what is sent is exactly what was measured', () => {
    const stable = {
      get answer(): number {
        return 42;
      },
    };

    const check = checkResultDocument(stable);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('unreachable');

    // The snapshot has no accessor left — it is a plain data object, and its
    // own re-measurement equals what was approved, which is what makes
    // "measure the original, send the snapshot" sound.
    expect(Object.getOwnPropertyDescriptor(check.canonical as object, 'answer')?.get).toBeUndefined();
    expect(check.canonical).toEqual({ answer: 42 });
    expect(new TextEncoder().encode(JSON.stringify(check.canonical)).length).toBe(check.bytes);
  });

  it('returns a canonical snapshot that serializes identically at the root and nested under `document` — the property that makes the cap a real bound', () => {
    const document = { kind: 'invoice', lines: [{ sku: 'a', qty: 2 }], note: null, ok: true, total: 42.5 };
    const check = checkResultDocument(document);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('unreachable');

    const rootJson = JSON.stringify(check.canonical);
    expect(new TextEncoder().encode(rootJson).length).toBe(check.bytes);
    expect(JSON.stringify({ document: check.canonical })).toBe(`{"document":${rootJson}}`);
  });

  it('is idempotent on pure data — the server re-running it on an already-parsed payload always agrees with the daemon', () => {
    const document = { kind: 'invoice', lines: [1, 2, 3], nested: { deep: { deeper: 'x' } } };
    const first = checkResultDocument(document);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    expect(checkResultDocument(first.canonical)).toEqual(first);
  });

  it('REJECTS a container whose data is invisible to JSON — a populated Map or Set serializes to {} and would otherwise pass as an empty document', () => {
    const map = new Map([['a', 1]]);
    const set = new Set([1]);

    // The silent loss this rejection prevents: both serialize to `{}`, which
    // structural key comparison alone would have called equal.
    expect(JSON.stringify(map)).toBe('{}');
    expect(JSON.stringify(set)).toBe('{}');

    expect(checkResultDocument(map)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(checkResultDocument(set)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: map }).success).toBe(false);
  });

  it('REJECTS a Map/Set nested inside otherwise-plain data — the rule applies at every object node, not just the root', () => {
    const nested = { kind: 'invoice', index: new Map([['a', 1]]) };
    const deeper = { a: { b: [{ c: new Set([1]) }] } };

    expect(checkResultDocument(nested)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(checkResultDocument(deeper)).toEqual({ ok: false, reason: 'not-plain-json' });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: nested }).success).toBe(false);
  });

  it('ACCEPTS a null-prototype object carrying data — a null prototype is plain data, just without Object.prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.kind = 'invoice';
    bare.total = 42;

    const check = checkResultDocument(bare);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('unreachable');
    expect(check.canonical).toEqual({ kind: 'invoice', total: 42 });
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document: bare }).success).toBe(true);
  });

  it('ACCEPTS a class instance whose data is in its OWN enumerable fields — that data really does survive the round trip', () => {
    class Invoice {
      constructor(
        readonly kind: string,
        readonly total: number,
      ) {}
    }

    const check = checkResultDocument(new Invoice('invoice', 42));
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('unreachable');
    expect(check.canonical).toEqual({ kind: 'invoice', total: 42 });
  });

  it('REJECTS a class instance whose values come from PROTOTYPE-level getters — invisible to JSON, so outside the plain-data contract (the documented boundary)', () => {
    class Computed {
      get kind(): string {
        return 'invoice';
      }
      get total(): number {
        return 42;
      }
    }
    const computed = new Computed();

    // Prototype accessors are not own enumerable properties, so JSON never
    // sees them: this instance encodes to `{}`.
    expect(JSON.stringify(computed)).toBe('{}');
    expect(checkResultDocument(computed)).toEqual({ ok: false, reason: 'not-plain-json' });
  });

  it('still accepts ordinary plain data, including every JSON root shape and deep nesting', () => {
    for (const document of [{ a: 1 }, [1, [2, [3]]], 'str', 0, false, null, {}, [], { nested: { arr: [{ x: null }] } }]) {
      const check = checkResultDocument(document);
      expect(check.ok, `must accept plain JSON data: ${JSON.stringify(document)}`).toBe(true);
      if (!check.ok) throw new Error('unreachable');
      expect(check.canonical).toEqual(document);
    }
  });
});

// ---------------------------------------------------------------------------
// checkResultDocument — the single shared authority
// ---------------------------------------------------------------------------

describe('checkResultDocument: one measurement authority for both sides', () => {
  it('reports the canonical JSON UTF-8 byte length on acceptance', () => {
    expect(checkResultDocument({ kind: 'invoice' })).toEqual({
      ok: true,
      bytes: new TextEncoder().encode(JSON.stringify({ kind: 'invoice' })).length,
      canonical: { kind: 'invoice' },
    });
  });

  it('reports the measured size alongside an over-cap rejection, so a caller can name it in a failure reason', () => {
    const document = documentOfExactJsonBytes(RESULT_DOCUMENT_MAX_BYTES + 100);
    expect(checkResultDocument(document)).toEqual({ ok: false, reason: 'over-cap', bytes: RESULT_DOCUMENT_MAX_BYTES + 100 });
  });

  it('agrees with the schema on every boundary case (the daemon-side gate can never disagree with the server-side validation)', () => {
    const cases: unknown[] = [
      undefined,
      { small: true },
      documentOfExactJsonBytes(RESULT_DOCUMENT_MAX_BYTES),
      documentOfExactJsonBytes(RESULT_DOCUMENT_MAX_BYTES + 1),
      () => 'not data',
    ];
    for (const document of cases) {
      const schemaAccepts = TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1', document }).success;
      const helperAccepts = document === undefined || checkResultDocument(document).ok;
      expect(schemaAccepts, `schema and helper must agree for: ${String(document)}`).toBe(helperAccepts);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire integration + capability flag
// ---------------------------------------------------------------------------

describe('task.complete.document on the wire', () => {
  it('survives a full encode/decode envelope round trip unchanged', () => {
    const document = { kind: 'invoice', lines: [{ sku: 'a', qty: 2 }], total: 42.5, note: null };
    const envelope = createEnvelope(
      'task.complete',
      { summary: 'done', sessionRef: 'sess-1', document },
      { taskId: 'task-1' },
    );

    const decoded = decodeEnvelope(encodeEnvelope(envelope));
    if (decoded.type !== 'task.complete') throw new Error('unreachable');
    expect(decoded.payload.document).toEqual(document);
  });

  it('is validated through MESSAGE_PAYLOAD_SCHEMAS too — one schema, not a second copy', () => {
    expect(MESSAGE_PAYLOAD_SCHEMAS['task.complete']).toBe(TaskCompletePayloadSchema);
  });
});

describe('result-document capability flag', () => {
  it('is present in CAPABILITY_FLAGS', () => {
    expect(CAPABILITY_FLAGS).toContain('result-document');
  });

  it('did not disturb any pre-existing flag (additive only)', () => {
    expect([...CAPABILITY_FLAGS]).toEqual([
      'steer',
      'blob-upload',
      'interactive-approval',
      'approval_resolved',
      'approval-targeting',
      'result-document',
    ]);
  });
});
