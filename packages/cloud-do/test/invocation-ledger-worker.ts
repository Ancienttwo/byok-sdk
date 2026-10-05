import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { cloudErrorResponse } from '../src/errors';
import { InvocationLedger, type InvocationInput, type InvocationTerminalState,
  type InvocationFinishOptions } from '../src/invocation-ledger';
import type { CloudDoErrorCode } from '../src/errors';
import { openDurableObjectStorage } from '../src/storage';

export interface LedgerOperation {
  operation: 'begin' | 'parallel-begin' | 'finish' | 'read' | 'pending' | 'recover' | 'start-execution'
    | 'execution' | 'fail' | 'abort' | 'model' | 'tool' | 'schema' | 'usage' | 'sent' | 'legacy-schema';
  name: string;
  input: InvocationInput;
  id: string;
  conversationId: number;
  deadlineAt: number;
  state: InvocationTerminalState;
  result?: Record<string, unknown>;
  code: CloudDoErrorCode;
  now: number;
  options?: InvocationFinishOptions;
  max: number;
  taskId: string;
  budget?: { inputBytes: number; inputTokens: number; outputTokens: number };
  inputDelta: number;
  outputDelta: number;
}

/** The bridge runs the production ledger against actual DO SQLite. */
export class LedgerDO extends DurableObject {
  readonly ledger = new InvocationLedger(this.ctx.storage);
  run(input: LedgerOperation) {
    this.ledger.ensureSchema();
    switch (input.operation) {
      case 'begin': return this.ledger.begin(input.input);
      case 'parallel-begin': return Promise.all(Array.from({ length: 20 }, async () => this.ledger.begin(input.input)));
      case 'finish': return this.ledger.finish(input.id, input.state, input.result, input.code, input.now, input.options);
      case 'read': return this.ledger.read(input.id) ?? null;
      case 'pending': return this.ledger.pending();
      case 'recover': return this.ledger.claimRecovery(input.now);
      case 'start-execution': return this.ledger.startExecution(input.conversationId, input.deadlineAt);
      case 'execution': return this.ledger.execution(input.conversationId) ?? null;
      case 'fail': return this.ledger.failExecution(input.conversationId, input.code);
      case 'abort': return this.ledger.abortExecution(input.conversationId, input.code);
      case 'model': return this.ledger.countModel(input.conversationId, input.max, input.now, input.budget);
      case 'usage': this.ledger.addModelUsage(input.conversationId, input.inputDelta, input.outputDelta); return this.ledger.execution(input.conversationId);
      case 'sent': this.ledger.markModelSent(input.conversationId); return this.ledger.execution(input.conversationId);
      case 'legacy-schema':
        for (const name of ['inputTokens', 'outputTokens', 'credits', 'sentRequests']) {
          this.ctx.storage.sql.exec(`ALTER TABLE cloud_executions DROP COLUMN ${name}`);
        }
        return this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(cloud_executions)').toArray().map(row => row.name);
      case 'tool': return this.ledger.countTool(input.conversationId, input.taskId, input.max, input.now);
      case 'schema': return this.schema();
    }
  }
  async schema() {
    const storage = await openDurableObjectStorage(this.ctx.storage);
    await storage.close(ctx);
    return {
      tables: this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray().map(row => row.name),
      columns: this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(cloud_invocations)').toArray().map(row => row.name),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}

export default {
  async fetch(request: Request, env: { LEDGERS: DurableObjectNamespace<LedgerDO> }) {
    try {
      const body = await request.json() as LedgerOperation;
      return Response.json(await env.LEDGERS.getByName(body.name).run(body));
    } catch (error) { return cloudErrorResponse(error); }
  },
};
