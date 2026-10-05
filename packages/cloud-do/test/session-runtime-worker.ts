import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, GenerationTask, ToolTask, LiveDoc, UserEntry, AssistantEntry, SystemEntry, hook,
  type Registry, type JsonObject, type ConversationId } from '@earendil-works/pi-durable';
import { AgentDO } from '../src/agent-do';
import { agentObjectName, sessionObjectName, getSessionObject, type SessionIdentity } from '../src/identity';
import type { InvocationTerminalState } from '../src/invocation-ledger';
import { CloudDoError, cloudErrorResponse, type CloudDoErrorCode } from '../src/errors';
import { PLATFORM_PROFILES } from '../src/platform-credentials';
import { openDurableObjectStorage } from '../src/storage';
import { argsDigest, canonicalArgs, invocationId, replayForTool, type CloudToolDispatcher, type CloudToolDefinition, type CloudDispatchContext } from '../src/tools';
declare const __FINANCIAL_ANALYSIS_SKILL__: string;
const instructions = __FINANCIAL_ANALYSIS_SKILL__;

const KEY = 'Primary~0123456789ABCDEFGHIJKLMNOP';
const HOSTILE_TOKEN = 'ghp_ReviewOpaque1234567890abcdefABCDEF';
const SQL_ERROR_MARKER = 'sql-error-args-marker';
const descriptions = [
  ['load_financial_analysis_skill', 'Load the bundled financial analysis guidance and current tool catalog.'],
  ['search_f10_datasets', 'Search the read-only bundled document catalog.'],
  ['query_f10_dataset', 'Read document rows from the selected fixture dataset.'],
  ['get_ipo_profile', 'Read the recorded Aiphabee golden IPO response.'],
] as const;
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const tools: readonly CloudToolDefinition[] = [
  { name: descriptions[0][0], description: descriptions[0][1], parameters: schema({}), execution: 'skill' },
  { name: descriptions[1][0], description: descriptions[1][1], parameters: schema({ query: { type: 'string' } }, ['query']), execution: 'read_only_live', resolverRpc: 'searchFixtureCatalog' },
  { name: descriptions[2][0], description: descriptions[2][1], parameters: schema({ dataset_ref: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, ['dataset_ref', 'limit']), execution: 'read_only_live', resolverRpc: 'readFixtureDocuments' },
  { name: descriptions[3][0], description: descriptions[3][1], parameters: schema({ ipo_id: { type: 'string' } }, ['ipo_id']), execution: 'read_only_live', resolverRpc: 'readGoldenIpoProfile' },
];

interface FixtureControls { pause?: boolean; pauseName?: string; missingUsage?: boolean; leakedField?: 'metadata' | 'progress'; readiness?: boolean; leakedToolMetadata?: 'description' | 'schema'; upstreamFault?: 'error-envelope' | 'throw' | 'malformed-cloud-code' | 'missing-ok-error' | 'success-error' }
interface AbortRace { mode: 'abort' | 'idle'; release(): void; barrier: Promise<void>; resumed: number; beforeRequestSignals: boolean[]; toolSignals: boolean[] }
let race: AbortRace | undefined;
const nativeOpen = Harness.open.bind(Harness);
// Timing interposition only. The real Harness, storage, scheduler, phases and hook runner execute unchanged.
Harness.open = async (storage, options, ctx) => {
  const audit: { beforeRequestSignals: boolean[]; toolSignals: boolean[] } = race ?? { beforeRequestSignals: [], toolSignals: [] };
  const registry = options.registry as unknown as Registry;
  const installed = [...registry.snapshot().installed()];
  for (const extension of installed) registry.uninstall(extension);
  registry.install({ name: 'fixture-native-observer', hooks: [
    hook(GenerationTask, { beforeRequest(_request, _api, callContext) { audit.beforeRequestSignals.push(callContext.abortSignal?.aborted ?? false); } }),
    hook(ToolTask, { beforeTool(_call, _api, callContext) { audit.toolSignals.push(callContext.abortSignal?.aborted ?? false); } }),
  ] });
  for (const extension of installed) registry.install(extension);
  const harness = await nativeOpen(storage, options, ctx);
  if (race) {
    const control = race;
    const nativeConversation = harness.conversation.bind(harness);
    harness.conversation = async (id, callContext) => {
      const conversation = await nativeConversation(id, callContext);
      if (conversation) {
        if (control.mode === 'abort') {
          const nativeAbort = conversation.abort.bind(conversation);
          conversation.abort = async (abortContext, abortOptions) => {
            harness.resume();
            control.resumed++;
            await control.barrier;
            return nativeAbort(abortContext, abortOptions);
          };
        } else {
          const nativeIdle = conversation.waitForIdle.bind(conversation);
          conversation.waitForIdle = async idleContext => {
            control.resumed++;
            await control.barrier;
            return nativeIdle(idleContext);
          };
        }
      }
      return conversation;
    };
  }
  return harness;
};

/** This executable dispatcher reads actual SQLite document/catalog fixtures. It never returns a stub tool value. */
export class SessionAuditDO extends AgentDO {
  private controls: FixtureControls = {};
  private releaseRead?: () => void;
  private readGate?: Promise<void>;
  private observedSignals: AbortSignal[] = [];
  private settledInvocations: { id: string; state: InvocationTerminalState }[] = [];

  protected override onInvocationSettled(id: string, state: InvocationTerminalState): void {
    this.settledInvocations.push({ id, state });
  }

  protected override createDispatcher(id: string): CloudToolDispatcher | undefined {
    if (id !== 'fixture-documents') return undefined;
    const definitions = tools.map(tool => this.controls.leakedToolMetadata === 'description'
      ? { ...tool, description: KEY }
      : this.controls.leakedToolMetadata === 'schema' ? { ...tool, parameters: { ...tool.parameters, description: KEY } } : tool);
    return { tools: definitions, execute: async (trusted, name, args, signal) => {
      if (trusted.principal.accountId !== 'fixture-account' || trusted.principal.workspaceId !== trusted.identity.workspaceId
        || !trusted.scopes.includes('read:fixture') || this.controls.readiness === false) throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
      this.observedSignals.push(signal);
      this.ctx.storage.sql.exec('INSERT INTO fixture_dispatches(toolName,completed) VALUES (?,0)', name);
      const seq = this.ctx.storage.sql.exec<{ seq: number }>('SELECT last_insert_rowid() AS seq').one().seq;
      // A controlled read barrier proves cancellation even when a resolver does not cooperate with its signal.
      if (this.controls.pause || this.controls.pauseName === name) await this.readGate;
      if (this.controls.upstreamFault === 'malformed-cloud-code') throw new CloudDoError(HOSTILE_TOKEN as CloudDoErrorCode);
      if (this.controls.upstreamFault === 'throw') throw new Error(`raw-dispatcher-rejection-${HOSTILE_TOKEN}`, { cause: new Error(`raw-dispatcher-cause-${HOSTILE_TOKEN}`) });
      let result: Record<string, unknown>;
      if (name === 'load_financial_analysis_skill') {
        const document = this.ctx.storage.sql.exec<{ body: string }>('SELECT body FROM fixture_documents WHERE seq=1').one().body;
        const catalog = this.ctx.storage.sql.exec<{ name: string; description: string }>('SELECT name,description FROM fixture_catalog ORDER BY seq').toArray();
        const revision = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ instructions: document, tool_catalog: catalog })))), byte => byte.toString(16).padStart(2, '0')).join('');
        result = { ok: true, data: { instructions: document, tool_catalog: catalog, revision }, usage: { credits: 0, rows: 0, cached: false } };
      } else if (name === 'search_f10_datasets') {
        const rows = this.ctx.storage.sql.exec('SELECT name,description FROM fixture_catalog WHERE name LIKE ? OR description LIKE ? ORDER BY seq', `%${args.query}%`, `%${args.query}%`).toArray();
        result = { ok: true, data: { rows }, usage: { credits: 0, rows: rows.length, cached: false } };
      } else if (name === 'query_f10_dataset') {
        const rows = this.ctx.storage.sql.exec('SELECT seq,name,body FROM fixture_documents WHERE dataset=? ORDER BY seq LIMIT ?', String(args.dataset_ref), Number(args.limit)).toArray();
        result = { ok: true, data: { rows }, usage: { credits: 0, rows: rows.length, cached: false } };
      } else if (name === 'get_ipo_profile') {
        const row = this.ctx.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM fixture_ipo WHERE ipoId=?', String(args.ipo_id)).toArray()[0];
        if (!row) throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
        result = JSON.parse(row.envelope) as Record<string, unknown>;
      } else throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
      if (this.controls.upstreamFault === 'error-envelope') result = { ok: false, error: { code: 'UPSTREAM_ERROR', message: `raw-upstream-error-${HOSTILE_TOKEN}` }, usage: { credits: 0 } };
      if (this.controls.upstreamFault === 'missing-ok-error') { delete result.ok; result.error = { code: 'UPSTREAM_ERROR', message: `raw-missing-ok-${HOSTILE_TOKEN}` }; }
      if (this.controls.upstreamFault === 'success-error') result.error = { code: 'UPSTREAM_ERROR', message: `raw-success-error-${HOSTILE_TOKEN}` };
      if (this.controls.missingUsage) delete result.usage;
      if (this.controls.leakedField) result[this.controls.leakedField] = { note: KEY };
      this.ctx.storage.sql.exec('UPDATE fixture_dispatches SET completed=1 WHERE seq=?', seq);
      return result;
    } };
  }

  async setup(config: CloudDispatchContext & { limits?: Record<string, number> }, controls: FixtureControls = {}) {
    this.setControls(controls);
    const result = await this.configureSession(config);
    if (!result.ok) return result;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS fixture_documents(seq INTEGER PRIMARY KEY,name TEXT,dataset TEXT,body TEXT);
      CREATE TABLE IF NOT EXISTS fixture_catalog(seq INTEGER PRIMARY KEY,name TEXT,description TEXT);
      CREATE TABLE IF NOT EXISTS fixture_ipo(ipoId TEXT PRIMARY KEY,envelope TEXT);
      CREATE TABLE IF NOT EXISTS fixture_dispatches(seq INTEGER PRIMARY KEY AUTOINCREMENT,toolName TEXT,completed INTEGER)`);
    if (!this.ctx.storage.sql.exec('SELECT seq FROM fixture_documents LIMIT 1').toArray().length) {
      // Eight independent read rows carry the actual source document. Multi-row reads exercise the 48,000-byte bound.
      for (let i = 1; i <= 8; i++) this.ctx.storage.sql.exec('INSERT INTO fixture_documents VALUES (?,?,?,?)', i, `financial-analysis-${i}`, 'financial-analysis', instructions);
      descriptions.forEach(([name, description], index) => this.ctx.storage.sql.exec('INSERT INTO fixture_catalog VALUES (?,?,?)', index + 1, name, description));
      // Exact expected_response from Aiphabee tests/golden/tools/fixtures/tool_get_ipo_profile_001.json.
      this.ctx.storage.sql.exec('INSERT INTO fixture_ipo VALUES (?,?)', 'honeycomb', JSON.stringify({ status: 404, as_of: '2026-06-24T00:00:00.000Z', data_version: 'ipo-no-released-data-version',
        error: { code: 'NOT_FOUND', message: 'No released IPO data_version is available.' }, market_status: 'not_applicable', methodology_version: '2026-06-24.phase1.ipo-pipeline-foundation.v0',
        ok: false, provenance: [], request_id: 'golden-get-ipo-profile', usage: { cached: false, credits: 0, rows: 0 } }));
    }
    return Response.json({ ok: true });
  }

  setControls(controls: FixtureControls) {
    this.controls = controls;
    if (controls.pause || controls.pauseName) this.readGate ??= new Promise<void>(resolve => { this.releaseRead = resolve; });
    return { ok: true };
  }
  releaseReads() { this.controls.pause = false; this.controls.pauseName = undefined; this.releaseRead?.(); this.releaseRead = undefined; this.readGate = undefined; return { ok: true }; }

  async dump(): Promise<Record<string, unknown[]>> {
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
    const audit = Object.fromEntries(tables.filter(({ name }) => name !== '_cf_METADATA').map(({ name }) => [name, this.ctx.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray().map(row => Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, value instanceof ArrayBuffer ? { utf8: new TextDecoder().decode(value) } : value]),
    ))]));
    return tables.some(({ name }) => name === '_cf_METADATA')
      ? { ...audit, _cf_ALARM_READBACK: [{ scheduledTime: await this.ctx.storage.getAlarm() }] } : audit;
  }

  async openRecovery(withRace: boolean | 'idle' = false): Promise<Record<string, unknown>> {
    if (withRace) {
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      race = { mode: withRace === 'idle' ? 'idle' : 'abort', barrier, release, resumed: 0, beforeRequestSignals: [], toolSignals: [] };
    }
    const started = Date.now();
    const harness = await this.sessionRuntime().open();
    return { elapsed: Date.now() - started, recovering: this.sessionRuntime().recovering, inspection: await harness.inspect(context) };
  }

  raceStatus() { return { resumed: race?.resumed ?? 0, beforeRequestSignals: race?.beforeRequestSignals ?? [], toolSignals: race?.toolSignals ?? [], recovering: this.sessionRuntime().recovering }; }
  releaseRace() { race?.release(); return { ok: true }; }
  async recoveryReady(): Promise<Record<string, unknown>> { const harness = await this.sessionRuntime().ready(); return { recovering: this.sessionRuntime().recovering, inspection: await harness.inspect(context), signals: this.observedSignals.map(signal => signal.aborted) }; }

  async seed(input: { phase: 'request' | 'call' | 'execute'; toolName?: string; ledger?: boolean; replayCount?: number; partial?: string }): Promise<Record<string, unknown>> {
    const runtime = this.sessionRuntime();
    const harness = await runtime.ready();
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'zai_openai', modelId: PLATFORM_PROFILES.zai_openai.model } } }, context);
    const name = input.toolName ?? 'load_financial_analysis_skill';
    const args = name === 'get_ipo_profile' ? { ipo_id: 'honeycomb' } : {};
    const callId = 'call_1';
    const seeded = await conversation.commit(async tx => {
      const user = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: 'user', content: 'Read financial guidance.', timestamp: Date.now() }] });
      await tx.appendEntry(SystemEntry, conversation.id, { model: [{ role: 'system', content: 'Use the available tools.', toolsAdded: tools.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: Date.now() }] });
      const assistant = input.phase === 'request' ? undefined : await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ role: 'assistant', api: 'openai-completions', provider: 'zai_openai', model: PLATFORM_PROFILES.zai_openai.model,
        content: [{ type: 'toolCall', id: callId, name, arguments: args as JsonObject }], stopReason: 'toolUse', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] });
      const taskId = input.phase === 'request'
        ? await tx.createTask(GenerationTask, {}, { ownership: { kind: 'conversation' } })
        : await tx.createTask(ToolTask, { assistant: assistant!.id, callId }, { ownership: { kind: 'conversation' } });
      const live = await tx.doc(LiveDoc, conversation.id);
      if (input.phase === 'request') {
        live.run = { taskId, inputs: [] };
        live.generation = { attempt: 1, ...(input.partial === undefined ? {} : { message: {
          role: 'assistant' as const, api: 'openai-completions', provider: 'zai_openai', model: PLATFORM_PROFILES.zai_openai.model,
          content: [{ type: 'text' as const, text: input.partial }], stopReason: 'stop' as const, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } }) };
      }
      else live.tools = [{ callId, name, taskId, status: 'running' }];
      return { taskId, userId: user.id, assistantEntryId: assistant?.id };
    }, context);
    const record = await harness.getTask(seeded.taskId, context);
    if (!record) throw new Error('Missing native seed task');
    const storage = await openDurableObjectStorage(this.ctx.storage);
    await storage.commit([{ type: 'task', value: { ...record, state: { status: 'running', checkpoint: input.phase === 'request'
      ? { phase: 'request', attempt: 1, model: { provider: 'zai_openai', modelId: PLATFORM_PROFILES.zai_openai.model }, thinkingLevel: 'off', streamOptions: { maxRetries: 0 }, cutoff: seeded.userId }
      : input.phase === 'execute' ? { phase: 'execute', arguments: args as JsonObject, replay: 'unsafe' } : { phase: 'call' } } } }], context);
    await storage.close(context);
    const deadlineAt = Date.now() + 240_000;
    runtime.ledger.startExecution(conversation.id, deadlineAt);
    let id: string | undefined;
    if (input.ledger && seeded.assistantEntryId) {
      id = await invocationId(conversation.id, seeded.assistantEntryId, callId);
      const guard = await runtime.prepareGuard();
      runtime.ledger.begin({ invocationId: id, sessionId: 'fixture-session', conversationId: conversation.id, assistantEntryId: seeded.assistantEntryId, toolCallId: callId,
        toolName: name, argsDigest: await argsDigest(name, args), argsJson: canonicalArgs(args), replay: replayForTool(name), deadlineAt }, guard);
      guard.dispose();
      if (input.replayCount) this.ctx.storage.sql.exec('UPDATE cloud_invocations SET replayCount=? WHERE invocationId=?', input.replayCount, id);
    }
    return { conversationId: conversation.id, taskId: seeded.taskId, invocationId: id, phase: input.phase };
  }

  async installSqlFailure(mode: 'begin' | 'finish' | 'fatal') {
    await this.sessionRuntime().ready();
    const message = `raw-rejection-${HOSTILE_TOKEN} argsJson=${SQL_ERROR_MARKER}`;
    const statement = mode === 'begin' ? 'BEFORE INSERT ON cloud_invocations'
      : mode === 'finish' ? 'BEFORE UPDATE ON cloud_invocations' : 'BEFORE UPDATE OF fatalCode ON cloud_executions';
    this.ctx.storage.sql.exec(`CREATE TRIGGER fixture_sql_failure ${statement} BEGIN SELECT RAISE(ABORT, '${message}'); END`);
    return { mode };
  }

  claimDuringRead() {
    return { claimed: this.sessionRuntime().ledger.claimRecovery(), settled: this.settledInvocations };
  }

  async liveAudit(conversationId: number): Promise<unknown> {
    const harness = await this.sessionRuntime().open();
    return await harness.snapshot(LiveDoc, conversationId as ConversationId, context);
  }

  settlementAudit() { return { settled: this.settledInvocations, signals: this.observedSignals.map(signal => signal.aborted) }; }

  corruptConfig(mode: 'unknown' | 'missing') {
    const row = this.ctx.storage.sql.exec<{ configJson: string }>('SELECT configJson FROM cloud_session WHERE id=1').one();
    const saved = JSON.parse(row.configJson) as Record<string, unknown>;
    if (mode === 'unknown') saved.dispatcherId = 'unknown-dispatcher';
    this.ctx.storage.sql.exec('UPDATE cloud_session SET configJson=? WHERE id=1', mode === 'missing' ? null : JSON.stringify(saved));
    return { mode };
  }

  async gate(code: CloudDoErrorCode): Promise<Record<string, unknown>> {
    const runtime = this.sessionRuntime();
    const harness = await runtime.ready();
    const lease = runtime.reserve('zai_openai', await runtime.prepareGuard('zai_openai'));
    try {
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'zai_openai', modelId: PLATFORM_PROFILES.zai_openai.model } } }, context);
      runtime.attach(lease, conversation.id);
      runtime.ledger.failExecution(conversation.id, code);
      const submission = await conversation.submit({ type: 'input', content: 'Read the guidance.', whenBusy: 'reject' }, context);
      const result = await submission.wait(context);
      await conversation.waitForIdle(context);
      const view = await conversation.context(context);
      return { result, entries: view.entries, liveSignal: !lease.controller.signal.aborted, inspection: await harness.inspect(context), dump: await this.dump() };
    } finally { await runtime.settle(lease, { state: 'failed', errorCode: code }); await runtime.release(lease); }
  }
}

interface Env { AGENTS: DurableObjectNamespace<SessionAuditDO> }
export default { async fetch(request: Request, env: Env) {
  try {
    const body = await request.json() as { name: string; operation: string; config: CloudDispatchContext; controls?: FixtureControls; input: unknown; seed: Parameters<SessionAuditDO['seed']>[0]; code: CloudDoErrorCode; race?: boolean | 'idle'; corruption: 'unknown' | 'missing'; identity: SessionIdentity; text?: string; sqlFailure: 'begin' | 'finish' | 'fatal'; conversationId: number };
    if (body.operation === 'identity-name') return Response.json({ agent: await agentObjectName(body.identity), session: await sessionObjectName(body.identity) });
    if (body.operation === 'identity-lookup') {
      let namespaceLookups = 0;
      // This is the consuming platform's authorization boundary, before SDK namespace access.
      if (body.identity.tenantId !== 'fixture-tenant') return Response.json({ error: 'FORBIDDEN', namespaceLookups }, { status: 403 });
      const namespace = new Proxy(env.AGENTS, { get(target, field) {
        if (field === 'getByName') return (name: string) => { namespaceLookups++; return target.getByName(name); };
        const value = Reflect.get(target, field);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const stub = await getSessionObject(namespace, body.identity);
      const name = await sessionObjectName(body.identity);
      const execution = await stub.openExecution();
      if (body.text !== undefined) await stub.appendExecution(execution.conversationId, body.text);
      return Response.json({ name, id: stub.id.toString(), byId: env.AGENTS.get(env.AGENTS.idFromName(name)).id.toString(), namespaceLookups,
        execution, entries: await stub.readExecution(execution.conversationId) });
    }
    const agent = env.AGENTS.getByName(body.name);
    switch (body.operation) {
      case 'setup': return agent.setup(body.config, body.controls);
      case 'submit': return agent.submit(body.input);
      case 'dump': return Response.json(await agent.dump());
      case 'controls': return Response.json(await agent.setControls(body.controls ?? {}));
      case 'release': return Response.json(await agent.releaseReads());
      case 'seed': return Response.json(await agent.seed(body.seed));
      case 'corrupt-config': return Response.json(await agent.corruptConfig(body.corruption));
      case 'sql-failure': return Response.json(await agent.installSqlFailure(body.sqlFailure));
      case 'claim-during-read': return Response.json(await agent.claimDuringRead());
      case 'settlement-audit': return Response.json(await agent.settlementAudit());
      case 'live-audit': return Response.json(await agent.liveAudit(body.conversationId));
      case 'open-recovery': return Response.json(await agent.openRecovery(body.race));
      case 'race-status': return Response.json(await agent.raceStatus());
      case 'release-race': return Response.json(await agent.releaseRace());
      case 'ready': return Response.json(await agent.recoveryReady());
      case 'gate': return Response.json(await agent.gate(body.code));
      default: throw new CloudDoError('CLOUD_REQUEST_INVALID');
    }
  } catch (error) { return cloudErrorResponse(error); }
} };
