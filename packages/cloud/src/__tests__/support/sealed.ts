/**
 * Sealed members and ciphertext blobs for the Host tests of #654 E3b. Each
 * seal draws a new salt and nonce, as a sender that seals again on a retry
 * does. Test data only.
 */
import type { TenantId } from '@byok-sdk/core';
import type { SealableMessageType } from '@byok-sdk/protocol';
import { sealContent, type SealedContent } from '@byok-sdk/core/sealed-payload';
import type { CloudHarness, PairedDevice } from './harness';

/** The scope of the golden corpus, so a corpus payload's `sealing` names it. */
export const SEALING = { scopeId: 'scope-golden-device-1', epoch: 2, categories: ['task-input', 'task-output'] } as const;
const SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

/** Text this long seals above the inline limit, so the member carries `ciphertextRef`. */
export const BY_REFERENCE_TEXT_LENGTH = 300 * 1024;

export interface SealedInput {
  readonly tenant: TenantId;
  readonly deviceId: string;
  /** The sealable wire type, which is also the binding family. */
  readonly type: SealableMessageType;
  readonly identity: Readonly<Record<string, string>>;
  readonly plaintext: Readonly<Record<string, string>>;
}

/** One `task-input` member of `type`, sealed now. */
export async function sealInput(input: SealedInput): Promise<SealedContent> {
  return sealContent({
    scopeKey: SCOPE_KEY,
    scope: { id: SEALING.scopeId, epoch: SEALING.epoch },
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43),
    category: 'task-input',
    binding: {
      tenantId: input.tenant,
      family: input.type,
      direction: 'server-to-daemon',
      identity: input.identity,
      deviceId: input.deviceId,
      agentRef: null,
      categories: [...SEALING.categories],
      notAfter: null,
    },
    plaintext: input.plaintext,
    maxContentLength: 2 * 1024 * 1024,
  });
}

export interface TemplateInput {
  readonly tenant: TenantId;
  readonly routineRef: { readonly routineId: string; readonly definitionVersion: number; readonly notAfter: string };
  readonly agentRef: { readonly agentId: string; readonly profileRevision: string };
  readonly plaintext: Readonly<Record<string, string>>;
}

/** One routine template (#654 E3d), sealed now: family `routine.template`, no device. */
export async function sealTemplate(input: TemplateInput): Promise<SealedContent> {
  return sealContent({
    scopeKey: SCOPE_KEY,
    scope: { id: SEALING.scopeId, epoch: SEALING.epoch },
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43),
    category: 'task-input',
    binding: {
      tenantId: input.tenant,
      family: 'routine.template',
      direction: 'server-to-daemon',
      identity: { routineId: input.routineRef.routineId, definitionVersion: input.routineRef.definitionVersion },
      deviceId: null,
      agentRef: input.agentRef,
      categories: [...SEALING.categories],
      notAfter: input.routineRef.notAfter,
    },
    plaintext: input.plaintext,
    maxContentLength: 2 * 1024 * 1024,
  });
}

/** The inline wire member of `content`, which {@link sealInput} sealed. */
export function inlineMember(content: SealedContent) {
  return { ...content.header, category: 'task-input' as const, ciphertext: Buffer.from(content.ciphertext).toString('base64url') };
}

export interface CiphertextRef {
  readonly blobId: string;
  readonly contentHash: string;
  readonly size: number;
  readonly contentType: string;
}

/** The by-reference wire member of `content`, which {@link sealInput} sealed. */
export function referenceMember(content: SealedContent, ref: CiphertextRef) {
  return { ...content.header, category: 'task-input' as const, ciphertextRef: ref };
}

export const CIPHERTEXT_CONTENT_TYPE = 'application/octet-stream';

export async function sha256Hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Uploads `bytes` through the device blob routes, and finalizes it unless told not to. */
export async function uploadCiphertext(
  harness: CloudHarness,
  device: PairedDevice,
  bytes: Uint8Array,
  options: { readonly contentType?: string; readonly finalize?: boolean } = {},
): Promise<CiphertextRef> {
  const contentType = options.contentType ?? CIPHERTEXT_CONTENT_TYPE;
  const contentHash = await sha256Hash(bytes);
  const reservationId = `sealed-${contentHash.slice('sha256:'.length)}`;
  const created = await harness.request('/byok/blobs', {
    method: 'POST',
    headers: { ...device.authorization, 'content-type': 'application/json', 'idempotency-key': reservationId },
    body: JSON.stringify({ size: bytes.byteLength, contentType, contentHash }),
  });
  if (created.status !== 200) throw new Error(`blob create failed: ${created.status} ${await created.text()}`);
  const { blobId, uploadUrl } = (await created.json()) as { blobId: string; uploadUrl: string };
  const put = await harness.request(uploadUrl, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
  if (!put.ok) throw new Error(`blob upload failed: ${put.status} ${await put.text()}`);
  if (options.finalize !== false) {
    const finalized = await harness.request(`/byok/blobs/${blobId}/finalize`, {
      method: 'POST',
      headers: { ...device.authorization, 'idempotency-key': reservationId },
    });
    if (finalized.status !== 204) throw new Error(`blob finalize failed: ${finalized.status} ${await finalized.text()}`);
  }
  return { blobId, contentHash, size: bytes.byteLength, contentType };
}
