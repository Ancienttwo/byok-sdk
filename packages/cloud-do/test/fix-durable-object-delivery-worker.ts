import { AgentDO } from '../src/agent-do';
import { CloudDoError } from '../src/errors';
import type { CloudToolDispatcher } from '../src/tools';

/** The response stays inside workerd: no client/proxy can drain or buffer it. */
export class DeliveryAuditDO extends AgentDO {
  private held: ReadableStreamDefaultReader<Uint8Array>[] = [];
  private closedResponses = 0;
  private expiredEntry?: { now: number; executionDeadline: number; invocationDeadline: number };
  private restoreClock?: () => void;

  /** Let the durable invocation commit, then cross the execution deadline before its entry check. */
  expireAtInvocationEntry() {
    const runtime = this.sessionRuntime();
    const begin = runtime.ledger.begin.bind(runtime.ledger);
    runtime.ledger.begin = (input) => {
      const begun = begin(input);
      if (begun.kind !== 'started') return begun;
      runtime.ledger.begin = begin;
      const execution = runtime.ledger.execution(begun.row.conversationId)!;
      const now = execution.deadlineAt + 1;
      this.expiredEntry = { now, executionDeadline: execution.deadlineAt, invocationDeadline: begun.row.deadlineAt };
      // #runInvocation starts synchronously after begin returns. Deliver the
      // delayed execution cancellation after that entry check, like a timer
      // becoming runnable once native work gives the event loop control back.
      const lease = runtime.activeLease!;
      queueMicrotask(() => runtime.cancel(lease, 'CLOUD_EXECUTION_TIMEOUT'));
      const realNow = Date.now;
      Date.now = () => Math.max(realNow(), now);
      this.restoreClock = () => { Date.now = realNow; this.restoreClock = undefined; };
      return begun;
    };
  }

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
  /** Real pi DO SQLite storage: the commit persisting the assistant entry throws once armed. */
  async failPiStorage() {
    await this.sessionRuntime().ready();
    this.ctx.storage.sql.exec(`CREATE TRIGGER fixture_pi_storage_failure
      BEFORE INSERT ON pi_entries WHEN json_extract(NEW.record, '$.kind')='pi.assistant'
      BEGIN SELECT RAISE(ABORT, 'fixture pi storage unavailable'); END`);
  }
  healPiStorage() { this.ctx.storage.sql.exec('DROP TRIGGER fixture_pi_storage_failure'); }
  /** One platform alarm delivery; its fixed error code stands in for the platform's retry. */
  async deliverAlarm() {
    try { await this.alarm(); return { alarm: 'ok' }; }
    catch (error) { return { alarm: error instanceof CloudDoError ? error.code : 'raw' }; }
  }
  async discard() {
    try { await Promise.all(this.held.splice(0).map(reader => reader.cancel().catch(() => undefined))); }
    finally { this.restoreClock?.(); }
  }
  async repair() {
    this.ctx.storage.sql.exec('DROP TRIGGER fixture_settlement_failure');
    await this.alarm();
  }
  status() {
    const runtime = this.sessionRuntime();
    return { liveOwner: runtime.hasLiveOwner, busy: runtime.busy, closedResponses: this.closedResponses,
      expiredEntry: this.expiredEntry,
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
    case 'expireAtEntry': await agent.expireAtInvocationEntry(); return Response.json({ armed: true });
    case 'cancel': return agent.cancelActiveRun();
    case 'repair': await agent.repair(); return Response.json({ repaired: true });
    case 'discard': await agent.discard(); return Response.json({ discarded: true });
    case 'failPiStorage': await agent.failPiStorage(); return Response.json({ armed: true });
    case 'healPiStorage': await agent.healPiStorage(); return Response.json({ healed: true });
    case 'alarm': return Response.json(await agent.deliverAlarm());
    case 'submit': return agent.submit({ instruction: body.instruction });
    default: return new Response('Unknown fixture operation', { status: 400 });
  }
} };
