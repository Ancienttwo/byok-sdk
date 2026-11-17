import { uuidFromSha256, type AgentRef } from '@byok-sdk/protocol';
export async function taskOfferMessageId(tenant: string, taskId: string, deviceId: string, agentRef: AgentRef,
  sha256: (bytes: Uint8Array) => Promise<string>): Promise<string> {
  return uuidFromSha256(await sha256(new TextEncoder().encode(JSON.stringify({ domain: 'byok:task-offer', tenant, taskId, deviceId, agentRef }))));
}

export async function hashOfferBytes(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
