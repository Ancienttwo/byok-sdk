import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, AssistantMessage, Model, ProviderStreams, StreamOptions } from '@earendil-works/pi-ai';
import type { TranscriptContext } from '@earendil-works/pi-ai/utils/transcript';
import type { ModelProviderSecretName, SecretStore } from '@byok-sdk/keys';
import { CloudDoError, safeCloudError } from './errors';
import { createProviderFetch, readSseData } from './provider-fetch';
import { PLATFORM_PROFILES, platformCredentialReader, requirePlatformKey, type PlatformProfile } from './platform-credentials';

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

function messages(context: TranscriptContext): { role: string; content: string }[] {
  return context.messages.map(message => {
    if (!['system', 'user', 'assistant'].includes(message.role)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    if (message.role === 'system' && (message.toolsAdded?.length || message.toolsRemoved?.length)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const content = typeof message.content === 'string' ? message.content : message.content.map(block => {
      if (block.type !== 'text' && block.type !== 'thinking') throw new CloudDoError('CLOUD_REQUEST_INVALID');
      return block.type === 'text' ? block.text : '';
    }).join('');
    return { role: message.role, content };
  });
}

/** Text-only OpenAI-compatible pi stream, intentionally excluding tools (4c).
 * pi-ai's Node SDK transport imports node:fs; this Web transport implements its
 * existing ProviderStreams contract and consumes only the guarded SSE boundary. */
function stream(profile: PlatformProfile, model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream {
  const events = new AssistantMessageEventStream();
  const output = emptyAssistant(model);
  const blocks = new Map<'content' | 'reasoning_content', number>();
  const run = async () => {
    try {
      const key = requirePlatformKey(options?.apiKey);
      const request = createProviderFetch(profile, key);
      const response = await request(`${profile.baseUrl}/chat/completions`, { method: 'POST', signal: options?.signal,
        body: JSON.stringify({ model: profile.model, messages: messages(context), stream: true, stream_options: { include_usage: true }, max_tokens: 4096 }) });
      events.push({ type: 'start', partial: output });
      for await (const data of readSseData(response.body!)) {
        if (data === '[DONE]') break;
        // Only provider-fetch's re-encoded whitelist reaches here, never raw frames.
        const frame = JSON.parse(data) as { choices: { delta: { content?: string; reasoning_content?: string }; finish_reason: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
        if (frame.usage) {
          output.usage.input = frame.usage.prompt_tokens ?? 0;
          output.usage.output = frame.usage.completion_tokens ?? 0;
          output.usage.totalTokens = frame.usage.total_tokens ?? output.usage.input + output.usage.output;
        }
        for (const choice of frame.choices) {
          if (choice.finish_reason === 'length') output.stopReason = 'length';
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
      events.push({ type: 'done', reason: output.stopReason as 'stop' | 'length', message: output });
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
  credentials: Pick<SecretStore<ModelProviderSecretName>, 'get'> = platformCredentialReader(env)) {
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
    const implementation: ProviderStreams = { stream: (model, context, options) => stream(profile, model, context, options),
      streamSimple: (model, context, options) => stream(profile, model, context, options) };
    const model: Model<'openai-completions'> = { id: profile.model, name: profile.model, provider: id, api: 'openai-completions', baseUrl: profile.baseUrl,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 4096 };
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
