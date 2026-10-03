import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry, watchEvents, type AgentEvent } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { AgentDO, CLOUD_HARNESS_SETTINGS } from '../src/agent-do';
import { CloudDoError, cloudErrorResponse } from '../src/errors';
import { PLATFORM_PROFILES } from '../src/platform-credentials';
import { createPlatformModels } from '../src/platform-provider';
import { openDurableObjectStorage } from '../src/storage';

export type Fault = 'missing' | 'empty' | 'malformed' | 'object' | 'number' | 'binding-throw' | 'get-undefined' | 'get-throw' | 'normal';
const RAW_CAUSE = 'raw-credential-reader-cause';
const THINKING = 'private-compaction-thinking-marker';

function faultEnvironment(env: Readonly<Record<string, unknown>>, fault: Fault) {
  let coerced = 0;
  const upstream = new Error(`${env.AIPHABEE_ZAI_API_KEY} ${RAW_CAUSE}`, { cause: new Error(RAW_CAUSE) });
  const values = { missing: undefined, empty: '', malformed: 'invalid\r\nheader', number: 123,
    object: { toString() { coerced++; throw upstream; } } };
  const modified = { ...env };
  Object.defineProperty(modified, 'AIPHABEE_ZAI_API_KEY', { get() {
    if (fault === 'binding-throw') throw upstream;
    return fault in values ? values[fault as keyof typeof values] : env.AIPHABEE_ZAI_API_KEY;
  } });
  return { env: modified, upstream, coercions: () => coerced };
}

function modelsForFault(broken: ReturnType<typeof faultEnvironment>, fault: Fault) {
  // The only injected port is the read-only SecretStore.get failure from the brief.
  if (fault === 'get-undefined') return createPlatformModels(broken.env, { get: async () => undefined });
  if (fault === 'get-throw') return createPlatformModels(broken.env, { get: async () => { throw broken.upstream; } });
  return createPlatformModels(broken.env);
}

function authResolver(models: ReturnType<typeof createPlatformModels>) {
  const resolver = models.getProvider('zai_openai')!.auth.apiKey!;
  return () => resolver.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal });
}

/** Keep the complete native schema in the audit. Include task and submission records. */
function dump(storage: DurableObjectStorage) {
  const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();
  return Object.fromEntries(tables.map(({ name }) => [name,
    storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray().map(row => Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, value instanceof ArrayBuffer
        ? { bytes: Array.from(new Uint8Array(value)), utf8: new TextDecoder().decode(value) } : value]),
    )),
  ]));
}

/** This subclass only gives the real AgentDO bad binding values. */
export class PreflightAgentDO extends AgentDO {
  #coercions: () => number;
  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    const fault = faultEnvironment(env, env.FAULT as Fault);
    super(state, fault.env);
    this.#coercions = fault.coercions;
  }
  audit() { return { tables: dump(this.ctx.storage), coercions: this.#coercions() }; }
}

/** All tasks, auth, persistence, and watch events below use native pi in workerd. */
export class AuthHarnessDO extends DurableObject<Record<string, unknown>> {
  async resolve(fault: Fault): Promise<Response> {
    const broken = faultEnvironment(this.env, fault);
    const resolve = authResolver(modelsForFault(broken, fault));
    try { await resolve(); return Response.json({ ok: true }); }
    catch (error) { return cloudErrorResponse(error); }
  }

  async run(fault: Fault, flow: 'auth' | 'threshold' | 'overflow' | 'multi-turn'): Promise<Record<string, unknown>> {
    const broken = faultEnvironment(this.env, fault);
    const models = modelsForFault(broken, fault);
    const resolverFailures = [];
    let previous: unknown;
    if (flow === 'auth') for (let attempt = 0; attempt < 2; attempt++) {
      try { await authResolver(models)(); }
      catch (error) {
        resolverFailures.push({ cloudError: error instanceof CloudDoError,
          message: error instanceof Error ? error.message : undefined,
          causeAbsent: error instanceof Error && error.cause === undefined,
          fresh: error !== previous && error !== broken.upstream,
          code: error instanceof CloudDoError ? error.code : undefined,
          status: error instanceof CloudDoError ? error.status : undefined,
          retryable: error instanceof CloudDoError ? error.retryable : undefined });
        previous = error;
      }
    }
    const harness = await Harness.open(await openDurableObjectStorage(this.ctx.storage), {
      models, registry: createRegistry(),
      settings: CLOUD_HARNESS_SETTINGS,
    }, ctx);
    const events: AgentEvent[] = [];
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
      agent: { model: { provider: 'zai_openai', modelId: PLATFORM_PROFILES.zai_openai.model }, tools: [] } }, ctx);
    let estimatedTokens = 0;
    if (flow === 'threshold' || flow === 'overflow') {
      const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: THINKING }],
        provider: 'zai_openai', model: PLATFORM_PROFILES.zai_openai.model, api: 'openai-completions', timestamp: 2,
        stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      await conversation.commit(async tx => {
        await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: 'early-context '.repeat(20_000), timestamp: 1 }] });
        await tx.appendEntry(conversation.id, { kind: 'pi.assistant', model: [assistant] });
        await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: 'recent-context '.repeat(8_000), timestamp: 3 }] });
      }, ctx);
      estimatedTokens = (await conversation.context(ctx)).messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
    }
    const watcher = await watchEvents(harness, conversation.id, ctx);
    const terminalCount = flow === 'multi-turn' ? 2 : 1;
    const delivered = new Set<number>();
    let finishDelivery!: () => void;
    const finalDelivery = new Promise<void>(resolve => { finishDelivery = resolve; });
    watcher.start(async batch => {
      events.push(...batch);
      for (const event of batch) if (event.type === 'submission' && ['done', 'unanswered'].includes(event.record.status)) {
        delivered.add(event.record.id);
        if (delivered.size === terminalCount) finishDelivery();
      }
    });
    const first = await conversation.submit({ type: 'input', content: 'Write a safe paragraph.', whenBusy: 'reject' }, ctx);
    const settled = [await first.wait(ctx)];
    await conversation.waitForIdle(ctx);
    if (flow === 'multi-turn') {
      const second = await conversation.submit({ type: 'input', content: 'Write the next safe paragraph.', whenBusy: 'reject' }, ctx);
      settled.push(await second.wait(ctx));
      await conversation.waitForIdle(ctx);
    }
    await finalDelivery;
    await watcher.stop();
    const result = { settled, events, estimatedTokens, resolverFailures, settings: CLOUD_HARNESS_SETTINGS,
      coercions: broken.coercions(), tables: dump(this.ctx.storage) };
    await harness.close(ctx);
    return result;
  }
}

interface Env {
  PREFLIGHT: DurableObjectNamespace<PreflightAgentDO>;
  HARNESSES: DurableObjectNamespace<AuthHarnessDO>;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const input = await request.json() as { operation: 'preflight' | 'dump-preflight' | 'resolve' | 'run'; name: string; fault: Fault; flow: 'auth' | 'threshold' | 'overflow' | 'multi-turn' };
      if (input.operation === 'preflight') return await env.PREFLIGHT.getByName(input.name).submit({ instruction: 'Write a safe paragraph.' });
      if (input.operation === 'dump-preflight') return Response.json(await env.PREFLIGHT.getByName(input.name).audit());
      const harness = env.HARNESSES.getByName(input.name);
      if (input.operation === 'resolve') return await harness.resolve(input.fault);
      return Response.json(await harness.run(input.fault, input.flow));
    } catch (error) { return cloudErrorResponse(error); }
  },
};
