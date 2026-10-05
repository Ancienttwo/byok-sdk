import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { LiveDoc, type TaskId, type ConversationId } from '@earendil-works/pi-durable';
import { SessionAuditDO } from './session-runtime-worker';
import { cloudErrorResponse, CloudDoError } from '../src/errors';
import { sessionObjectName } from '../src/identity';
import type { InvocationRow } from '../src/invocation-ledger';
import type { CloudToolDefinition, CloudToolDispatcher, CloudToolResult } from '../src/tools';
import { openDurableObjectStorage } from '../src/storage';

interface Policy { pureTools?: string[]; domainErrors?: string[]; modelViews?: boolean; tools?: CloudToolDefinition[] }
const schema = { type: 'object' as const, properties: {}, additionalProperties: false };
const definitions: CloudToolDefinition[] = [
  { name: 'render_widget', description: 'Render a widget.', execution: 'pure', parameters: schema },
  { name: 'load_financial_analysis_skill', description: 'Load guidance.', execution: 'skill', parameters: schema },
  { name: 'get_financial_statements', description: 'Read statements.', execution: 'read_only_live', resolverRpc: 'statements', parameters: schema },
];
export class HooksDO extends SessionAuditDO {
  private result: CloudToolResult = { ok: true, data: { envelope: { kind: 'widget', values: [1, 2] } }, usage: { credits: 0 } };
  private paused = false;
  private pausedName?: string;
  private pauseGate?: Promise<void>;
  private release?: () => void;
  private policy?: Policy;
  protected override createDispatcher(id: string): CloudToolDispatcher | undefined {
    if (id !== 'fixture-documents') return undefined;
    const policy = this.policy ?? JSON.parse(String(this.env.POLICY)) as Policy;
    return { tools: policy.tools ?? definitions, pureTools: policy.pureTools ?? ['render_widget'],
      domainErrors: policy.domainErrors ?? ['WIDGET_INVALID', 'WIDGET_SOURCE_NOT_BINDABLE'], modelViews: policy.modelViews ?? true,
      execute: async (trusted, name, _args, _signal) => {
        this.ctx.storage.sql.exec('INSERT INTO fixture_dispatches(toolName,completed) VALUES (?,0)', name);
        if (this.paused && (!this.pausedName || this.pausedName === name)) await this.pauseGate;
        this.ctx.storage.sql.exec('UPDATE fixture_dispatches SET completed=1 WHERE toolName=?', name);
        if (name === 'render_widget' && trusted.lookup) {
          const rows = this.ctx.storage.sql.exec<InvocationRow & Record<string, SqlStorageValue>>('SELECT * FROM cloud_invocations ORDER BY seq DESC').toArray();
          const source = rows.find(row => row.toolName === 'get_financial_statements');
          if (source) {
            const found = trusted.lookup(source.invocationId);
            if (found && (found.settledAt === null || found.settledEventSeq === null)) return { ok: false, error: { code: 'WIDGET_SOURCE_NOT_BINDABLE' }, usage: { credits: 0 } };
            return { ...this.result, source: found };
          }
        }
        return this.result;
      } };
  }
  protected override projectInvocation(row: InvocationRow) {
    const result = row.resultJson ? JSON.parse(row.resultJson) : undefined;
    return { key: 'widget', dataJson: JSON.stringify({ state: row.state, errorCode: row.errorCode,
      data: result?.data ?? null, settledAt: row.settledAt, settledEventSeq: row.settledEventSeq }) };
  }
  control(input: { result?: CloudToolResult; pause?: boolean; pauseName?: string; policy?: Policy }) {
    if (input.result) this.result = input.result;
    if (input.policy) this.policy = input.policy;
    this.paused = input.pause ?? false;
    this.pausedName = input.pauseName;
    if (this.paused) this.pauseGate ??= new Promise(resolve => { this.release = resolve; });
    else { this.release?.(); this.pauseGate = undefined; this.release = undefined; }
    return { ok: true };
  }
  async trim(input: { now?: number; count?: boolean; legacySchema?: boolean; legacySession?: boolean }) {
    const runtime = this.sessionRuntime();
    const guard = await runtime.prepareGuard();
    try {
      if (input.count) for (let i = 0; i < 10_010; i++) runtime.cloud.appendEvent({ eventKey: `count:${i}`, type: 'fixture', data: {} }, guard);
      if (input.legacySchema) this.ctx.storage.sql.exec('ALTER TABLE cloud_invocations DROP COLUMN settledAt; ALTER TABLE cloud_invocations DROP COLUMN settledEventSeq');
      if (input.legacySession) this.ctx.storage.sql.exec('ALTER TABLE cloud_session DROP COLUMN dispatcherDigest');
      runtime.cloud.retention(input.now);
      return { ok: true };
    } finally { guard.dispose(); }
  }
  async terminalCase(input: { state: 'failed' | 'aborted' | 'timed_out' | 'interrupted'; recovery?: boolean; rollback?: boolean }) {
    const runtime = this.sessionRuntime();
    await runtime.ready();
    const seeded = await this.seed({ phase: 'execute', ledger: true, toolName: 'render_widget' }) as { invocationId: string };
    const guard = await runtime.prepareGuard();
    // finish normally runs under an active operation guard.
    const lease = runtime.reserve('zai_openai', guard);
    try {
      if (input.rollback) this.ctx.storage.sql.exec("CREATE TRIGGER reject_clock BEFORE UPDATE OF settledAt ON cloud_invocations BEGIN SELECT RAISE(ABORT,'clock rollback'); END");
      if (input.recovery) runtime.ledger.claimRecovery(input.state === 'timed_out' ? Date.now() + 300_000 : Date.now());
      else runtime.ledger.finish(seeded.invocationId, input.state, undefined, input.state === 'aborted' ? 'CLOUD_EXECUTION_ABORTED' : input.state === 'timed_out' ? 'CLOUD_TOOL_TIMEOUT' : 'CLOUD_TOOL_FAILED');
      return runtime.ledger.read(seeded.invocationId);
    } finally { await runtime.release(lease); guard.dispose(); }
  }
  async settledReplay(): Promise<unknown> {
    const runtime = this.sessionRuntime();
    const harness = await runtime.ready();
    const seeded = await this.seed({ phase: 'call', ledger: true, toolName: 'load_financial_analysis_skill' }) as { invocationId: string; conversationId: number; taskId: number };
    const guard = await runtime.prepareGuard();
    const lease = runtime.reserve('zai_openai', guard);
    runtime.attach(lease, seeded.conversationId);
    try {
      const row = runtime.ledger.finish(seeded.invocationId, 'succeeded', this.result)!;
      const native = await harness.getTask(seeded.taskId as TaskId<JsonValue>, context);
      if (!native) throw new CloudDoError('CLOUD_TOOL_FAILED');
      const storage = await openDurableObjectStorage(this.ctx.storage);
      await storage.commit([{ type: 'task', value: { ...native, state: { status: 'pending', checkpoint: { phase: 'call' } } } }], context);
      await storage.close(context);
      harness.resume();
      const conversation = await harness.conversation(seeded.conversationId as ConversationId, context);
      await conversation!.waitForIdle(context);
      return { row, live: await harness.snapshot(LiveDoc, seeded.conversationId as ConversationId, context), task: await harness.getTask(seeded.taskId as TaskId<JsonValue>, context) };
    } finally { await runtime.release(lease); guard.dispose(); }
  }
}
export default { async fetch(request: Request, env: { AGENTS: DurableObjectNamespace<HooksDO> }) {
  try {
    const body = await request.json() as Record<string, any>;
    const agent = env.AGENTS.getByName(await sessionObjectName({ tenantId: 't', workspaceId: 'w', agentId: 'a', sessionId: body.name }));
    switch (body.operation) {
      case 'setup': if (body.control) await agent.control(body.control); return await agent.setup(body.config);
      case 'control': return Response.json(await agent.control(body.control));
      case 'dump': return Response.json(await agent.dump());
      case 'submit': return await agent.submit({ instruction: 'Use the tools.' });
      case 'seed': return Response.json(await agent.seed(body.seed));
      case 'ready': return Response.json(await agent.recoveryReady());
      case 'read': return Response.json(await agent.readInvocation(body.id));
      case 'trim': return Response.json(await agent.trim(body.input));
      case 'terminal': return Response.json(await agent.terminalCase(body.input));
      case 'replay': return Response.json(await agent.settledReplay());
      default: throw new CloudDoError('CLOUD_REQUEST_INVALID');
    }
  } catch (error) { return cloudErrorResponse(error); }
} };
