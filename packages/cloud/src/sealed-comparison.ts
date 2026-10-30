/**
 * #654 §9.2: the Host compares two sealed submissions by their comparison
 * projection, not by their bytes. A sender may seal the same content again,
 * with a new salt and nonce, when it retries. The projection keeps every
 * plaintext field and the stable outer fields of `sealed`. It drops `salt`,
 * `nonce`, `ciphertext`, `ciphertextRef` and `sender`. The content MAC binds
 * the scope, the epoch, the category, the family, the identity and the
 * plaintext, so an equal projection names the same content.
 */
const STABLE_SEALED_FIELDS = ['v', 'suite', 'category', 'scope', 'paddedLength', 'contentMac'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sealedComparisonProjection(payload: Record<string, unknown>): Record<string, unknown> {
  const { sealed, ...plain } = payload;
  if (!isRecord(sealed)) return payload;
  return { ...plain, sealed: Object.fromEntries(STABLE_SEALED_FIELDS.map((field) => [field, sealed[field]])) };
}

/** The receipt body of one sealed submission: its target device, its type and its payload. */
export interface SealedSubmission {
  readonly deviceId: string;
  readonly type: string;
  readonly payload: object;
}

/**
 * The payload of the first submission when `storedBody` (a receipt body) has
 * the same device, the same type and the same comparison projection as
 * `proposed`. The Host then keeps the first ciphertext. Otherwise undefined,
 * which the caller reports as a conflict.
 */
export function firstSealedPayload(storedBody: string, proposed: SealedSubmission): Record<string, unknown> | undefined {
  let first: unknown;
  try {
    first = JSON.parse(storedBody);
  } catch {
    return undefined;
  }
  if (!isRecord(first) || first.deviceId !== proposed.deviceId || first.type !== proposed.type || !isRecord(first.payload)) return undefined;
  return sameSealedProjection(first.payload, proposed.payload) ? first.payload : undefined;
}

/** True when two payloads of one sealed type have the same comparison projection. */
export function sameSealedProjection(first: object, proposed: object): boolean {
  return JSON.stringify(sealedComparisonProjection(first as Record<string, unknown>)) === JSON.stringify(sealedComparisonProjection(proposed as Record<string, unknown>));
}
