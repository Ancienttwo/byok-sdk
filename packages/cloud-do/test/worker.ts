import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import { AgentDO } from '../src/agent-do';
import { agentObjectName, getAgentObject, type AgentIdentity } from '../src/identity';
import { DurableObjectSqliteDatabase, openDurableObjectStorage } from '../src/storage';
import { createByokStorageContract } from './storage-contract';
import { assertions as a } from './assertions';
export { AgentDO };

export class ContractDO extends DurableObject {
  async contract(index: number) {
    const cases = createByokStorageContract(async use => {
      let storage = await openDurableObjectStorage(this.ctx.storage);
      try {
        await use(storage, async () => {
          await storage.close(ctx);
          storage = await openDurableObjectStorage(this.ctx.storage);
          return storage;
        });
      } finally { await storage.close(ctx); }
    }, a);
    const test = cases[index];
    if (!test) throw new Error('Unknown contract case');
    await test.run();
  }

  async transactions() {
    const db = new DurableObjectSqliteDatabase(this.ctx.storage);
    await db.exec('CREATE TABLE isolation (value TEXT)');
    let escaped: SqliteExecutor | undefined;
    let outside: Promise<unknown> | undefined;
    const failure = new Error('rollback marker');
    try {
      await db.transaction(async tx => {
        escaped = tx;
        await tx.run('INSERT INTO isolation VALUES (?)', 'transient');
        outside = db.all('SELECT * FROM isolation');
        await Promise.resolve();
        a.deepEqual(await tx.all('SELECT * FROM isolation'), [{ value: 'transient' }]);
        throw failure;
      });
      throw new Error('Transaction unexpectedly succeeded');
    } catch (error) { a.strictEqual(error, failure); }
    a.deepEqual(await outside, []);
    await a.rejects(escaped!.run('INSERT INTO isolation VALUES (?)', 'escaped'), 'no longer active');
    await a.rejects(db.exec('INVALID SQL'), 'syntax error');
    await db.transaction(async tx => { await tx.run('INSERT INTO isolation VALUES (?)', 'committed'); });
    a.deepEqual(await db.all('SELECT * FROM isolation'), [{ value: 'committed' }]);
    const beforeClose = db.get('SELECT * FROM isolation');
    const closing = db.close();
    const afterClose = db.get('SELECT * FROM isolation');
    a.deepEqual(await beforeClose, { value: 'committed' });
    await closing;
    await a.rejects(afterClose, 'closed');
    await db.close();
  }

  async schema() {
    this.ctx.storage.sql.exec("CREATE TABLE conversations (value TEXT); INSERT INTO conversations VALUES ('host table')");
    const storage = await openDurableObjectStorage(this.ctx.storage);
    await storage.close(ctx);
    const objects = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    a.ok(objects.some(item => item.name === 'pi_conversations'));
    a.ok(objects.some(item => item.name === 'pi_entries_by_conversation'));
    a.ok(objects.every(item => item.name === 'conversations' || item.name.startsWith('pi_')));
    a.deepEqual(this.ctx.storage.sql.exec('SELECT * FROM conversations').toArray(), [{ value: 'host table' }]);
    const db = new DurableObjectSqliteDatabase(this.ctx.storage);
    a.deepEqual(await db.get("SELECT 'conversations' AS literal"), { literal: 'conversations' });
    await db.exec('CREATE TABLE bindings (n INTEGER, blob BLOB)');
    await db.run('INSERT INTO bindings VALUES (?, ?)', 42n, new Uint8Array([0, 1, 2, 3]).subarray(1, 3));
    const bound = await db.get<{ n: number; blob: Uint8Array }>('SELECT * FROM bindings');
    a.strictEqual(bound?.n, 42);
    a.deepEqual(Array.from(bound!.blob), [1, 2]);
    await a.rejects(db.run('INSERT INTO bindings (n) VALUES (?)', BigInt(Number.MAX_SAFE_INTEGER) + 1n), 'safe range');
    await db.close();
  }

  async limits() {
    const db = new DurableObjectSqliteDatabase(this.ctx.storage);
    const params = Array.from({ length: 100 }, (_, i) => i);
    a.strictEqual((await db.get<{ result: number }>(`SELECT sum(value) AS result FROM json_each(json_array(${params.map(() => '?').join(',')}))`, ...params))?.result, 4950);
    await a.rejects(db.get(`SELECT sum(value) FROM json_each(json_array(${[...params, 100].map(() => '?').join(',')}))`, ...params, 100), 'too many SQL variables');
    await db.close();
  }
}

interface Env {
  AGENTS: DurableObjectNamespace<AgentDO>;
  CONTRACTS: DurableObjectNamespace<ContractDO>;
}
// Test-only bridge; absent from the deployable Worker. All storage tests execute inside workerd.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const body = await request.json() as { operation: string; name: string; index: number; identity: AgentIdentity; conversationId: number; text: string };
      if (body.operation === 'name') return Response.json(await agentObjectName(body.identity));
      if (body.operation.startsWith('contract:')) {
        const stub = env.CONTRACTS.getByName(body.name);
        switch (body.operation) {
          case 'contract:case': await stub.contract(body.index); break;
          case 'contract:transactions': await stub.transactions(); break;
          case 'contract:schema': await stub.schema(); break;
          case 'contract:limits': await stub.limits(); break;
          default: throw new Error('Unknown operation');
        }
        return Response.json({ ok: true });
      }
      const agent = await getAgentObject(env.AGENTS, body.identity);
      switch (body.operation) {
        case 'open': return Response.json(await agent.open());
        case 'execution': return Response.json(await agent.openExecution());
        case 'append': await agent.appendExecution(body.conversationId, body.text); return Response.json({ ok: true });
        case 'read': return Response.json(await agent.readExecution(body.conversationId));
        case 'lookup': {
          const name = await agentObjectName(body.identity);
          return Response.json({ name, byName: agent.id.toString(), byId: env.AGENTS.get(env.AGENTS.idFromName(name)).id.toString() });
        }
        default: throw new Error('Unknown operation');
      }
    } catch (error) { return new Response(error instanceof Error ? error.stack : String(error), { status: 500 }); }
  },
};
