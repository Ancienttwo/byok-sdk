import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MEMORY_INTENT_DIGEST_VERSION,
  agentMemoryIntentOperationDigest,
  canonicalizeJson,
  isCoreError,
  type AgentMemoryIntentDigestInput,
} from '../index';

const EMPTY_REVISION = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HELLO_REVISION = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const REPLACE: AgentMemoryIntentDigestInput = {
  tenantId: 'tenant-golden',
  deviceId: 'device-golden',
  intentId: '20000000-0000-4000-8000-000000000001',
  agentRef: { agentId: 'agent-golden-1', profileRevision: '7' },
  path: 'notes/host-golden.md',
  operation: 'replace',
  baseRevision: EMPTY_REVISION,
  targetRevision: HELLO_REVISION,
  approvalRef: 'approval:golden-1',
};

const DELETE: AgentMemoryIntentDigestInput = {
  ...REPLACE,
  intentId: '20000000-0000-4000-8000-000000000002',
  operation: 'delete',
  baseRevision: HELLO_REVISION,
  targetRevision: null,
};

/**
 * Fixed-bytes goldens. The canonical text is written out by hand (RFC 8785
 * member order) and hashed independently with `node:crypto`, so the golden
 * does not depend on the implementation under test.
 */
const REPLACE_CANONICAL =
  '{"agentRef":{"agentId":"agent-golden-1","profileRevision":"7"},"approvalRef":"approval:golden-1",' +
  `"baseRevision":"${EMPTY_REVISION}","deviceId":"device-golden","intentId":"20000000-0000-4000-8000-000000000001",` +
  `"operation":"replace","path":"notes/host-golden.md","targetRevision":"${HELLO_REVISION}",` +
  '"tenantId":"tenant-golden","v":"byok-agent-memory-intent-v1"}';
const REPLACE_GOLDEN = 'sha256:5f3d66a378253cc99c67c3c0d3aea38bab61f54a306c3c1aaf359617528e94c1';

const DELETE_CANONICAL =
  '{"agentRef":{"agentId":"agent-golden-1","profileRevision":"7"},"approvalRef":"approval:golden-1",' +
  `"baseRevision":"${HELLO_REVISION}","deviceId":"device-golden","intentId":"20000000-0000-4000-8000-000000000002",` +
  '"operation":"delete","path":"notes/host-golden.md","targetRevision":null,' +
  '"tenantId":"tenant-golden","v":"byok-agent-memory-intent-v1"}';
const DELETE_GOLDEN = 'sha256:1f5890654c9903c05fcf6c1e1744b5a7c83a583d8b0efc2de54494c636549de8';

function nodeDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

describe('agentMemoryIntentOperationDigest', () => {
  it('pins the digest domain tag', () => {
    expect(AGENT_MEMORY_INTENT_DIGEST_VERSION).toBe('byok-agent-memory-intent-v1');
  });

  it('matches the fixed-bytes golden for a replace intent', async () => {
    expect(nodeDigest(REPLACE_CANONICAL)).toBe(REPLACE_GOLDEN);
    expect(canonicalizeJson({ v: AGENT_MEMORY_INTENT_DIGEST_VERSION, ...REPLACE })).toBe(REPLACE_CANONICAL);
    await expect(agentMemoryIntentOperationDigest(REPLACE)).resolves.toBe(REPLACE_GOLDEN);
  });

  it('matches the fixed-bytes golden for a delete intent (null targetRevision is covered)', async () => {
    expect(nodeDigest(DELETE_CANONICAL)).toBe(DELETE_GOLDEN);
    await expect(agentMemoryIntentOperationDigest(DELETE)).resolves.toBe(DELETE_GOLDEN);
  });

  it('is independent of property insertion order and ignores fields it does not cover', async () => {
    const reordered: AgentMemoryIntentDigestInput = {
      approvalRef: REPLACE.approvalRef,
      targetRevision: REPLACE.targetRevision,
      baseRevision: REPLACE.baseRevision,
      operation: REPLACE.operation,
      path: REPLACE.path,
      agentRef: { profileRevision: '7', agentId: 'agent-golden-1' },
      intentId: REPLACE.intentId,
      deviceId: REPLACE.deviceId,
      tenantId: REPLACE.tenantId,
    };
    await expect(agentMemoryIntentOperationDigest(reordered)).resolves.toBe(REPLACE_GOLDEN);
    const withExtras = {
      ...REPLACE,
      content: 'hello',
      operationDigest: 'sha256:' + '0'.repeat(64),
      agentRef: { ...REPLACE.agentRef, extra: 'ignored' },
    } as AgentMemoryIntentDigestInput;
    await expect(agentMemoryIntentOperationDigest(withExtras)).resolves.toBe(REPLACE_GOLDEN);
  });

  const MUTATIONS: ReadonlyArray<readonly [string, AgentMemoryIntentDigestInput]> = [
    ['tenantId', { ...REPLACE, tenantId: 'tenant-other' }],
    ['deviceId', { ...REPLACE, deviceId: 'device-other' }],
    ['intentId', { ...REPLACE, intentId: '20000000-0000-4000-8000-000000000009' }],
    ['agentRef.agentId', { ...REPLACE, agentRef: { ...REPLACE.agentRef, agentId: 'agent-golden-2' } }],
    ['agentRef.profileRevision', { ...REPLACE, agentRef: { ...REPLACE.agentRef, profileRevision: '8' } }],
    ['path', { ...REPLACE, path: 'notes/host-other.md' }],
    ['operation', { ...REPLACE, operation: 'delete' }],
    ['baseRevision', { ...REPLACE, baseRevision: 'sha256:' + 'a'.repeat(64) }],
    ['targetRevision', { ...REPLACE, targetRevision: 'sha256:' + 'b'.repeat(64) }],
    ['targetRevision -> null', { ...REPLACE, targetRevision: null }],
    ['approvalRef', { ...REPLACE, approvalRef: 'approval:golden-2' }],
  ];

  it.each(MUTATIONS)('changes when %s changes', async (_field, mutated) => {
    const digest = await agentMemoryIntentOperationDigest(mutated);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(digest).not.toBe(REPLACE_GOLDEN);
  });

  it('gives every single-field mutation a distinct digest', async () => {
    const digests = await Promise.all(MUTATIONS.map(([, input]) => agentMemoryIntentOperationDigest(input)));
    expect(new Set([REPLACE_GOLDEN, ...digests]).size).toBe(MUTATIONS.length + 1);
  });

  it('fails closed when a covered field is missing', async () => {
    const { approvalRef: _omitted, ...missing } = REPLACE;
    const failure = await agentMemoryIntentOperationDigest(missing as unknown as AgentMemoryIntentDigestInput).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isCoreError(failure)).toBe(true);
  });
});
