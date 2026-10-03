import type { AgentDO } from './agent-do';

export interface AgentIdentity {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly agentId: string;
}

export interface SessionIdentity extends AgentIdentity {
  readonly sessionId: string;
}

export async function agentObjectName(identity: AgentIdentity): Promise<string> {
  const ids = [identity.tenantId, identity.workspaceId, identity.agentId];
  if (ids.some(id => typeof id !== 'string' || !id)) throw new Error('Agent identity requires three nonempty ids');
  // JSON array encoding preserves tuple boundaries, Unicode and embedded delimiters.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ids)));
  return `agent:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Call only after the platform has authorized the tenant/workspace/agent identity. */
export async function getAgentObject(namespace: DurableObjectNamespace<AgentDO>, identity: AgentIdentity) {
  return namespace.getByName(await agentObjectName(identity));
}

export async function sessionObjectName(identity: SessionIdentity): Promise<string> {
  const ids = [identity.tenantId, identity.workspaceId, identity.agentId, identity.sessionId];
  if (ids.some(id => typeof id !== 'string' || !id)) throw new Error('Session identity requires four nonempty ids');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ids)));
  return `session:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The consuming platform authorizes all four identity fields before this lookup. */
export async function getSessionObject(namespace: DurableObjectNamespace<AgentDO>, identity: SessionIdentity) {
  return namespace.getByName(await sessionObjectName(identity));
}
