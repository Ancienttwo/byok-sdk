import { AgentDO } from '../src/agent-do';
import { CloudDoError } from '../src/errors';
import type { CloudToolDispatcher } from '../src/tools';

/** The response stays inside workerd: no client/proxy can drain or buffer it. */
export class DeliveryAuditDO extends AgentDO {
  private held: ReadableStreamDefaultReader<Uint8Array>[] = [];
  private closedResponses = 0;

  protected override createDispatcher(id: string): CloudToolDispatcher | undefined {
    if (id !== 'delivery-fixture') return undefined;
    return { tools: [{ name: 'load_financial_analysis_skill', description: 'Wait for fixture cancellation.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, execution: 'skill' }],
    execute: async (_context, _name, _args, signal) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new CloudDoError('CLOUD_EXECUTION_ABORTED'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return { ok: true, data: {}, usage: { credits: 0 } };
    } };
  }

  async hold(instruction: string) {
    const harness = await this.sessionRuntime().ready();
    if (instruction === 'fail settlement') this.ctx.storage.sql.exec(`CREATE TRIGGER fixture_settlement_failure
      BEFORE UPDATE OF state ON cloud_executions WHEN NEW.state='completed'
      BEGIN SELECT RAISE(ABORT, 'fixture settlement unavailable'); END`);
    const create = harness.createConversation.bind(harness);
    // Isolate the existing catch/error-delivery path without replacing native storage.
    if (instruction === 'fail submission') harness.createConversation = async (...args) => {
      const conversation = await create(...args);
      conversation.submit = async () => { throw new CloudDoError('CLOUD_MODEL_REQUEST_FAILED'); };
      return conversation;
    };
    let response: Response;
    try { response = await this.submit({ instruction }); }
    finally { harness.createConversation = create; }
    if (response.status !== 200) return { status: response.status, error: await response.text() };
    const reader = response.body!.getReader();
    this.held.push(reader);
    void reader.closed.then(() => { this.closedResponses++; }, () => { this.closedResponses++; });
    return { status: response.status };
  }
  async discard() {
    await Promise.all(this.held.splice(0).map(reader => reader.cancel().catch(() => undefined)));
  }
  async repair() {
    this.ctx.storage.sql.exec('DROP TRIGGER fixture_settlement_failure');
    await this.alarm();
  }
  status() {
    const runtime = this.sessionRuntime();
    return { liveOwner: runtime.hasLiveOwner, busy: runtime.busy, closedResponses: this.closedResponses,
      settled: runtime.activeLease?.settled, aborted: runtime.activeLease?.controller.signal.aborted,
      runs: this.ctx.storage.sql.exec('SELECT state,errorCode FROM cloud_executions ORDER BY conversationId DESC').toArray(), invocations: this.ctx.storage.sql.exec('SELECT state,errorCode FROM cloud_invocations').toArray() };
  }
}

interface Env { AGENTS: DurableObjectNamespace<DeliveryAuditDO> }
export default { async fetch(request: Request, env: Env) {
  const body = await request.json() as { name: string; operation: string; timeout?: number; instruction?: string };
  const agent = env.AGENTS.getByName(body.name);
  switch (body.operation) {
    case 'setup': return agent.configureSession({
      identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: body.name },
      principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' },
      scopes: [], dispatcherId: 'delivery-fixture', limits: { turnTimeoutMs: body.timeout },
    });
    case 'hold': return Response.json(await agent.hold(body.instruction!));
    case 'status': return Response.json(await agent.status());
    case 'cancel': return agent.cancelActiveRun();
    case 'repair': await agent.repair(); return Response.json({ repaired: true });
    case 'discard': await agent.discard(); return Response.json({ discarded: true });
    case 'submit': return agent.submit({ instruction: body.instruction });
    default: return new Response('Unknown fixture operation', { status: 400 });
  }
} };
