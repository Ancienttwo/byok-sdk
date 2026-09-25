/**
 * Shared fixture for the official Pi 0.87.1 conformance suite.
 *
 * Public entrypoints only: the `@earendil-works/pi-coding-agent` root, the
 * `@earendil-works/pi-ai` root and the public `./api/*` export of pi-ai. Every
 * provider response is a synthetic SSE `Response` produced by an injected
 * fetch; the provider `baseUrl` is the non-routable sink `127.0.0.1:9`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {
  InMemoryCredentialStore,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';

export const PROVIDER = 'byok-opaque-test';
export const SINK_BASE_URL = 'http://127.0.0.1:9/v1';
export const SINK_HOST = '127.0.0.1:9';
export const SESSION_ID = 'byok-conformance-session';
export const OBSERVE_TOOL_NAME = 'byok_observe';
export const OBSERVE_TOOL_RESULT_TEXT = 'observed: fixed synthetic text';
export const THINKING_LEVEL = 'medium' as const;
export const TRIGGER_TEXT = 'trigger (replaced by context_with_system)';

const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export const COMPAT = Object.freeze({
  thinkingFormat: 'zai',
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
});

export const THINKING_LEVEL_MAP = Object.freeze({ minimal: null, low: 'low', medium: 'medium', high: 'high' });

export const MODEL_SPEC = Object.freeze({
  id: 'glm-conformance',
  name: 'glm-conformance',
  api: 'openai-completions' as const,
  reasoning: true,
  thinkingLevelMap: THINKING_LEVEL_MAP,
  input: ['text'] as ('text' | 'image')[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  compat: COMPAT,
});

/** The model the A1' compile uses: no session, sink baseUrl. */
export function compileModel(): Model<'openai-completions'> {
  return structuredClone({ ...MODEL_SPEC, provider: PROVIDER, baseUrl: SINK_BASE_URL }) as unknown as Model<'openai-completions'>;
}

export const OBSERVE_TOOL = {
  name: OBSERVE_TOOL_NAME,
  description: 'Observation-only tool declaration (prepared lane conformance).',
  parameters: Type.Object({ note: Type.String() }),
};

export interface Provenance {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
}

/** A2' request-scoped sentinel provenance: arbitrary, never a real model. */
export const SENTINEL_PROVENANCE: Provenance = Object.freeze({
  api: 'byok-host-canonical-api',
  provider: 'byok-host-canonical-provider',
  model: 'byok-host-canonical-model',
});

export const SAME_MODEL_PROVENANCE: Provenance = Object.freeze({
  api: MODEL_SPEC.api,
  provider: PROVIDER,
  model: MODEL_SPEC.id,
});

const T0 = 1_700_000_000_000;

/** A Host assistant entry with the given provenance, zero usage and `stopReason: "stop"`. */
export function hostAssistant(content: AssistantMessage['content'], provenance: Provenance, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: provenance.api,
    provider: provenance.provider,
    model: provenance.model,
    usage: structuredClone(ZERO_USAGE),
    stopReason: 'stop',
    timestamp,
  } as AssistantMessage;
}

/**
 * Host transcript T = [system (sections + toolsAdded), user, assistant (text only), user].
 * Built fresh on every call so no caller can mutate a shared copy.
 */
export function hostTranscript(provenance: Provenance = SENTINEL_PROVENANCE, lastUser = 'INPUT DOCUMENT: current request'): Message[] {
  return [
    {
      role: 'system',
      content: 'HOST FRAMING: you are the Host bot.',
      sections: { summary: '<summary>prior Host summary</summary>' },
      toolsAdded: [OBSERVE_TOOL],
      timestamp: T0,
    },
    { role: 'user', content: 'earlier user turn 你好\r\nline2', timestamp: T0 + 1 },
    hostAssistant([{ type: 'text', text: 'earlier Host-canonical assistant text' }], provenance, T0 + 2),
    { role: 'user', content: lastUser, timestamp: T0 + 3 },
  ] as Message[];
}

/** Compile options shared by A1' and the live gate (both pin `cacheRetention`). */
export const COMPILE_OPTIONS: SimpleStreamOptions = Object.freeze({
  reasoning: THINKING_LEVEL,
  sessionId: SESSION_ID,
  cacheRetention: 'none',
});

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

class CaptureOnlyStop extends Error {
  constructor() {
    super('A1 capture-only compile: never sent');
    this.name = 'CaptureOnlyStop';
  }
}

export interface CompileResult {
  readonly body: string | undefined;
  readonly url: string | undefined;
  readonly fetchCalls: number;
  readonly terminal: { readonly type: string; readonly stopReason?: string; readonly errorMessage?: string } | undefined;
}

async function drain(stream: AsyncIterable<{ type: string; error?: AssistantMessage; message?: AssistantMessage }>) {
  let terminal: CompileResult['terminal'];
  for await (const event of stream) {
    if (event.type === 'error' || event.type === 'done') {
      const message = event.type === 'error' ? event.error : event.message;
      terminal = { type: event.type, stopReason: message?.stopReason, errorMessage: message?.errorMessage };
    }
  }
  return terminal;
}

/**
 * A1': compile D through the official `streamSimple` with a capture-and-throw
 * fetch and `maxRetries: 0`. No session, no network, no credential.
 */
export async function compileA1(messages: Message[], options: SimpleStreamOptions = COMPILE_OPTIONS): Promise<CompileResult> {
  const captured: { url: string; body: string }[] = [];
  const captureThrowingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input instanceof Request ? input.url : input), body: String(init?.body) });
    throw new CaptureOnlyStop();
  };
  const stream = streamSimple(compileModel(), normalizeContext({ messages: structuredClone(messages) }), {
    ...options,
    apiKey: 'compile-placeholder',
    fetch: captureThrowingFetch as typeof fetch,
    maxRetries: 0,
  });
  const terminal = await drain(stream);
  return { body: captured[0]?.body, url: captured[0]?.url, fetchCalls: captured.length, terminal };
}

/** Compile WITHOUT an injected fetch: the upstream-ignores-fetch simulation. */
export async function compileWithoutInjectedFetch(messages: Message[]): Promise<CompileResult['terminal']> {
  const stream = streamSimple(compileModel(), normalizeContext({ messages: structuredClone(messages) }), {
    ...COMPILE_OPTIONS,
    apiKey: 'compile-placeholder',
    maxRetries: 0,
    timeoutMs: 3_000,
  });
  return drain(stream);
}

// ---------------------------------------------------------------- synthetic SSE

function sse(chunks: readonly object[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (id: string, choices: object[], extra: object = {}) =>
  ({ id, object: 'chat.completion.chunk', created: 1, model: MODEL_SPEC.id, choices, ...extra });

export function textResponse(text: string, usage: boolean): Response {
  return sse([
    chunk('synthetic-text', [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]),
    chunk('synthetic-text', [{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ...(usage ? [chunk('synthetic-text', [], { usage: { prompt_tokens: 111, completion_tokens: 7, total_tokens: 118 } })] : []),
  ]);
}

export function toolCallResponse(): Response {
  return sse([
    chunk('synthetic-tool', [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'call_conformance_1', type: 'function', function: { name: OBSERVE_TOOL_NAME, arguments: '{"note":"hi"}' } }],
      },
      finish_reason: null,
    }]),
    chunk('synthetic-tool', [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    chunk('synthetic-tool', [], { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }),
  ]);
}

// ---------------------------------------------------------------- global transport spy

export interface GlobalFetchSpy {
  readonly calls: string[];
  restore(): void;
}

/**
 * Replace `globalThis.fetch` for the duration of one test. Every call is
 * recorded. With `passThroughSink` a call to the sink host is forwarded to the
 * real fetch (the sink refuses the connection); every other call throws.
 */
export function installGlobalFetchSpy(passThroughSink = false): GlobalFetchSpy {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const spy = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (passThroughSink && new URL(url).host === SINK_HOST) return original(input, init);
    throw new Error(`conformance: unexpected global transport to ${url}`);
  };
  globalThis.fetch = Object.assign(spy, original) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------- official session harness

export type GateMode = (sequence: number, body: string) => Response | { refuse: RunScopedRefusal };

export interface RunScopedRefusal {
  readonly code: 'prepared_request_bytes_mismatch';
  readonly sequence: number;
  readonly expectedSha256: string;
  readonly observedSha256: string;
  readonly observedBytes: number;
}

export interface SessionHarness {
  readonly session: AgentSession;
  /** Bodies seen by the scoped gate fetch, in order. */
  readonly gateBodies: string[];
  /** Bodies that the gate let through (answered with synthetic SSE). */
  readonly sends: string[];
  /** Run-scoped state: the typed refusal the gate wrote before throwing. */
  readonly run: { refusal?: RunScopedRefusal };
  /** `message_end` messages the session emitted, in order. */
  readonly messageEnds: Message[];
  /** Tail (after the native system + trigger) each `context_with_system` call received. */
  readonly contextTails: Message[][];
  /** Anomalies observed by the context handler (native head not [system, trigger]). */
  readonly contextAnomalies: string[];
  /** Non-function options the session handed the provider `streamSimple`. */
  readonly providerOptions: Record<string, unknown>[];
  toolExecutions: number;
  dispose(): void;
}

/**
 * Build a full official `AgentSession`: in-memory session and settings with
 * both retry layers, compaction and cache warming off, a resource loader with
 * every discovery source off and an explicit system prompt, an extension whose
 * `context_with_system` handler installs `transcript()` + the run tail, and an
 * opaque provider registered through `ModelRuntime.registerProvider` whose
 * `streamSimple` is the official one with a scoped gate `fetch`.
 */
export async function createOfficialSession(options: {
  transcript: () => Message[];
  gate: GateMode;
}): Promise<SessionHarness> {
  const root = mkdtempSync(path.join(tmpdir(), 'byok-official-pi-'));
  const cwd = path.join(root, 'cwd');
  const agentDir = path.join(root, 'agent');
  const harness = {
    gateBodies: [] as string[],
    sends: [] as string[],
    run: {} as { refusal?: RunScopedRefusal },
    messageEnds: [] as Message[],
    contextTails: [] as Message[][],
    contextAnomalies: [] as string[],
    providerOptions: [] as Record<string, unknown>[],
    toolExecutions: 0,
  };

  const gateFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body);
    harness.gateBodies.push(body);
    const verdict = options.gate(harness.gateBodies.length, body);
    if ('refuse' in verdict) {
      harness.run.refusal = verdict.refuse; // run-scoped reason written BEFORE the throw
      throw new Error(`byok_gate_refused: ${verdict.refuse.code}`);
    }
    harness.sends.push(body);
    return verdict;
  };

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(PROVIDER, {
    name: 'BYOK opaque (conformance)',
    baseUrl: SINK_BASE_URL,
    apiKey: 'synthetic-not-a-secret',
    api: 'openai-completions',
    models: [structuredClone(MODEL_SPEC) as never],
    streamSimple: (model, context, providerOptions) => {
      harness.providerOptions.push(Object.fromEntries(
        Object.entries(providerOptions ?? {}).filter(([, value]) => typeof value !== 'function' && !(value instanceof AbortSignal)),
      ));
      return streamSimple(model as Model<'openai-completions'>, context, {
        ...providerOptions,
        cacheRetention: COMPILE_OPTIONS.cacheRetention,
        fetch: gateFetch as typeof fetch,
      });
    },
  });
  const model = modelRuntime.getModel(PROVIDER, MODEL_SPEC.id);
  if (model === undefined) throw new Error('conformance: opaque provider model did not register');

  const extension: ExtensionFactory = (pi) => {
    pi.on('context_with_system', (event) => {
      const [head, trigger, ...tail] = event.messages as Message[];
      if (head?.role !== 'system') harness.contextAnomalies.push(`native[0] role ${String(head?.role)}`);
      const triggerText = trigger?.role !== 'user'
        ? undefined
        : typeof trigger.content === 'string'
          ? trigger.content
          : trigger.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('');
      if (triggerText !== TRIGGER_TEXT) {
        harness.contextAnomalies.push(`native[1] is not the trigger: ${JSON.stringify(trigger)?.slice(0, 120)}`);
      }
      harness.contextTails.push(structuredClone(tail));
      return { messages: [...options.transcript(), ...tail] as never };
    });
  };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    cacheWarming: 'off',
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'NATIVE SYSTEM PROMPT (replaced by the Host transcript)',
    extensionFactories: [{ name: 'byok-conformance', factory: extension }] as never,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: THINKING_LEVEL,
    tools: [OBSERVE_TOOL_NAME],
    customTools: [{
      name: OBSERVE_TOOL_NAME,
      label: 'observe',
      description: OBSERVE_TOOL.description,
      parameters: OBSERVE_TOOL.parameters,
      execute: async () => {
        harness.toolExecutions += 1;
        return { content: [{ type: 'text', text: OBSERVE_TOOL_RESULT_TEXT }], details: {} };
      },
    }] as never,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd, { id: SESSION_ID }),
    settingsManager,
  });
  session.subscribe((event) => {
    if (event.type === 'message_end') harness.messageEnds.push(structuredClone(event.message) as Message);
  });

  return Object.assign(harness, {
    session,
    dispose() {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  });
}
