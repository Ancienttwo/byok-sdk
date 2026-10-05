import { AgentDO } from '../src/agent-do';
import { cloudErrorResponse } from '../src/errors';

/** Test-only audit RPC: all tables and every row, including native pi state. */
export class AuditAgentDO extends AgentDO {
  async cancelLocal(input: unknown): Promise<Response> {
    const response = await this.submit(input);
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    return Response.json({ first: new TextDecoder().decode(first.value), cancelled: true });
  }

  async dump() {
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
    const audit = Object.fromEntries(tables.filter(({ name }) => name !== '_cf_METADATA').map(({ name }) => [name,
      this.ctx.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray().map(row => Object.fromEntries(
        Object.entries(row).map(([column, value]) => [column, value instanceof ArrayBuffer
          ? { bytes: Array.from(new Uint8Array(value)), utf8: new TextDecoder().decode(value) } : value]),
      )),
    ]));
    return tables.some(({ name }) => name === '_cf_METADATA')
      ? { ...audit, _cf_ALARM_READBACK: [{ scheduledTime: await this.ctx.storage.getAlarm() }] } : audit;
  }
}

interface Env { AGENTS: DurableObjectNamespace<AuditAgentDO> }
// This bridge is bundled only in the integration tests, never in the deployed Worker.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const body = await request.json() as { name: string; operation: 'dump' | 'submit' | 'append' | 'console' | 'cancel-inside' | 'cancel-local'; input: unknown };
      if (body.operation === 'console') {
        console.log('cloud-4b-console-positive-log');
        console.warn('cloud-4b-console-positive-warn');
        console.error('cloud-4b-console-positive-error');
        return Response.json({ ok: true });
      }
      const agent = env.AGENTS.getByName(body.name);
      if (body.operation === 'dump') return Response.json(await agent.dump());
      if (body.operation === 'cancel-local') return await agent.cancelLocal(body.input);
      if (body.operation === 'cancel-inside') {
        const response = await agent.submit(body.input);
        const reader = response.body!.getReader();
        const first = await reader.read();
        await reader.cancel();
        return Response.json({ first: new TextDecoder().decode(first.value), cancelled: true });
      }
      if (body.operation === 'append') {
        await agent.appendExecution(2, body.input as string);
        return Response.json({ ok: true });
      }
      return await agent.submit(body.input);
    } catch (error) { return cloudErrorResponse(error); }
  },
};
