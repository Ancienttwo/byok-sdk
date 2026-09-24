import { createHash } from 'node:crypto';
import type { Message, Model, SimpleStreamOptions, SystemMessage, Tool } from '@earendil-works/pi-ai';
import type {
  InputPreparationMessageV1,
  InputPreparationModelV1,
  InputPreparationOptionsV1,
  InputPreparationResidualKeyV1,
  InputPreparationToolV1,
} from '../../input-preparation';
import { admitHostAssistantContent } from './host-history-admission';

/**
 * The SDK-owned prepared request compiler (A1', approved 2026-09-25).
 *
 * D is produced by the OFFICIAL `streamSimple` entry of
 * `@earendil-works/pi-ai/api/openai-completions` — the same function the live
 * session's provider call runs — and captured at its last step: the injected
 * `fetch` receives the final serialized body string and throws. Nothing here
 * serializes a request of its own. What this module adds is only:
 *
 * - the Host transcript T, built from the SDK's own message vocabulary by ONE
 *   function ({@link buildPreparedTranscriptMessages}) that both the compile and
 *   the prepared session's `context_with_system` handler call, so the two
 *   cannot build different transcripts;
 * - the model object, projected by ONE function ({@link projectPreparedModel})
 *   that the compile uses and the prepared host registers — real `provider`,
 *   real `baseUrl`, declared `compat`/`thinkingLevelMap` — because pi-ai detects
 *   compat from `provider`/`baseUrl` and a sink model would not reproduce the
 *   live bytes for a real endpoint;
 * - the pinned option set ({@link preparedProviderStreamOptions}) both sides
 *   force, so neither ambient settings nor `PI_CACHE_RETENTION` move D.
 *
 * No-leak guarantee of the compile: the exact official version pin plus the
 * conformance test (d') proving the injected `fetch` is the only transport path
 * (a `globalThis.fetch` spy is never called; the capture fetch is called exactly
 * once). The compile uses the placeholder key {@link PREPARED_COMPILE_API_KEY},
 * never a credential. Upstream U1 (`buildRequestPayload`) removes the need for
 * a transport at all and replaces this module's capture.
 */

/** A2' request-scoped sentinel provenance for Host-owned assistant text. Never persisted, never on the wire. */
export const PREPARED_HOST_ASSISTANT_PROVENANCE = Object.freeze({
  api: 'byok-host-canonical-api',
  provider: 'byok-host-canonical-provider',
  model: 'byok-host-canonical-model',
});

/**
 * The provider session id both the compile and the live gate pin.
 *
 * It reaches D only as `prompt_cache_key` (long retention, or an
 * `api.openai.com` endpoint with any retention), where it is classified as the
 * `constant` it is. A per-run value would make D depend on the session.
 */
export const PREPARED_PROVIDER_SESSION_ID = 'byok-prepared';

/** The non-secret placeholder the A1' compile hands the official client. Never a credential. */
export const PREPARED_COMPILE_API_KEY = 'byok-prepared-compile-placeholder';

/** Stable refusal codes of this module. */
export type PreparedRequestRefusalCode =
  | 'prepared_transcript_invalid'
  | 'host_assistant_not_text'
  | 'tool_constrained_sampling_unsupported'
  | 'prepared_compile_capture_failed';

export class PreparedRequestError extends Error {
  readonly code: PreparedRequestRefusalCode;

  constructor(code: PreparedRequestRefusalCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PreparedRequestError';
    this.code = code;
  }
}

/**
 * Stable consume-side failure codes. They cross the `prompt_prepared` RPC
 * response, so they are part of the adapter's contract.
 */
export type PreparedSessionErrorCode =
  | 'prepared_input_invalid'
  | 'prepared_digest_mismatch'
  | 'prepared_expectation_mismatch'
  | 'prepared_duplicate'
  | 'prepared_context_drift'
  | 'prepared_registry_drift'
  | 'prepared_model_drift'
  | 'prepared_model_unsupported'
  | 'prepared_session_ineligible'
  | 'prepared_endpoint_mismatch'
  | 'prepared_body_drift';

export class PreparedSessionError extends Error {
  readonly code: PreparedSessionErrorCode;

  constructor(code: PreparedSessionErrorCode, message: string) {
    super(message);
    this.name = 'PreparedSessionError';
    this.code = code;
  }
}

/** Stable code for any rejection on the prepared path, including non-prepared errors. */
export function preparedSessionErrorCode(error: unknown): PreparedSessionErrorCode | 'prepared_failed' {
  return error instanceof PreparedSessionError ? error.code : 'prepared_failed';
}

function refuse(code: PreparedRequestRefusalCode, message: string): never {
  throw new PreparedRequestError(code, message);
}

/** The Host-owned request content: the whole system message, the tools it declares, and the history. */
export interface PreparedTranscriptV1 {
  readonly systemPrompt: string;
  readonly tools: readonly InputPreparationToolV1[];
  readonly messages: readonly InputPreparationMessageV1[];
}

/** The body-affecting option set D is compiled from, forced again on every live request. */
export interface PreparedRequestOptionsV1 extends InputPreparationOptionsV1 {
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON (plain helpers; no Pi request semantics)
// ---------------------------------------------------------------------------

/** Key-sorted serialization; `undefined` members are omitted. Same rule the retired fork helper used. */
export function canonicalPreparedValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPreparedValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalPreparedValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalPreparedDigest(value: unknown): string {
  return sha256Hex(canonicalPreparedValue(value));
}

// ---------------------------------------------------------------------------
// Model and options projection
// ---------------------------------------------------------------------------

/**
 * The model the compile runs against and the prepared host registers.
 * Only declared keys are carried: a present `undefined` would be a declaration.
 */
export function projectPreparedModel(model: InputPreparationModelV1): Model<'openai-completions'> {
  return {
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    ...(model.compat === undefined ? {} : { compat: { ...model.compat } }),
  } as Model<'openai-completions'>;
}

/** The option keys the compile sets and the live gate forces; a session value for any of them is discarded. */
export const PREPARED_PINNED_STREAM_OPTION_KEYS = Object.freeze([
  'cacheRetention', 'maxTokens', 'temperature', 'toolChoice', 'reasoning', 'sessionId',
] as const);

/** The pinned stream options, with absent members left absent. */
export function preparedProviderStreamOptions(options: PreparedRequestOptionsV1): SimpleStreamOptions {
  return {
    cacheRetention: options.cacheRetention,
    maxTokens: options.maxTokens,
    sessionId: options.sessionId,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort }),
  };
}

/** Replace every pinned key of a live option object with the frozen value (or its absence). */
export function forcePreparedStreamOptions(
  live: SimpleStreamOptions | undefined,
  options: PreparedRequestOptionsV1,
): SimpleStreamOptions {
  const merged: Record<string, unknown> = { ...(live ?? {}) };
  for (const key of PREPARED_PINNED_STREAM_OPTION_KEYS) delete merged[key];
  return { ...(merged as SimpleStreamOptions), ...preparedProviderStreamOptions(options) };
}

// ---------------------------------------------------------------------------
// The Host transcript T (A2')
// ---------------------------------------------------------------------------

const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function projectTool(tool: InputPreparationToolV1): Tool {
  if (typeof tool.name !== 'string' || tool.name.trim().length === 0 || typeof tool.description !== 'string') {
    refuse('prepared_transcript_invalid', 'a prepared tool needs a non-empty name and a string description');
  }
  const parameters = tool.parameters as Record<string, unknown> | null;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters) || parameters.type !== 'object'
    || parameters.properties === null || typeof parameters.properties !== 'object' || Array.isArray(parameters.properties)) {
    refuse('prepared_transcript_invalid', `tool ${JSON.stringify(tool.name)} needs a full object parameter schema`);
  }
  const sampling = (tool as { constrainedSampling?: unknown }).constrainedSampling;
  if (sampling !== undefined && sampling !== false) {
    const config = sampling as { type?: unknown; strict?: unknown };
    // `strict: "require"` throws inside the official serializer when the schema
    // or the endpoint cannot honour it, and grammar variants are
    // endpoint-conditional; both are refused rather than compiled.
    if (config.type !== 'json_schema' || config.strict !== 'prefer' || Object.keys(config).length !== 2) {
      refuse(
        'tool_constrained_sampling_unsupported',
        `tool ${JSON.stringify(tool.name)} declares constrained sampling other than { type: "json_schema", strict: "prefer" }`,
      );
    }
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(parameters) as never,
    ...(sampling === undefined ? {} : { constrainedSampling: structuredClone(sampling) as Tool['constrainedSampling'] }),
  };
}

/**
 * Build T. The ONE builder: the compile and the prepared session's
 * `context_with_system` handler both call it, and the sentinel assistant
 * messages it produces exist only in its return value.
 */
export function buildPreparedTranscriptMessages(transcript: PreparedTranscriptV1): Message[] {
  if (typeof transcript.systemPrompt !== 'string') {
    refuse('prepared_transcript_invalid', 'the Host system message must be a string');
  }
  const tools = transcript.tools.map(projectTool);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    refuse('prepared_transcript_invalid', 'duplicate prepared tool names');
  }
  if (transcript.messages.length === 0 || transcript.messages.at(-1)?.role !== 'user') {
    refuse('prepared_transcript_invalid', 'a prepared transcript ends on the user request it answers');
  }
  const system: SystemMessage = {
    role: 'system',
    content: transcript.systemPrompt,
    ...(tools.length === 0 ? {} : { toolsAdded: tools }),
    timestamp: 0,
  };
  const messages: Message[] = [system];
  for (const message of transcript.messages) {
    if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
      refuse('prepared_transcript_invalid', 'every prepared message carries a finite timestamp');
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string') refuse('prepared_transcript_invalid', 'user content must be text');
      messages.push({ role: 'user', content: message.content, timestamp: message.timestamp });
      continue;
    }
    if (message.role === 'assistant' && message.origin === 'host_canonical') {
      const content = [{ type: 'text' as const, text: message.content }];
      const admission = admitHostAssistantContent(content);
      if (!admission.admitted) {
        refuse('host_assistant_not_text', `Host assistant history refused: ${admission.refusal.code}`);
      }
      messages.push({
        role: 'assistant',
        content,
        api: PREPARED_HOST_ASSISTANT_PROVENANCE.api,
        provider: PREPARED_HOST_ASSISTANT_PROVENANCE.provider,
        model: PREPARED_HOST_ASSISTANT_PROVENANCE.model,
        usage: structuredClone(ZERO_USAGE),
        stopReason: 'stop',
        timestamp: message.timestamp,
      } as Message);
      continue;
    }
    refuse('prepared_transcript_invalid', 'only user text and Host-canonical assistant text are admitted');
  }
  return messages;
}

// ---------------------------------------------------------------------------
// A1' compile
// ---------------------------------------------------------------------------

type OfficialCompiler = {
  readonly streamSimple: typeof import('@earendil-works/pi-ai/api/openai-completions').streamSimple;
  readonly normalizeContext: typeof import('@earendil-works/pi-ai').normalizeContext;
};

let officialCompiler: Promise<OfficialCompiler> | undefined;

/**
 * Loaded lazily and once: this module is reachable from the SDK root through
 * the daemon, and a static import would evaluate the provider graph for every
 * consumer, including those that never prepare input.
 */
export function loadOfficialCompiler(): Promise<OfficialCompiler> {
  officialCompiler ??= Promise.all([
    import('@earendil-works/pi-ai/api/openai-completions'),
    import('@earendil-works/pi-ai'),
  ]).then(([completions, ai]) => ({ streamSimple: completions.streamSimple, normalizeContext: ai.normalizeContext }));
  return officialCompiler;
}

class CaptureOnlyStop extends Error {
  constructor() {
    super('prepared compile capture: never sent');
    this.name = 'CaptureOnlyStop';
  }
}

export interface CapturedProviderRequest {
  /** The exact serialized request body D. */
  readonly body: string;
  /** The URL the official client addressed. Not part of D; the live gate compares it too. */
  readonly endpoint: string;
}

/**
 * A1': run the official `streamSimple` with a capture-and-throw `fetch` and
 * `maxRetries: 0`. No session, no credential, no network: the injected fetch is
 * the only transport, and it never sends.
 */
export async function compilePreparedProviderRequest(input: {
  readonly model: Model<'openai-completions'>;
  readonly messages: Message[];
  readonly options: PreparedRequestOptionsV1;
}): Promise<CapturedProviderRequest> {
  const { streamSimple, normalizeContext } = await loadOfficialCompiler();
  const captured: { endpoint: string; body: unknown }[] = [];
  const captureFetch = async (resource: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({ endpoint: resource instanceof Request ? resource.url : String(resource), body: init?.body });
    throw new CaptureOnlyStop();
  };
  let terminal: string | undefined;
  try {
    const stream = streamSimple(input.model, normalizeContext({ messages: structuredClone(input.messages) }), {
      ...preparedProviderStreamOptions(input.options),
      apiKey: PREPARED_COMPILE_API_KEY,
      fetch: captureFetch as typeof fetch,
      maxRetries: 0,
      env: {},
    });
    for await (const event of stream) {
      if (event.type === 'done' || event.type === 'error') terminal = event.type;
    }
  } catch (cause) {
    throw new PreparedRequestError(
      'prepared_compile_capture_failed',
      `the official serializer refused this input: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const only = captured[0];
  if (captured.length !== 1 || only === undefined || terminal !== 'error') {
    refuse(
      'prepared_compile_capture_failed',
      `the official serializer reached the injected transport ${captured.length} time(s) and ended with ${String(terminal)}; exactly one capture is required`,
    );
  }
  if (typeof only.body !== 'string') {
    refuse('prepared_compile_capture_failed', 'the official serializer handed the transport a non-string body');
  }
  return { body: only.body, endpoint: only.endpoint };
}

// ---------------------------------------------------------------------------
// Envelope v4: every captured byte belongs to P(D); no local serializer classification.
// ---------------------------------------------------------------------------
export interface PreparedProjection {
  readonly counterProjection: string;
  readonly kind: 'content_complete';
  readonly residual: readonly InputPreparationResidualKeyV1[];
}

export function derivePreparedProjection(body: string): PreparedProjection {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse('prepared_compile_capture_failed', 'D is not a JSON object');
  }
  return { counterProjection: body, kind: 'content_complete', residual: [] };
}
