/**
 * A deterministic envelope id from a canonical `sha256:<64 hex>` digest: the
 * first 128 bits, with the RFC 9562 version-8 and variant bits set. The cloud
 * and the device derive ids with this one function.
 */
export function uuidFromSha256(value: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (match === null) throw new Error('uuidFromSha256 needs canonical sha256 hex');
  const hex = match[1]!.slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) & 0x03]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

/**
 * The envelope id of the `task.steer_refused` that refuses the steer whose
 * envelope id is `steerMessageId` (#2009). Every replay of one refusal gets
 * the same id, whatever its reason, so the first reason recorded wins; the
 * server refuses a refusal whose id is not this one.
 */
export async function steerRefusalEnvelopeId(steerMessageId: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ domain: 'byok:task-steer-refused', steerMessageId }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return uuidFromSha256(`sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`);
}
