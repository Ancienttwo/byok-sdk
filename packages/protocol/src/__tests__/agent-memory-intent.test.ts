import { describe, expect, it } from 'vitest';
import {
  AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES,
  AGENT_MEMORY_INTENT_CAPABILITY,
  AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES,
  AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS_BY_RESERVATION,
  AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES,
  AGENT_MEMORY_INTENT_PATH_MAX_BYTES,
  AGENT_MEMORY_INTENT_REJECTION_CODES,
  AgentMemoryIntentAvailablePayloadSchema,
  AgentMemoryIntentCompletionSchema,
  AgentMemoryIntentFetchRequestSchema,
  AgentMemoryIntentFetchResponseSchema,
  AgentMemoryIntentReadbackSchema,
  AgentMemoryIntentV1Schema,
  CAPABILITY_FLAGS,
  EnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  SERVER_TO_DAEMON_TYPES,
  agentMemoryIntentFetchResponseSchemaFor,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  type AgentMemoryIntentCompletion,
  type AgentMemoryIntentReadback,
  type AgentMemoryIntentV1,
} from '../index';

const INTENT_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_INTENT_ID = '20000000-0000-4000-8000-000000000002';
const AGENT_REF = { agentId: 'agent-1', profileRevision: '7' };
const EMPTY_REVISION = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HELLO_REVISION = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'e'.repeat(64)}`;

function replaceIntent(overrides: Record<string, unknown> = {}): AgentMemoryIntentV1 {
  return {
    intentId: INTENT_ID,
    agentRef: AGENT_REF,
    path: 'notes/host-agent.md',
    operation: 'replace',
    baseRevision: EMPTY_REVISION,
    targetRevision: HELLO_REVISION,
    approvalRef: 'approval:proposal-1',
    operationDigest: DIGEST,
    ...overrides,
  } as AgentMemoryIntentV1;
}

function deleteIntent(overrides: Record<string, unknown> = {}): AgentMemoryIntentV1 {
  return replaceIntent({ operation: 'delete', baseRevision: HELLO_REVISION, targetRevision: null, ...overrides });
}

function completionIdentity(intent: AgentMemoryIntentV1 = replaceIntent()) {
  return {
    intentId: intent.intentId,
    agentRef: intent.agentRef,
    path: intent.path,
    operation: intent.operation,
    operationDigest: intent.operationDigest,
  };
}

function completion(outcome: AgentMemoryIntentCompletion['outcome'], intent?: AgentMemoryIntentV1): AgentMemoryIntentCompletion {
  const identity = completionIdentity(intent);
  switch (outcome) {
    case 'applied':
      return { ...identity, outcome, result: { exists: true, revision: HELLO_REVISION } };
    case 'conflict':
      return { ...identity, outcome, observed: { exists: true, revision: OTHER_DIGEST } };
    case 'rejected':
      return { ...identity, outcome, code: 'path_invalid' };
    case 'uncertain':
      return { ...identity, outcome, observed: { exists: false, revision: EMPTY_REVISION } };
  }
}

function readback(overrides: Partial<AgentMemoryIntentReadback> = {}): AgentMemoryIntentReadback {
  return {
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    intentId: INTENT_ID,
    disposition: 'recorded',
    completion: completion('applied'),
    recordedAt: '2026-09-28T05:00:00.000Z',
    ...overrides,
  };
}

function hostTerminalReadback(code: string = 'intent_expired', intent: AgentMemoryIntentV1 = replaceIntent()): AgentMemoryIntentReadback {
  return readback({
    disposition: 'host_terminal',
    completion: { ...completionIdentity(intent), outcome: 'rejected', code } as AgentMemoryIntentCompletion,
  });
}

const release = (intent: AgentMemoryIntentV1 = replaceIntent({ content: 'hello' })) => ({ disposition: 'release', intent });
const withheld = (code: string = 'intent_revoked') => ({ disposition: 'withheld', intent: replaceIntent(), code });
const terminal = (rb: AgentMemoryIntentReadback = hostTerminalReadback()) => ({ disposition: 'terminal', intent: replaceIntent(), readback: rb });
const deferred = () => ({ disposition: 'deferred', intent: replaceIntent() });

// ---------------------------------------------------------------------------
// Capability + notice
// ---------------------------------------------------------------------------

describe('agent-memory-intent.v1 capability', () => {
  it('is a declared capability flag', () => {
    expect(AGENT_MEMORY_INTENT_CAPABILITY).toBe('agent-memory-intent.v1');
    expect(CAPABILITY_FLAGS).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });
});

describe('agent.memory.intent.available notice', () => {
  const envelopeBase = {
    v: 1,
    id: '20000000-0000-4000-8000-000000000099',
    ts: '2026-09-28T05:00:00.000Z',
    type: 'agent.memory.intent.available',
    seq: 1,
    payload: { intentId: INTENT_ID, agentRef: AGENT_REF },
  };

  it('is a registered server-to-daemon type carrying exactly { intentId, agentRef }', () => {
    expect(SERVER_TO_DAEMON_TYPES).toContain('agent.memory.intent.available');
    expect(MESSAGE_PAYLOAD_SCHEMAS['agent.memory.intent.available']).toBe(AgentMemoryIntentAvailablePayloadSchema);
    const envelope = createEnvelope('agent.memory.intent.available', { intentId: INTENT_ID, agentRef: AGENT_REF }, { seq: 4 });
    const decoded = decodeEnvelope(encodeEnvelope(envelope));
    expect(decoded).toEqual(envelope);
    if (decoded.type !== 'agent.memory.intent.available') throw new Error('unreachable');
    expect(Object.keys(decoded.payload).sort()).toEqual(['agentRef', 'intentId']);
  });

  it('requires seq and forbids task_id', () => {
    expect(EnvelopeSchema.safeParse(envelopeBase).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...envelopeBase, task_id: 'task-1' }).success).toBe(false);
    const { seq: _seq, ...withoutSeq } = envelopeBase;
    expect(EnvelopeSchema.safeParse(withoutSeq).success).toBe(false);
  });

  it('requires a UUID intentId and a canonical projection agentRef', () => {
    const parse = (payload: unknown) => AgentMemoryIntentAvailablePayloadSchema.safeParse(payload).success;
    expect(parse({ intentId: INTENT_ID, agentRef: AGENT_REF })).toBe(true);
    expect(parse({ agentRef: AGENT_REF })).toBe(false);
    expect(parse({ intentId: INTENT_ID })).toBe(false);
    expect(parse({ intentId: 'not-a-uuid', agentRef: AGENT_REF })).toBe(false);
    expect(parse({ intentId: INTENT_ID, agentRef: { agentId: 'agent-1', profileRevision: 'r7' } })).toBe(false);
    expect(parse({ intentId: INTENT_ID, agentRef: { ...AGENT_REF, extra: 1 } })).toBe(false);
  });

  it.each([
    ['path', 'notes/a.md'],
    ['operation', 'replace'],
    ['content', 'hello'],
    ['baseRevision', EMPTY_REVISION],
    ['operationDigest', DIGEST],
    ['tenantId', 'tenant-1'],
  ])('rejects (never strips) an extra %s field', (field, value) => {
    const payload = { intentId: INTENT_ID, agentRef: AGENT_REF, [field]: value };
    expect(AgentMemoryIntentAvailablePayloadSchema.safeParse(payload).success).toBe(false);
    expect(() => decodeEnvelope(JSON.stringify({ ...envelopeBase, payload }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

describe('AgentMemoryIntentV1', () => {
  const parse = (value: unknown) => AgentMemoryIntentV1Schema.safeParse(value).success;

  it('accepts a replace identity with and without its released content, and a delete identity', () => {
    expect(parse(replaceIntent())).toBe(true);
    expect(parse(replaceIntent({ content: 'hello' }))).toBe(true);
    expect(parse(replaceIntent({ content: '' }))).toBe(true);
    expect(parse(deleteIntent())).toBe(true);
    expect(parse(replaceIntent({ path: 'MEMORY.md' }))).toBe(true);
  });

  it('rejects unknown keys and every missing required field', () => {
    expect(parse({ ...replaceIntent(), tenantId: 'tenant-1' })).toBe(false);
    expect(parse({ ...replaceIntent(), releaseNotAfter: '2026-09-28T05:00:00.000Z' })).toBe(false);
    expect(parse({ ...replaceIntent(), releaseDigest: DIGEST })).toBe(false);
    for (const field of ['intentId', 'agentRef', 'path', 'operation', 'baseRevision', 'targetRevision', 'approvalRef', 'operationDigest']) {
      const value: Record<string, unknown> = { ...replaceIntent() };
      delete value[field];
      expect(parse(value), field).toBe(false);
    }
  });

  it('rejects an unknown operation', () => {
    expect(parse(replaceIntent({ operation: 'append' }))).toBe(false);
  });

  it('requires lowercase sha256 revisions and digest', () => {
    for (const field of ['baseRevision', 'targetRevision', 'operationDigest']) {
      expect(parse(replaceIntent({ [field]: `sha256:${'A'.repeat(64)}` })), field).toBe(false);
      expect(parse(replaceIntent({ [field]: `sha256:${'a'.repeat(63)}` })), field).toBe(false);
      expect(parse(replaceIntent({ [field]: 'a'.repeat(64) })), field).toBe(false);
    }
  });

  it('requires targetRevision to differ from baseRevision', () => {
    expect(parse(replaceIntent({ targetRevision: EMPTY_REVISION }))).toBe(false);
  });

  it('requires a replace targetRevision and a null delete targetRevision', () => {
    expect(parse(replaceIntent({ targetRevision: null }))).toBe(false);
    expect(parse(deleteIntent({ targetRevision: OTHER_DIGEST }))).toBe(false);
  });

  it('never lets a delete carry content', () => {
    expect(parse(deleteIntent({ content: '' }))).toBe(false);
    expect(parse(deleteIntent({ content: 'hello' }))).toBe(false);
  });

  it('caps content at 256 KiB of UTF-8 bytes, counting bytes rather than characters', () => {
    expect(AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES).toBe(262_144);
    expect(parse(replaceIntent({ content: 'a'.repeat(AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES) }))).toBe(true);
    expect(parse(replaceIntent({ content: 'a'.repeat(AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES + 1) }))).toBe(false);
    // U+00E9 is 2 UTF-8 bytes: 131072 characters are exactly the cap, one more exceeds it.
    expect(parse(replaceIntent({ content: 'é'.repeat(AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES / 2) }))).toBe(true);
    expect(parse(replaceIntent({ content: 'é'.repeat(AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES / 2 + 1) }))).toBe(false);
  });

  it('rejects content that is not encodable as UTF-8 (lone surrogates)', () => {
    expect(parse(replaceIntent({ content: 'ok 😀' }))).toBe(true);
    expect(parse(replaceIntent({ content: 'bad \ud83d' }))).toBe(false);
    expect(parse(replaceIntent({ content: 'bad \ude00' }))).toBe(false);
  });

  it('bounds approvalRef to 128 bytes of [A-Za-z0-9._:-]', () => {
    expect(AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES).toBe(128);
    expect(parse(replaceIntent({ approvalRef: 'A'.repeat(128) }))).toBe(true);
    expect(parse(replaceIntent({ approvalRef: 'a.b_c:d-9' }))).toBe(true);
    expect(parse(replaceIntent({ approvalRef: 'A'.repeat(129) }))).toBe(false);
    expect(parse(replaceIntent({ approvalRef: '' }))).toBe(false);
    for (const bad of ['a b', 'a/b', 'a"b', 'a\\b', 'café', 'a\nb', 'a+b']) {
      expect(parse(replaceIntent({ approvalRef: bad })), bad).toBe(false);
    }
  });

  it('applies only the syntactic path bound; the exact memory path rule stays with the device', () => {
    expect(AGENT_MEMORY_INTENT_PATH_MAX_BYTES).toBe(1024);
    expect(parse(replaceIntent({ path: `notes/${'a'.repeat(1015)}.md` }))).toBe(true);
    expect(parse(replaceIntent({ path: `notes/${'a'.repeat(1016)}.md` }))).toBe(false);
    for (const bad of ['', 'notes/a"b.md', 'notes\\a.md', 'notes/é.md', 'notes/a\n.md', 'notes/a\u0000.md', 'notes/a\u007f.md']) {
      expect(parse(replaceIntent({ path: bad })), JSON.stringify(bad)).toBe(false);
    }
    // Device-side checks (reported as path_invalid / memory_md_not_deletable) are not re-derived here.
    expect(parse(replaceIntent({ path: '../escape.md' }))).toBe(true);
    expect(parse(deleteIntent({ path: 'MEMORY.md' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

describe('fetch request', () => {
  const parse = (value: unknown) => AgentMemoryIntentFetchRequestSchema.safeParse(value).success;

  it('is exactly { intentId, reservation: held | none }', () => {
    expect(parse({ intentId: INTENT_ID, reservation: 'held' })).toBe(true);
    expect(parse({ intentId: INTENT_ID, reservation: 'none' })).toBe(true);
    expect(parse({ intentId: INTENT_ID, reservation: 'maybe' })).toBe(false);
    expect(parse({ intentId: INTENT_ID })).toBe(false);
    expect(parse({ reservation: 'held' })).toBe(false);
    expect(parse({ intentId: 'x', reservation: 'held' })).toBe(false);
    expect(parse({ intentId: INTENT_ID, reservation: 'held', agentRef: AGENT_REF })).toBe(false);
    expect(parse({ intentId: INTENT_ID, reservation: 'held', assertion: 'a.b.c' })).toBe(false);
  });
});

describe('fetch response dispositions', () => {
  const parse = (value: unknown) => AgentMemoryIntentFetchResponseSchema.safeParse(value).success;

  it('accepts all four dispositions', () => {
    expect(parse(release())).toBe(true);
    expect(parse(release(deleteIntent()))).toBe(true);
    expect(parse(withheld())).toBe(true);
    expect(parse(terminal())).toBe(true);
    expect(parse(deferred())).toBe(true);
  });

  it('rejects an unknown disposition and unknown keys on every variant', () => {
    expect(parse({ disposition: 'pending', intent: replaceIntent() })).toBe(false);
    expect(parse({ ...release(), extra: 1 })).toBe(false);
    expect(parse({ ...withheld(), extra: 1 })).toBe(false);
    expect(parse({ ...terminal(), extra: 1 })).toBe(false);
    expect(parse({ ...deferred(), extra: 1 })).toBe(false);
    expect(parse({ ...release(), releaseNotAfter: '2026-09-28T05:00:00.000Z' })).toBe(false);
  });

  it('release: a replace must carry content; a delete never does', () => {
    expect(parse(release(replaceIntent()))).toBe(false);
    expect(parse(release(deleteIntent({ content: 'x' })))).toBe(false);
  });

  it('withheld: carries no content and only one of the four Host codes', () => {
    expect(AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES).toEqual([
      'intent_revoked',
      'intent_expired',
      'placement_changed',
      'profile_revision_changed',
    ]);
    for (const code of AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES) expect(parse(withheld(code)), code).toBe(true);
    expect(parse(withheld('path_invalid'))).toBe(false);
    expect(parse({ disposition: 'withheld', intent: replaceIntent() })).toBe(false);
    expect(parse({ ...withheld(), intent: replaceIntent({ content: 'hello' }) })).toBe(false);
  });

  it('terminal: carries no content and a readback bound to the intent identity and digest', () => {
    expect(parse({ ...terminal(), intent: replaceIntent({ content: 'hello' }) })).toBe(false);
    expect(parse({ disposition: 'terminal', intent: replaceIntent() })).toBe(false);
    expect(parse(terminal(readback({ disposition: 'recorded', completion: completion('uncertain') })))).toBe(true);
    // readback for another intent
    const other = replaceIntent({ intentId: OTHER_INTENT_ID });
    expect(parse(terminal(readback({ intentId: OTHER_INTENT_ID, completion: completion('applied', other) })))).toBe(false);
    // completion identity or digest differs from the intent
    for (const change of [
      { operationDigest: OTHER_DIGEST },
      { path: 'notes/other.md' },
      { operation: 'delete' },
      { agentRef: { agentId: 'agent-2', profileRevision: '7' } },
      { agentRef: { agentId: 'agent-1', profileRevision: '8' } },
    ]) {
      const drifted = readback({ completion: { ...completion('applied'), ...change } as AgentMemoryIntentCompletion });
      expect(parse(terminal(drifted)), JSON.stringify(change)).toBe(false);
    }
  });

  it('deferred: identity and digest only, never content', () => {
    expect(parse({ ...deferred(), intent: replaceIntent({ content: 'hello' }) })).toBe(false);
    expect(parse({ ...deferred(), intent: replaceIntent({ content: '' }) })).toBe(false);
    expect(parse({ disposition: 'deferred', intent: { intentId: INTENT_ID } })).toBe(false);
  });
});

describe('fetch response reservation constraint', () => {
  it('declares held -> release | withheld | terminal and none -> terminal | deferred', () => {
    expect(AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS_BY_RESERVATION).toEqual({
      held: ['release', 'withheld', 'terminal'],
      none: ['terminal', 'deferred'],
    });
  });

  const cases = [
    ['release', release()],
    ['withheld', withheld()],
    ['terminal', terminal()],
    ['deferred', deferred()],
  ] as const;

  it.each(cases)('held reservation and a %s answer', (disposition, response) => {
    const ok = agentMemoryIntentFetchResponseSchemaFor('held').safeParse(response).success;
    expect(ok).toBe(disposition !== 'deferred');
  });

  it.each(cases)('none reservation and a %s answer', (disposition, response) => {
    const ok = agentMemoryIntentFetchResponseSchemaFor('none').safeParse(response).success;
    expect(ok).toBe(disposition === 'terminal' || disposition === 'deferred');
  });

  it('refuses an unknown reservation', () => {
    expect(() => agentMemoryIntentFetchResponseSchemaFor('maybe' as 'held')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Completion + readback
// ---------------------------------------------------------------------------

describe('completion', () => {
  const parse = (value: unknown) => AgentMemoryIntentCompletionSchema.safeParse(value).success;

  it.each(['applied', 'conflict', 'rejected', 'uncertain'] as const)('accepts a %s completion', (outcome) => {
    expect(AgentMemoryIntentCompletionSchema.parse(completion(outcome))).toEqual(completion(outcome));
  });

  it('accepts a delete completion (the identity carries operation, never targetRevision or content)', () => {
    expect(parse(completion('applied', deleteIntent()))).toBe(true);
    expect(parse({ ...completion('applied', deleteIntent()), content: '' })).toBe(false);
  });

  it('has no non-terminal outcome', () => {
    for (const outcome of ['pending', 'busy', 'deferred', 'applying', 'withheld']) {
      expect(parse({ ...completionIdentity(), outcome }), outcome).toBe(false);
    }
  });

  it('pairs each outcome with exactly its own detail field', () => {
    expect(parse({ ...completionIdentity(), outcome: 'applied', observed: { exists: true, revision: HELLO_REVISION } })).toBe(false);
    expect(parse({ ...completionIdentity(), outcome: 'conflict', result: { exists: true, revision: HELLO_REVISION } })).toBe(false);
    expect(parse({ ...completionIdentity(), outcome: 'uncertain', code: 'path_invalid' })).toBe(false);
    expect(parse({ ...completion('rejected'), observed: { exists: true, revision: HELLO_REVISION } })).toBe(false);
    expect(parse({ ...completion('applied'), result: { exists: true } })).toBe(false);
    expect(parse({ ...completion('applied'), result: { exists: true, revision: HELLO_REVISION, at: 'x' } })).toBe(false);
  });

  it('rejects unknown keys and missing identity fields', () => {
    expect(parse({ ...completion('applied'), tenantId: 'tenant-1' })).toBe(false);
    expect(parse({ ...completion('applied'), releaseDigest: DIGEST })).toBe(false);
    for (const field of ['intentId', 'agentRef', 'path', 'operation', 'operationDigest']) {
      const value: Record<string, unknown> = { ...completion('applied') };
      delete value[field];
      expect(parse(value), field).toBe(false);
    }
  });

  it('draws rejected codes from the closed set, without R16=B codes', () => {
    expect(AGENT_MEMORY_INTENT_REJECTION_CODES).toEqual([
      'intent_invalid',
      'path_invalid',
      'memory_md_not_deletable',
      'content_invalid',
      'intent_digest_mismatch',
      'agent_ref_mismatch',
      'agent_home_unavailable',
      'intent_revoked',
      'intent_expired',
      'placement_changed',
      'profile_revision_changed',
    ]);
    for (const code of AGENT_MEMORY_INTENT_REJECTION_CODES) {
      expect(parse({ ...completionIdentity(), outcome: 'rejected', code }), code).toBe(true);
      expect(code.length).toBeLessThanOrEqual(32);
    }
    expect(parse({ ...completionIdentity(), outcome: 'rejected', code: 'release_expired' })).toBe(false);
    expect(parse({ ...completionIdentity(), outcome: 'rejected', code: 'ledger_full' })).toBe(false);
  });
});

describe('readback', () => {
  const parse = (value: unknown) => AgentMemoryIntentReadbackSchema.safeParse(value).success;

  it.each(['recorded', 'idempotent', 'conflict'] as const)('accepts a %s readback of any terminal completion', (disposition) => {
    for (const outcome of ['applied', 'conflict', 'rejected', 'uncertain'] as const) {
      expect(parse(readback({ disposition, completion: completion(outcome) })), outcome).toBe(true);
    }
  });

  it('accepts host_terminal only with a rejected completion carrying a Host code', () => {
    for (const code of AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES) expect(parse(hostTerminalReadback(code)), code).toBe(true);
    for (const code of AGENT_MEMORY_INTENT_REJECTION_CODES.filter(
      (value) => !(AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES as readonly string[]).includes(value),
    )) {
      expect(parse(hostTerminalReadback(code)), code).toBe(false);
    }
    for (const outcome of ['applied', 'conflict', 'uncertain'] as const) {
      expect(parse(readback({ disposition: 'host_terminal', completion: completion(outcome) })), outcome).toBe(false);
    }
  });

  it('binds the completion to the readback intentId', () => {
    expect(parse(readback({ intentId: OTHER_INTENT_ID }))).toBe(false);
  });

  it('rejects unknown keys, unknown dispositions and a missing recordedAt', () => {
    expect(parse({ ...readback(), observedAt: '2026-09-28T05:00:00.000Z' })).toBe(false);
    expect(parse(readback({ disposition: 'pending' as 'recorded' }))).toBe(false);
    const { recordedAt: _recordedAt, ...withoutRecordedAt } = readback();
    expect(parse(withoutRecordedAt)).toBe(false);
    expect(parse(readback({ recordedAt: 'yesterday' }))).toBe(false);
    expect(parse(readback({ tenantId: '' }))).toBe(false);
    expect(parse(readback({ deviceId: '' }))).toBe(false);
  });
});
