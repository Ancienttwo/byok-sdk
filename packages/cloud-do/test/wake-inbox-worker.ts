import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, GenerationTask, defineTask, hook, type Registry, type ConversationId } from '@earendil-works/pi-durable';
import { AgentDO } from '../src/agent-do';
import { CloudDoError, cloudErrorResponse } from '../src/errors';
import type { InvocationRow, InvocationTerminalState } from '../src/invocation-ledger';
import type { InboxRow } from '../src/cloud-state';
import type { CloudToolDispatcher, CloudDispatchContext } from '../src/tools';

declare const __FINANCIAL_ANALYSIS_SKILL__: string;
const KEY = 'Primary~0123456789ABCDEFGHIJKLMNOP';
interface Controls { nativePause?: 'request' | 'receipt' | 'recovery'; pauseAlarm?: boolean; holdNativeOutcome?: boolean; pauseTool?: boolean; pauseAdmission?: boolean; deny?: boolean; failCredentials?: boolean; throwDoorbell?: boolean; projection?: 'valid' | 'throw' | 'json' | 'large' | 'key' | 'unicode' | 'marker'; largeSchema?: boolean }
let nativePause: Controls['nativePause'];
let nativeGate: Promise<void> | undefined;
let releaseNative: (() => void) | undefined;
let holdNativeOutcome = false;
const CompletionChild = defineTask<Record<string, never>, { phase: 'hold' }, null>({
  name: 'fixture.completion-child', version: 1, initial: () => ({ phase: 'hold' }),
  phases: { hold: async (_task, api) => {
    await new Promise<void>((_resolve, reject) => {
      const stopped = () => reject(new Error('fixture child cancelled'));
      api.signal.addEventListener('abort', stopped, { once: true });
      if (api.signal.aborted) stopped();
    });
  } },
  abort: async (_task, api, context) => {
    if (holdNativeOutcome) await nativeGate;
    await api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});
const nativeOpen = Harness.open.bind(Harness);
// Timing instrumentation forwards the same storage, registry, native hook runner and scheduler.
// The real native hook pauses only after the committed request checkpoint and before provider send.
Harness.open = async (storage, options, context) => {
  const observedConversations = new Set<number>();
  let opened: Harness;
  (options.registry as unknown as Registry).install({ name: 'wake-native-completion-observer', tasks: [CompletionChild], hooks: [
    hook(GenerationTask, { afterResponse: async (_message, api, hookContext) => {
      if (!holdNativeOutcome) return;
      const conversation = await opened.conversation(api.conversationId, hookContext);
      if (conversation) await conversation.commit(tx => tx.createTask(CompletionChild, {}, {
        ownership: { kind: 'task', taskId: api.taskId },
      }), hookContext);
    } }),
  ] });
  if (nativePause === 'request') (options.registry as unknown as Registry).install({ name: 'wake-native-checkpoint-observer', hooks: [
    hook(GenerationTask, { beforeRequest: async (_request, api) => { if (nativePause === 'request' && observedConversations.has(api.conversationId)) await nativeGate; } }),
  ] });
  const harness = await nativeOpen(storage, options, context);
  opened = harness;
  const wrap = (conversation: Awaited<ReturnType<typeof harness.createConversation>>) => {
    const submit = conversation.submit.bind(conversation);
    conversation.submit = async (input, callContext) => {
      const handle = await submit(input, callContext);
      // Native admission and scheduling have happened. Return the unchanged native handle after observation.
      if (nativePause === 'receipt') await nativeGate;
      return handle;
    };
    const abort = conversation.abort.bind(conversation);
    conversation.abort = async (callContext, abortOptions) => {
      const outcome = await abort(callContext, abortOptions);
      // Native abort has settled. Recovery still has its original eligibility and has not adjudicated.
      if (nativePause === 'recovery') await nativeGate;
      return outcome;
    };
    return conversation;
  };
  const create = harness.createConversation.bind(harness);
  harness.createConversation = async (input, callContext) => { const conversation = await create(input, callContext); observedConversations.add(conversation.id); return wrap(conversation); };
  const get = harness.conversation.bind(harness);
  harness.conversation = async (id, callContext) => { const conversation = await get(id, callContext); return conversation ? wrap(conversation) : undefined; };
  return harness;
};

/** Only consumer endpoints and provider responses are controlled. Host state and pi execute normally. */
export class WakeAuditDO extends AgentDO {
  private controls: Controls = {};
  private toolGate?: Promise<void>;
  private releaseTool?: () => void;
  private admissionGate?: Promise<void>;
  private releaseAdmission?: () => void;
  private bells: { id: string; state: InvocationTerminalState }[] = [];
  private alarmGate?: Promise<void>;
  private releaseAlarm?: () => void;
  private pausedEventReader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    // Arm the observer before a restored platform alarm can initialize this instance.
    if (env.NATIVE_OBSERVER_PAUSE === 'alarm') this.setControls({ pauseAlarm: true });
    if (env.NATIVE_OBSERVER_PAUSE === 'recovery' || env.NATIVE_OBSERVER_PAUSE === 'request') this.setControls({ nativePause: env.NATIVE_OBSERVER_PAUSE });
  }

  protected override createDispatcher(id: string): CloudToolDispatcher | undefined {
    if (id !== 'wake-documents') return undefined;
    return { tools: [{ name: 'load_financial_analysis_skill', description: 'Read the bundled financial analysis document.',
      parameters: { type: 'object', properties: {}, additionalProperties: false, ...(this.controls.largeSchema ? { description: 'Document schema '.repeat(4_000) } : {}) }, execution: 'skill' }],
      execute: async (trusted, name, _args, signal) => {
        this.ctx.storage.sql.exec('INSERT INTO fixture_dispatches(contextJson,aborted,completed) VALUES (?,0,0)', JSON.stringify({
          identity: trusted.identity, principal: trusted.principal, scopes: trusted.scopes, call: trusted.call,
          frozen: [trusted, trusted.identity, trusted.principal, trusted.scopes, trusted.call].map(Object.isFrozen),
          lookup: trusted.call ? trusted.lookup!(trusted.call.invocationId) : undefined,
        }));
        const seq = this.ctx.storage.sql.exec<{ seq: number }>('SELECT last_insert_rowid() AS seq').one().seq;
        if (this.controls.pauseTool) await this.toolGate;
        this.ctx.storage.sql.exec('UPDATE fixture_dispatches SET aborted=?,completed=1 WHERE seq=?', signal.aborted ? 1 : 0, seq);
        if (name !== 'load_financial_analysis_skill') throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
        const instructions = this.ctx.storage.sql.exec<{ body: string }>('SELECT body FROM fixture_documents WHERE id=1').one().body;
        return { ok: true, data: { instructions }, usage: { credits: 0, rows: 1, cached: false } };
      } };
  }

  protected override onInvocationSettled(id: string, state: InvocationTerminalState): void {
    this.bells.push({ id, state });
    if (this.controls.throwDoorbell) throw new Error('consumer-doorbell-failure');
  }

  protected override projectInvocation(row: InvocationRow): { key: string; dataJson: string } | undefined {
    switch (this.controls.projection) {
      case 'valid': return { key: 'document', dataJson: JSON.stringify({ state: row.state, invocationId: row.invocationId }) };
      case 'throw': throw new Error('consumer-projection-failure');
      case 'json': return { key: 'document', dataJson: '{' };
      case 'large': return { key: 'document', dataJson: JSON.stringify({ text: 'x'.repeat(16_384) }) };
      case 'key': return { key: KEY, dataJson: '{}' };
      case 'unicode': return { key: 'document', dataJson: `{"text":"${Array.from(KEY, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"}` };
      case 'marker': return { key: `sdk:${row.invocationId}:projection-failed`, dataJson: '{}' };
      default: return undefined;
    }
  }

  protected override async admitWake(items: readonly InboxRow[], signal: AbortSignal, key: string) {
    const response = await fetch('https://billing.fixture/reserve', { method: 'POST', body: JSON.stringify({ key, count: items.length, deny: this.controls.deny === true }) });
    const receipt = await response.json() as { allowed: boolean };
    this.ctx.storage.sql.exec('INSERT INTO fixture_admissions(admissionKey,aborted) VALUES (?,0)', key ?? 'missing-key');
    if (this.controls.pauseAdmission) await this.admissionGate;
    this.ctx.storage.sql.exec('UPDATE fixture_admissions SET aborted=? WHERE admissionKey=?', signal.aborted ? 1 : 0, key ?? 'missing-key');
    return receipt.allowed && !this.controls.deny ? { accepted: true as const, reservation: 'held' as const } : { accepted: false as const, code: 'CLOUD_TOOL_NOT_AVAILABLE' as const };
  }

  async setup(config: CloudDispatchContext, controls: Controls = {}) {
    this.setControls(controls);
    const configured = await this.configureSession(config);
    if (!configured.ok) return configured;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS fixture_documents(id INTEGER PRIMARY KEY,body TEXT);
      CREATE TABLE IF NOT EXISTS fixture_dispatches(seq INTEGER PRIMARY KEY AUTOINCREMENT,contextJson TEXT,aborted INTEGER,completed INTEGER);
      CREATE TABLE IF NOT EXISTS fixture_admissions(seq INTEGER PRIMARY KEY AUTOINCREMENT,admissionKey TEXT,aborted INTEGER);
      CREATE TABLE IF NOT EXISTS fixture_alarms(seq INTEGER PRIMARY KEY AUTOINCREMENT,retryCount INTEGER,at INTEGER);`);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO fixture_documents VALUES (1,?)', __FINANCIAL_ANALYSIS_SKILL__);
    await this.sessionRuntime().ready();
    return Response.json({ ok: true });
  }
  setControls(controls: Controls) {
    this.controls = controls;
    this.env.AIPHABEE_ZAI_API_KEY = controls.failCredentials ? '' : KEY;
    nativePause = controls.nativePause;
    holdNativeOutcome = controls.holdNativeOutcome === true;
    if (controls.pauseAlarm) this.alarmGate ??= new Promise(resolve => { this.releaseAlarm = resolve; });
    if (nativePause || holdNativeOutcome) nativeGate ??= new Promise(resolve => { releaseNative = resolve; });
    if (controls.pauseTool) this.toolGate ??= new Promise(resolve => { this.releaseTool = resolve; });
    if (controls.pauseAdmission) this.admissionGate ??= new Promise(resolve => { this.releaseAdmission = resolve; });
    return { ok: true };
  }
  releasePauses() {
    this.controls.pauseTool = false; this.controls.pauseAdmission = false;
    this.releaseTool?.(); this.releaseAdmission?.(); this.releaseAlarm?.(); this.controls.pauseAlarm = false; holdNativeOutcome = false; releaseNative?.(); nativePause = undefined; nativeGate = undefined;
    this.toolGate = undefined; this.admissionGate = undefined; this.alarmGate = undefined; this.releaseAlarm = undefined;
    return { ok: true };
  }
  async alarm(info?: AlarmInvocationInfo) {
    // Observe the real platform handler arguments without changing retries or scheduling.
    this.ctx.storage.sql.exec('INSERT INTO fixture_alarms(retryCount,at) VALUES (?,?)', info?.retryCount ?? 0, Date.now());
    if (this.controls.pauseAlarm) await this.alarmGate;
    await super.alarm(info);
  }
  async status() { return { alarm: await this.ctx.storage.getAlarm(), bells: this.bells, recovering: this.sessionRuntime().recovering }; }
  async readyAudit() { await this.sessionRuntime().ready(); return this.status(); }
  async openRecoveryAudit() { await this.sessionRuntime().open(); return this.status(); }
  async pauseEvents(after: number): Promise<Response> {
    const response = await this.events({ after });
    if (!response.ok) return response;
    // Keep the real native IdentityTransformStream reader in this instance. No network buffer drains it.
    this.pausedEventReader = response.body!.getReader();
    const first = await this.pausedEventReader.read();
    return Response.json({ first: new TextDecoder().decode(first.value), done: first.done });
  }
  async drainPausedEvents(): Promise<{ text: string }> {
    if (!this.pausedEventReader) throw new Error('Missing paused native reader');
    const decoder = new TextDecoder(); let text = '';
    for (;;) { const next = await this.pausedEventReader.read(); if (next.done) break; text += decoder.decode(next.value); }
    this.pausedEventReader = undefined;
    return { text };
  }
  async nativeContext(id: number): Promise<unknown> {
    const harness = await this.sessionRuntime().ready();
    const conversation = await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    return conversation ? conversation.context(BACKGROUND_CONTEXT) : undefined;
  }
  sql(query: string, params: (string | number | null)[] = []) { return this.ctx.storage.sql.exec(query, ...params).toArray(); }
  async dump() {
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
    // workerd forbids SQL access to this engine table. The native alarm API reads its timestamp.
    const rows = Object.fromEntries(tables.filter(({ name }) => name !== '_cf_METADATA').map(({ name }) => [name, this.ctx.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray().map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value instanceof ArrayBuffer ? { utf8: new TextDecoder().decode(value) } : value])))]));
    if (tables.some(({ name }) => name === '_cf_METADATA')) rows._cf_ALARM_READBACK = [{ timestamp: await this.ctx.storage.getAlarm() }];
    return rows;
  }
}
interface Env { AGENTS: DurableObjectNamespace<WakeAuditDO> }
export default { async fetch(request: Request, env: Env) {
  const input = await request.json() as { name: string; operation: string; [key: string]: unknown };
  const stub = env.AGENTS.get(env.AGENTS.idFromName(input.name));
  try {
    switch (input.operation) {
      case 'billing-cancel': return fetch('https://billing.fixture/cancel', { method: 'POST', body: JSON.stringify({ key: input.key }) });
      case 'setup': return stub.setup(input.config as CloudDispatchContext, input.controls as Controls);
      case 'controls': return Response.json(await stub.setControls(input.controls as Controls));
      case 'release': return Response.json(await stub.releasePauses());
      case 'enqueue': return stub.enqueue(input.item);
      case 'submit': return stub.submit(input.input);
      case 'events': return stub.events(input.cursor as { after?: number });
      case 'snapshot': return Response.json(await stub.readSnapshot());
      case 'runs': return Response.json(await stub.readRuns(input.page as { after?: number }));
      case 'inbox': return Response.json(await stub.readInbox(input.page as { after?: number }));
      case 'invocations': return Response.json(await stub.readInvocations(input.page as { after?: number }));
      case 'output': return Response.json(await stub.readRunOutput(Number(input.id), input.page as { entryId?: number; offset?: number }));
      case 'cancel-run': return stub.cancelActiveRun();
      case 'cancel-item': return stub.cancelInboxItem(Number(input.seq));
      case 'status': return Response.json(await stub.status());
      case 'ready': return Response.json(await stub.readyAudit());
      case 'open-recovery': return Response.json(await stub.openRecoveryAudit());
      case 'pause-events': return stub.pauseEvents(Number(input.after));
      case 'drain-events': return Response.json(await stub.drainPausedEvents());
      case 'context': return Response.json(await stub.nativeContext(Number(input.id)));
      case 'sql': return Response.json(await stub.sql(String(input.query), input.params as (string | number | null)[]));
      case 'dump': return Response.json(await stub.dump());
      default: return new Response(null, { status: 404 });
    }
  } catch (error) { return cloudErrorResponse(error); }
} };
