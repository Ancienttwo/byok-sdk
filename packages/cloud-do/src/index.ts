export { AgentDO } from './agent-do';
export { agentObjectName, getAgentObject, type AgentIdentity } from './identity';
export { DurableObjectSqliteDatabase, openDurableObjectStorage } from './storage';

// This slice is binding/RPC-only. Public request routing belongs to the consuming platform.
export default { fetch: () => new Response('Not found', { status: 404 }) };
