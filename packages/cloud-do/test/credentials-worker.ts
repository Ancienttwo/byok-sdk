import { AgentDO } from '../src/agent-do';
import { cloudErrorResponse } from '../src/errors';

/** Test-only audit RPC: all tables and every row, including native pi state. */
export class AuditAgentDO extends AgentDO {
  async dump() {
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
    return Object.fromEntries(tables.map(({ name }) => [name,
      this.ctx.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray().map(row => Object.fromEntries(
        Object.entries(row).map(([column, value]) => [column, value instanceof ArrayBuffer
          ? { bytes: Array.from(new Uint8Array(value)), utf8: new TextDecoder().decode(value) } : value]),
      )),
    ]));
  }
}

interface Env { AGENTS: DurableObjectNamespace<AuditAgentDO> }
// This bridge is bundled only in the integration tests, never in the deployed Worker.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const body = await request.json() as { name: string; operation: 'dump' | 'submit' | 'append'; input: unknown };
      const agent = env.AGENTS.getByName(body.name);
      if (body.operation === 'dump') return Response.json(await agent.dump());
      if (body.operation === 'append') {
        await agent.appendExecution(2, body.input as string);
        return Response.json({ ok: true });
      }
      return await agent.submit(body.input);
    } catch (error) { return cloudErrorResponse(error); }
  },
};
