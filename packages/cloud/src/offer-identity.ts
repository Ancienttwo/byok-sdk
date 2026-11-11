import type { AgentRef } from '@byok-sdk/protocol';
export function uuidFromSha256(value: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (match === null) throw new Error('CloudCrypto.sha256 must return canonical sha256 hex');
  const digest = match[1];
  if (digest === undefined) throw new Error('CloudCrypto.sha256 must return canonical sha256 hex');
  const hex = digest.slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) & 0x03]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export async function taskOfferMessageId(tenant: string, taskId: string, deviceId: string, agentRef: AgentRef | undefined,
  sha256: (bytes: Uint8Array) => Promise<string>): Promise<string> {
  return uuidFromSha256(await sha256(new TextEncoder().encode(JSON.stringify({ domain: 'byok:task-offer', tenant, taskId, deviceId, agentRef }))));
}

export async function hashOfferBytes(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
