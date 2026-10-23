/**
 * Minimal sealed payloads for the exhaustive per-type fixtures (#654). A
 * sealed type is its plaintext type without the moved and forbidden fields,
 * plus a well-formed sealed member. The member is shape-valid only: these
 * fixtures test envelope and codec rules, not cryptography.
 */
import {
  SEALED_SPLIT_TABLE,
  type MessageType,
  type SealedMessageType,
  type SealedPayloadV1Category,
} from '../index';

export function sealedMemberFixture(category: SealedPayloadV1Category, scope = { id: 'scope-1', epoch: 1 }) {
  return {
    v: 1,
    suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm',
    category,
    scope: { ...scope, keyId: 'A'.repeat(22) },
    chainHead: { seq: 1, hash: `sha256:${'0'.repeat(64)}` },
    sender: 'A'.repeat(43),
    salt: Buffer.alloc(32).toString('base64url'),
    nonce: Buffer.alloc(12).toString('base64url'),
    paddedLength: 256,
    contentMac: `hmac-sha256:${'0'.repeat(64)}`,
    ciphertext: Buffer.alloc(256 + 16).toString('base64url'),
  };
}

/** The sealed counterpart of a plaintext fixture `plain(entry.plainType)`. */
export function minimalSealedPayload(type: SealedMessageType, plain: (type: MessageType) => unknown): Record<string, unknown> {
  const entry = SEALED_SPLIT_TABLE[type];
  if (type === 'task.steer_sealed') {
    return { steerId: '00000000-0000-4000-8000-000000000001', sealed: sealedMemberFixture('task-input') };
  }
  const payload = { ...(plain(entry.plainType) as Record<string, unknown>) };
  for (const field of [...entry.moved, ...entry.forbidden]) delete payload[field];
  if (entry.category === 'task-input') {
    return { ...payload, sealing: { scopeId: 'scope-1', epoch: 1, categories: ['task-input'] }, sealed: sealedMemberFixture('task-input') };
  }
  return {
    ...payload,
    ...(type === 'task.await_approval_sealed' ? { approvalId: 'appr-1' } : {}),
    sealed: sealedMemberFixture('task-output'),
  };
}
