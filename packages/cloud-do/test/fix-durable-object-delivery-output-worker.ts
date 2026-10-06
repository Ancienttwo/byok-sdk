import { AgentDO } from '../src/agent-do';
import { cloudErrorResponse } from '../src/errors';
import type { CloudToolDispatcher } from '../src/tools';

export class OutputAuditDO extends AgentDO {
  protected override createDispatcher(id: string): CloudToolDispatcher | undefined {
    return id === 'output-fixture' ? { tools: [], execute: async () => { throw new Error('No fixture tool is available'); } } : undefined;
  }
}
interface Env { AGENTS: DurableObjectNamespace<OutputAuditDO> }
export default { async fetch(request: Request, env: Env) {
  try {
    const input = await request.json() as { name: string; operation: string; id: number; page?: { entryId?: number; offset?: number } };
    const agent = env.AGENTS.getByName(input.name);
    switch (input.operation) {
      case 'setup': return agent.configureSession({
        identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: input.name },
        principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' },
        scopes: [], dispatcherId: 'output-fixture',
      });
      case 'submit': return agent.submit({ instruction: 'Return the fixture output exactly.' });
      case 'output': return Response.json(await agent.readRunOutput(input.id, input.page));
      default: return new Response('Unknown fixture operation', { status: 400 });
    }
  } catch (error) { return cloudErrorResponse(error); }
} };
