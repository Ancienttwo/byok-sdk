// The installed Worker consumer of check:release-pack: the only @byok-sdk
// imports a Cloudflare Worker needs, so the README's Worker install set is
// checked against workerConsumerImports. workerSource is the authority; the list
// is written out so install-matrix.test.mjs runs without an install, and
// cloud-do-consumer-smoke.mjs fails when the two drift apart.
export const workerSource = `import { AgentDO, DurableObjectSqliteDatabase, sessionObjectName } from '@byok-sdk/cloud-do';
import { validateResultOutcome } from '@byok-sdk/protocol';

export class ConsumerDO extends AgentDO {
  protected instructions(): string { return 'Consumer hook reached.'; }

  async probe() {
    const hook = this.instructions();
    const database = new DurableObjectSqliteDatabase(this.ctx.storage);
    try {
      await database.run('CREATE TABLE IF NOT EXISTS consumer_probe (value TEXT)');
      await database.run('INSERT INTO consumer_probe (value) VALUES (?)', hook);
      const row = await database.get<{ value: string }>('SELECT value FROM consumer_probe LIMIT 1');
      const objectName = await sessionObjectName({ tenantId: 'consumer', workspaceId: 'workspace', agentId: 'agent', sessionId: 'session' });
      const schema = { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } };
      const valid = validateResultOutcome(schema, { answer: hook });
      const invalid = validateResultOutcome(schema, { answer: 1 });
      return { hook, stored: row?.value, objectName, valid, invalid };
    } finally { await database.close(); }
  }
}

export default {
  async fetch(_request: Request, env: { AGENTS: DurableObjectNamespace<ConsumerDO> }): Promise<Response> {
    return Response.json(await env.AGENTS.getByName('consumer').probe());
  },
};
`;
export const workerConsumerImports = ['@byok-sdk/cloud-do', '@byok-sdk/protocol'];
