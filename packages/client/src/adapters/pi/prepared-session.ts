import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Api, AssistantMessageEventStream, Message, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { InputPreparationModelV1 } from '../../input-preparation';
import type { PreparedPiInputV1 } from './input-preparation';
import {
  buildPreparedTranscriptMessages,
  canonicalPreparedValue,
  forcePreparedStreamOptions,
  projectPreparedModel,
  PreparedSessionError,
  sha256Hex,
} from './prepared-request';

/**
 * The prepared session on OFFICIAL Pi: a public `createAgentSession` whose
 * context is projected by `context_with_system` and whose only provider
 * transport is the byte gate below.
 *
 * Enforcement lives in exactly one place, the gate `fetch` the registered
 * provider's `streamSimple` hands the official serializer. The
 * `context_with_system` handler is a PROJECTION: upstream catches handler
 * errors and sends the unmodified context, so the handler only records what it
 * did, and the gate refuses anything the handler did not project.
 *
 * The gate compares request 1 byte-for-byte with the frozen D and its
 * endpoint. Requests 2..n (tool-result rounds) are admitted under their own
 * sequence number only when the handler projected them and the endpoint is the
 * frozen one; D describes request 1 alone, so no first-round verdict is reused.
 * A refusal writes its typed reason to run-scoped state BEFORE it throws,
 * because the throw surfaces upstream as a retryable-looking connection error.
 */

/** The fixed text the host prompts with. The context handler replaces it with T. */
export const PREPARED_TRIGGER_TEXT = 'byok prepared request (replaced by the Host transcript)';

export interface PreparedGateRefusal {
  readonly code: 'prepared_body_drift' | 'prepared_endpoint_mismatch' | 'prepared_context_drift' | 'prepared_session_unarmed' | 'prepared_headers_invalid' | 'prepared_transport_repeated';
  readonly sequence: number;
  readonly message: string;
  readonly expectedSha256?: string;
  readonly observedSha256?: string;
  readonly observedBytes?: number;
}

/** Run-scoped gate state. Written before any refusal is thrown. */
export interface PreparedGateState {
  /** Provider requests the gate has seen. */
  sequence: number;
  /** Requests the context handler projected (incremented after a successful projection). */
  contextProjected: number;
  /** First anomaly the context handler observed, if any. */
  contextAnomaly?: string;
  /** The first refusal of this run. Every later request is refused with it. */
  refusal?: PreparedGateRefusal;
  /** Sequence numbers that were admitted to the transport. */
  readonly admitted: number[];
}

/** The byte gate for one prepared run. Registered before the envelope arrives, armed once it is verified. */
export interface PreparedGate {
  readonly state: PreparedGateState;
  /** Arm with the verified envelope. Exactly once. */
  arm(envelope: PreparedPiInputV1, onFirstRequestVerdict: (refusal: PreparedGateRefusal | undefined) => void): void;
  /** The registered provider's `streamSimple`: the official one, pinned options, gate `fetch`. */
  streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
  /** Record one context projection (called by the context handler only). */
  projectContext(messages: readonly Message[]): Message[] | undefined;
}

function requestUrl(resource: string | URL | Request): string {
  return resource instanceof Request ? resource.url : String(resource);
}

/**
 * Create the gate. `transport` is where an admitted request goes; it defaults
 * to `globalThis.fetch`, read at call time. The gate itself is never installed
 * globally.
 */
export function createPreparedGate(options: { readonly transport?: typeof fetch } = {}): PreparedGate {
  const state: PreparedGateState = { sequence: 0, contextProjected: 0, admitted: [] };
  let armed: { envelope: PreparedPiInputV1; frozenSha256: string } | undefined;
  let onVerdict: ((refusal: PreparedGateRefusal | undefined) => void) | undefined;
  let verdictSent = false;
  const firstVerdict = (refusal: PreparedGateRefusal | undefined): void => {
    if (verdictSent) return;
    verdictSent = true;
    onVerdict?.(refusal);
  };
  const refuse = (refusal: PreparedGateRefusal): never => {
    state.refusal ??= refusal; // run-scoped reason, written BEFORE the throw
    if (refusal.sequence === 1) firstVerdict(refusal);
    throw new Error(`byok_prepared_gate_refused: ${refusal.code}`);
  };

  const gateFetch = async (resource: string | URL | Request, init: RequestInit | undefined, apiKey: string | undefined): Promise<Response> => {
    state.sequence += 1;
    const sequence = state.sequence;
    if (armed === undefined) {
      return refuse({ code: 'prepared_session_unarmed', sequence, message: 'no verified prepared input is armed' });
    }
    const request = armed.envelope.providerRequest;
    if (state.refusal !== undefined) {
      return refuse({ ...state.refusal, sequence, message: `an earlier request of this run was refused (${state.refusal.code})` });
    }
    if (state.contextAnomaly !== undefined || state.contextProjected !== sequence) {
      return refuse({
        code: 'prepared_context_drift',
        sequence,
        message: state.contextAnomaly ?? `request ${sequence} was not projected by the prepared context handler`,
      });
    }
    if (requestUrl(resource) !== request.endpoint) {
      return refuse({ code: 'prepared_endpoint_mismatch', sequence, message: 'the request endpoint is not the prepared endpoint' });
    }
    const headers = new Headers(init?.headers);
    const fixed = new Set(['accept', 'authorization', 'content-type', 'user-agent',
      'x-stainless-arch', 'x-stainless-lang', 'x-stainless-os', 'x-stainless-package-version',
      'x-stainless-retry-count', 'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout']);
    const affinity = new Set(['x-session-id', 'session_id', 'x-client-request-id', 'x-session-affinity']);
    const invalidHeader = [...headers].some(([name, value]) => !fixed.has(name)
      && (!affinity.has(name) || value !== request.options.sessionId));
    if (invalidHeader || headers.get('content-type') !== 'application/json'
      || headers.get('accept') !== 'application/json'
      || typeof apiKey !== 'string' || headers.get('authorization') !== `Bearer ${apiKey}`
      || headers.get('x-stainless-retry-count') !== '0') {
      return refuse({ code: 'prepared_headers_invalid', sequence, message: `provider headers differ from the admitted header contract (names: ${[...headers.keys()].join(', ')}; explicit key: ${typeof apiKey === 'string'})` });
    }
    if (sequence === 1) {
      const body = init?.body;
      if (typeof body !== 'string' || body !== request.body) {
        const observed = typeof body === 'string' ? body : '';
        return refuse({
          code: 'prepared_body_drift',
          sequence,
          message: 'the request this session is about to send is not the prepared body',
          expectedSha256: armed.frozenSha256,
          observedSha256: sha256Hex(observed),
          observedBytes: Buffer.byteLength(observed, 'utf8'),
        });
      }
    }
    state.admitted.push(sequence);
    if (sequence === 1) firstVerdict(undefined);
    const transport = options.transport ?? globalThis.fetch;
    return transport(resource, { ...init, redirect: 'error' });
  };

  return {
    state,
    arm(envelope, onFirstRequestVerdict) {
      if (armed !== undefined) throw new PreparedSessionError('prepared_duplicate', 'This prepared session is already armed.');
      armed = { envelope, frozenSha256: sha256Hex(envelope.providerRequest.body) };
      onVerdict = onFirstRequestVerdict;
    },
    streamSimple(model, context, streamOptions) {
      if (armed === undefined) {
        state.sequence += 1;
        state.refusal ??= { code: 'prepared_session_unarmed', sequence: state.sequence, message: 'no verified prepared input is armed' };
        throw new Error('byok_prepared_gate_refused: prepared_session_unarmed');
      }
      let fetchCalls = 0;
      const scopedFetch: typeof fetch = async (resource, init) => {
        fetchCalls += 1;
        if (fetchCalls !== 1) {
          return refuse({ code: 'prepared_transport_repeated', sequence: state.sequence,
            message: 'one provider stream attempted more than one fetch' });
        }
        return gateFetch(resource, init, streamOptions?.apiKey);
      };
      return streamSimple(model as Model<'openai-completions'>, context, {
        ...forcePreparedStreamOptions(streamOptions, armed.envelope.providerRequest.options),
        fetch: scopedFetch,
        env: {},
        maxRetries: 0,
      });
    },
    projectContext(messages) {
      if (armed === undefined) {
        state.contextAnomaly ??= 'the context handler ran before the prepared input was armed';
        return undefined;
      }
      const [head, trigger, ...tail] = messages;
      const triggerText = trigger?.role !== 'user'
        ? undefined
        : typeof trigger.content === 'string'
          ? trigger.content
          : trigger.content.length === 1 && trigger.content[0]?.type === 'text' ? trigger.content[0].text : undefined;
      if (head?.role !== 'system' || triggerText !== PREPARED_TRIGGER_TEXT) {
        state.contextAnomaly ??= 'the native context does not lead with [system, trigger]; the Host system message would be lost';
        return undefined;
      }
      // Request 1 carries T alone. Later requests carry T plus this run's own
      // assistant and tool-result turns; anything else (a steer, a follow-up,
      // a mid-run system message) is not part of what was prepared.
      if (tail.some((message) => message.role !== 'assistant' && message.role !== 'toolResult')) {
        state.contextAnomaly ??= 'the native context carries a message this prepared run did not produce';
        return undefined;
      }
      const projected = [...buildPreparedTranscriptMessages(armed.envelope.transcript), ...tail];
      state.contextProjected += 1;
      return projected;
    },
  };
}

/** The credential wiring for the one provider a prepared session registers. */
export interface PreparedProviderCredential {
  /** A `$ENV` reference the runtime resolves at request time; absent = the runtime's own auth store. */
  readonly apiKey?: string;
  readonly authHeader?: true;
}

/**
 * Register the counted model's provider with the gate as its `streamSimple`,
 * and return the model the runtime now resolves for it. Refuses a registered
 * model that is not the counted one or that declares `promptCache` /
 * `samplingParams`.
 */
export function registerPreparedProvider(
  modelRuntime: ModelRuntime,
  model: InputPreparationModelV1,
  credential: PreparedProviderCredential,
  gate: PreparedGate,
): Model<Api> {
  const projected = projectPreparedModel(model);
  modelRuntime.registerProvider(model.provider, {
    baseUrl: projected.baseUrl,
    api: 'openai-completions',
    ...(credential.apiKey === undefined ? {} : { apiKey: credential.apiKey }),
    ...(credential.authHeader === true ? { authHeader: true } : {}),
    models: [{
      id: projected.id,
      name: projected.name,
      reasoning: projected.reasoning,
      input: projected.input,
      cost: projected.cost,
      contextWindow: projected.contextWindow,
      maxTokens: projected.maxTokens,
      ...(projected.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: projected.thinkingLevelMap }),
      ...(projected.compat === undefined ? {} : { compat: projected.compat }),
    }],
    streamSimple: (m, context, options) => gate.streamSimple(m, context, options),
  });
  const registered = modelRuntime.getModel(model.provider, model.id);
  if (registered === undefined) {
    throw new PreparedSessionError('prepared_model_drift', 'The prepared model did not register with the runtime.');
  }
  // Both move request bytes or cache behaviour D was not compiled with.
  if (registered.promptCache !== undefined || registered.samplingParams !== undefined) {
    throw new PreparedSessionError('prepared_model_unsupported',
      'The registered model declares promptCache or samplingParams, which the prepared lane does not admit.');
  }
  const comparable = (value: Model<Api>): string => canonicalPreparedValue({
    id: value.id, name: value.name, api: value.api, provider: value.provider, baseUrl: value.baseUrl,
    reasoning: value.reasoning, input: value.input, contextWindow: value.contextWindow, maxTokens: value.maxTokens,
    thinkingLevelMap: value.thinkingLevelMap, compat: value.compat,
  });
  if (comparable(registered) !== comparable(projected)) {
    throw new PreparedSessionError('prepared_model_drift', 'The registered model is not the prepared model.');
  }
  return registered;
}

/** One authorized tool, as the prepared tool surface assembled it. */
export interface PreparedSessionTool {
  readonly name: string;
  readonly identity: string;
  readonly tool: ToolDefinition;
}

export interface CreatePreparedSessionOptions {
  readonly envelope: PreparedPiInputV1;
  readonly gate: PreparedGate;
  readonly model: Model<Api>;
  readonly cwd: string;
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly tools: readonly PreparedSessionTool[];
  /** Session id of the in-memory session (the adapter reads it back as the session ref). */
  readonly sessionId?: string;
  /** Called when the extension runtime is bound (`session_start`), i.e. from inside `runRpcMode`'s bind. */
  readonly onSessionStart?: () => void;
}

export interface PreparedSessionHandle {
  readonly session: AgentSession;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: DefaultResourceLoader;
}

/** Build the prepared session over an armed gate. Refusals throw {@link PreparedSessionError}. */
export async function createPreparedPiSession(options: CreatePreparedSessionOptions): Promise<PreparedSessionHandle> {
  const { envelope, gate } = options;
  // The registered tool surface must be exactly the one the envelope froze.
  if (canonicalPreparedValue(options.tools.map((entry) => entry.name)) !== canonicalPreparedValue(envelope.toolManifest.order)
    || canonicalPreparedValue(options.tools.map((entry) => entry.identity)) !== canonicalPreparedValue(envelope.toolManifest.executors)) {
    throw new PreparedSessionError('prepared_registry_drift', 'The authorized tool surface is not the prepared tool manifest.');
  }

  const extension: ExtensionFactory = (pi) => {
    pi.on('session_start', () => {
      options.onSessionStart?.();
    });
    pi.on('context_with_system', (event) => {
      const messages = gate.projectContext(event.messages as Message[]);
      return messages === undefined ? undefined : { messages: messages as never };
    });
  };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    cacheWarming: 'off',
  });
  const systemPrompt = envelope.transcript.systemPrompt;
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [{ name: 'byok-prepared-context', factory: extension }] as never,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: envelope.providerRequest.options.reasoningEffort ?? 'off',
    tools: options.tools.map((entry) => entry.name),
    customTools: options.tools.map((entry) => entry.tool),
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd, options.sessionId === undefined ? undefined : { id: options.sessionId }),
    settingsManager,
  });
  // Every session carries a cache warmer; its mode is the setting above. A warm
  // request would re-send through the gate and be refused there, but a session
  // that would even try is not a prepared session.
  if (settingsManager.getCacheWarmingMode() !== 'off' || session.cacheWarmingStatus?.state !== 'inactive') {
    session.dispose();
    throw new PreparedSessionError('prepared_session_ineligible', 'Cache warming is not off on the prepared session.');
  }
  return { session, settingsManager, resourceLoader };
}
