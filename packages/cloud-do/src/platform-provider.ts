import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, AssistantMessage, JsonObject, Model, ProviderStreams, StreamOptions, ToolCall } from '@earendil-works/pi-ai';
import { getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai/utils/transcript';
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text';
import { CloudDoError, safeCloudError } from './errors';
import { createProviderFetch, readSseData } from './provider-fetch';
import { PLATFORM_PROFILES, platformCredentialReader, requirePlatformKey, type PlatformProfile, type PlatformCredentialReader } from './platform-credentials';

export const PLATFORM_MAX_OUTPUT_TOKENS = 4096;
export const REQUEST_FRAMING_BYTES = 4096;

function emptyAssistant(model: Model<Api>): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now() };
}

/** pi resolves auth before calling ProviderStreams. Strip its auth error wrapper
 * before any error event or result reaches durable persistence. */
function fixedModelErrors(source: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
  const events = new AssistantMessageEventStream();
  const run = async () => {
    let terminal: AssistantMessage | undefined;
    try {
      for await (const event of source) {
        if (event.type === 'error') {
          const message = event.error.errorMessage;
          const code = message?.includes('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE')
            ? 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE' : safeCloudError(new Error(message)).code;
          terminal = { ...emptyAssistant(model), content: event.error.content, usage: event.error.usage,
            stopReason: event.reason, errorMessage: code };
          events.push({ type: 'error', reason: event.reason, error: terminal });
        } else {
          if (event.type === 'done') terminal = event.message;
          events.push(event);
        }
      }
      if (!terminal) throw new CloudDoError('CLOUD_MODEL_REQUEST_FAILED');
    } catch {
      terminal = { ...emptyAssistant(model), stopReason: 'error', errorMessage: 'CLOUD_MODEL_REQUEST_FAILED' };
      events.push({ type: 'error', reason: 'error', error: terminal });
    } finally { events.end(terminal); }
  };
  void run();
  return events;
}

export interface CloudModelAccount {
  sent(): void;
  usage(usage: { input?: number; output?: number }): void;
}

export interface CloudModelRuntime {
  beforeRequest(info: { inputBytes: number }): void | CloudModelAccount | Promise<void | CloudModelAccount>;
  admitToolCall(name: string, id: string, args: Record<string, unknown>): void | Promise<void>;
  requestSignal?(signal?: AbortSignal): AbortSignal;
}

type ProviderMessage = { role: string; content: string; tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] };

function messages(context: TranscriptContext): ProviderMessage[] {
  return context.messages.map(message => {
    if (message.role === 'system') return { role: 'system', content: getSystemMessageText(message) };
    if (message.role === 'toolResult') return { role: 'tool', tool_call_id: message.toolCallId,
      content: message.content.map(block => {
        if (block.type !== 'text') throw new CloudDoError('CLOUD_REQUEST_INVALID');
        return block.text;
      }).join('') };
    if (message.role !== 'user' && message.role !== 'assistant') throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const calls: NonNullable<ProviderMessage['tool_calls']> = [];
    const content = typeof message.content === 'string' ? message.content : message.content.map(block => {
      if (block.type === 'toolCall' && message.role === 'assistant') {
        calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments) } });
        return '';
      }
      if (block.type !== 'text' && block.type !== 'thinking') throw new CloudDoError('CLOUD_REQUEST_INVALID');
      return block.type === 'text' ? block.text : '';
    }).join('');
    return { role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) };
  });
}

/** Web OpenAI-compatible transport. Native pi generation owns tool rounds. */
function stream(profile: PlatformProfile, model: Model<Api>, context: TranscriptContext, options?: StreamOptions, runtime?: CloudModelRuntime): AssistantMessageEventStream {
  const events = new AssistantMessageEventStream();
  const output = emptyAssistant(model);
  const blocks = new Map<'content' | 'reasoning_content', number>();
  const run = async () => {
    try {
      const currentTools = getCurrentTools(context.messages);
      const body = JSON.stringify({ model: profile.model, messages: messages(context), stream: true,
        stream_options: { include_usage: true }, max_tokens: PLATFORM_MAX_OUTPUT_TOKENS,
        ...(currentTools.length ? { tools: currentTools.map(tool => ({ type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}) });
      const account = await runtime?.beforeRequest({ inputBytes: new TextEncoder().encode(body).byteLength });
      const key = requirePlatformKey(options?.apiKey);
      const request = createProviderFetch(profile, key, globalThis.fetch, { offeredToolNames: currentTools.map(tool => tool.name),
        admitToolCall: (name, id, args) => runtime?.admitToolCall(name, id, args),
        onSend: () => account?.sent(),
        onUsage: usage => account?.usage({ input: usage.prompt_tokens, output: usage.completion_tokens }) });
      const response = await request(`${profile.baseUrl}/chat/completions`, { method: 'POST', signal: runtime?.requestSignal?.(options?.signal) ?? options?.signal,
        body });
      events.push({ type: 'start', partial: output });
      for await (const data of readSseData(response.body!)) {
        if (data === '[DONE]') break;
        // Only provider-fetch's re-encoded whitelist reaches here, never raw frames.
        const frame = JSON.parse(data) as { choices: { delta: { content?: string; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
        if (frame.usage) {
          output.usage.input = frame.usage.prompt_tokens ?? 0;
          output.usage.output = frame.usage.completion_tokens ?? 0;
          output.usage.totalTokens = frame.usage.total_tokens ?? output.usage.input + output.usage.output;
        }
        for (const choice of frame.choices) {
          if (choice.finish_reason === 'length') output.stopReason = 'length';
          if (choice.finish_reason === 'tool_calls') output.stopReason = 'toolUse';
          for (const call of choice.delta.tool_calls ?? []) {
            const index = output.content.length;
            const toolCall: ToolCall = { type: 'toolCall', id: call.id, name: call.function.name,
              arguments: JSON.parse(call.function.arguments) as JsonObject };
            output.content.push(toolCall);
            events.push({ type: 'toolcall_start', contentIndex: index, partial: output });
            events.push({ type: 'toolcall_delta', contentIndex: index, delta: call.function.arguments, partial: output });
            events.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: output });
          }
          for (const lane of ['content', 'reasoning_content'] as const) {
            const delta = choice.delta[lane];
            if (!delta) continue;
            let index = blocks.get(lane);
            if (index === undefined) {
              index = output.content.length; blocks.set(lane, index);
              output.content.push(lane === 'content' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
              events.push({ type: lane === 'content' ? 'text_start' : 'thinking_start', contentIndex: index, partial: output });
            }
            const block = output.content[index]!;
            if (block.type === 'text') block.text += delta;
            else if (block.type === 'thinking') block.thinking += delta;
            events.push({ type: lane === 'content' ? 'text_delta' : 'thinking_delta', contentIndex: index, delta, partial: output });
          }
        }
      }
      for (const [lane, index] of blocks) {
        const block = output.content[index]!;
        events.push({ type: lane === 'content' ? 'text_end' : 'thinking_end', contentIndex: index,
          content: block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '', partial: output });
      }
      events.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = safeCloudError(error).code;
      events.push({ type: 'error', reason: output.stopReason, error: output });
    } finally { events.end(output); }
  };
  void run();
  return events;
}

export function createPlatformModels(env: Readonly<Record<string, unknown>>,
  credentials: PlatformCredentialReader = platformCredentialReader(env), runtime?: CloudModelRuntime) {
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
    const implementation: ProviderStreams = { stream: (model, context, options) => stream(profile, model, context, options, runtime),
      streamSimple: (model, context, options) => stream(profile, model, context, options, runtime) };
    const model: Model<'openai-completions'> = { id: profile.model, name: profile.model, provider: id, api: 'openai-completions', baseUrl: profile.baseUrl,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: PLATFORM_MAX_OUTPUT_TOKENS };
    models.setProvider(createProvider({ id, models: [model], api: implementation,
      auth: { apiKey: { name: 'Platform model key', resolve: async () => {
        try {
          const key = requirePlatformKey(await credentials.get(profile.secretName));
          return { auth: { apiKey: key }, source: 'platform' };
        } catch { throw new CloudDoError('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE'); }
      } } } }));
  }
  const rawStream = models.stream.bind(models);
  const rawSimple = models.streamSimple.bind(models);
  models.stream = (model, context, options) => fixedModelErrors(rawStream(model, context, options), model);
  models.streamSimple = (model, context, options) => fixedModelErrors(rawSimple(model, context, options), model);
  return models;
}
