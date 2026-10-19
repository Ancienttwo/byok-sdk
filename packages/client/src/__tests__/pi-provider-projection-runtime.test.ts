import { promises as fs } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
// Relative and test-only, as in prepared-provider-consent.test.ts: the shipped
// dependency graph keeps `@byok-sdk/keys` and the dispatch packages disjoint.
import {
  PI_AUTH_NONE_API_KEY,
  PI_PROJECTED_KEY_ENV,
  buildPiProviderProjection,
} from '../../../keys/src/pi-provider-projection';
import { parseModelProviderProfile, type ModelProviderProfileInput } from '../../../keys/src/provider-profile';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';

/**
 * The keys projection loaded by the pinned Pi model runtime from `models.json`,
 * as the launcher writes it, with one real request to a loopback provider.
 * This proves what Pi itself sends for the projected URL and key; the keys
 * suite proves only the projection bytes.
 *
 * The rpc entry's key never enters the environment (#385): the rpc host hands
 * the launcher-delivered key to Pi's in-memory overlay with
 * `setRuntimeApiKey`, exactly as `runPiSessionRuntime` does. The environment
 * variable is stubbed with a different value so a request that read it would
 * be caught.
 */

const SECRET = 'sk-projection-runtime-0001';
const ENV_DECOY = 'sk-projection-env-decoy-0002';
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }

function sse(res: ServerResponse, events: Array<[string | undefined, unknown]>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join(''));
}

function openAiReply(res: ServerResponse): void {
  const base = { id: 'cmpl-test', object: 'chat.completion.chunk', created: 0, model: 'local-model' };
  sse(res, [
    [undefined, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] }],
    [undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
    [undefined, '[DONE]'],
  ]);
}

function responsesReply(res: ServerResponse): void {
  const item = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pong', annotations: [] }] };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  sse(res, [
    ['response.created', { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_test', delta: 'pong' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage } }],
  ]);
}

function anthropicReply(res: ServerResponse): void {
  const usage = { input_tokens: 1, output_tokens: 1 };
  sse(res, [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'messages-model', content: [], stop_reason: null, stop_sequence: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

async function provider(reply: (res: ServerResponse) => void): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      reply(res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no provider port');
  return { port: address.port, seen };
}

/** Write the projection where the launcher writes it, then send one prompt through Pi. */
async function completeThroughPi(input: Partial<ModelProviderProfileInput>, runtimeKey?: string, cacheRetention?: 'long') {
  const profile = parseModelProviderProfile({
    created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z',
    pi_model: { ...PI_MODEL_FIXTURE, reasoning: false, thinkingLevel: 'off' },
    capabilities: [], display_name: 'Probe', enabled: true, kind: 'model', profile_ref: 'probe',
    provider_kind: 'custom', ...input,
  } as ModelProviderProfileInput);
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-projection-runtime-')));
  dirs.push(dir);
  const modelsPath = path.join(dir, 'models.json');
  await fs.writeFile(modelsPath, `${JSON.stringify(buildPiProviderProjection(profile, 'pi-rpc'))}\n`, { mode: 0o600 });
  const runtime = await ModelRuntime.create({
    authPath: path.join(dir, 'auth.json'), modelsPath, allowModelNetwork: false, refreshOnCreate: false,
  });
  if (runtimeKey !== undefined) {
    await runtime.setRuntimeApiKey('byok-sdk-probe', runtimeKey);
    expect(runtime.getProviderAuthStatus('byok-sdk-probe').source).toBe('runtime');
  }
  const model = runtime.getModel('byok-sdk-probe', profile.model);
  if (model === undefined) throw new Error('projected model was not loaded by Pi');
  return { model, reply: await runtime.complete(model, { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] }, cacheRetention && { cacheRetention }) };
}

/** Method and path only: Pi's Anthropic client adds a `beta=true` query. */
const requests = (seen: Seen[]) => seen.map(({ method, url }) => `${method} ${new URL(url, 'http://provider').pathname}`);

const text = (message: { content: Array<{ type: string; text?: string }> }) =>
  message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');

describe('keys Pi projection through the pinned Pi model runtime', () => {
  it('sends an Anthropic-dialect profile to the single /v1/messages endpoint the keys client uses', async () => {
    const server = await provider(anthropicReply);
    vi.stubEnv(PI_PROJECTED_KEY_ENV, ENV_DECOY);
    const { reply } = await completeThroughPi({
      adapter: 'anthropic', auth_mode: 'x_api_key', base_url: `http://127.0.0.1:${server.port}/v1`, model: 'messages-model',
    }, SECRET);
    expect(reply.stopReason, reply.errorMessage).toBe('stop');
    expect(text(reply)).toBe('pong');
    expect(requests(server.seen)).toEqual(['POST /v1/messages']);
    expect(server.seen[0]!.headers['x-api-key']).toBe(SECRET);
    expect(JSON.stringify(server.seen)).not.toContain(ENV_DECOY);
  });

  it('authenticates a bearer profile with the in-memory key and never sends the IPC marker or the environment', async () => {
    const server = await provider(openAiReply);
    vi.stubEnv(PI_PROJECTED_KEY_ENV, ENV_DECOY);
    const { reply } = await completeThroughPi({
      adapter: 'openai_compatible', auth_mode: 'bearer', base_url: `http://127.0.0.1:${server.port}/v1`, model: 'local-model',
    }, SECRET);
    expect(reply.stopReason, reply.errorMessage).toBe('stop');
    expect(requests(server.seen)).toEqual(['POST /v1/chat/completions']);
    expect(server.seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(server.seen)).not.toContain(ENV_DECOY);
    expect(JSON.stringify(server.seen)).not.toContain('byok:rpc-ipc');
  });

  it('sends a declared openai-responses profile to /v1/responses with its catalog compat and input limits', async () => {
    const server = await provider(responsesReply);
    const inputLimits = { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } } };
    const { model, reply } = await completeThroughPi({
      adapter: 'openai_compatible', auth_mode: 'bearer', base_url: `http://127.0.0.1:${server.port}/v1`, model: 'grok-test',
      pi_model: { ...PI_MODEL_FIXTURE, api: 'openai-responses', reasoning: false, thinkingLevel: 'off',
        compat: { supportsLongCacheRetention: false }, inputLimits },
    }, SECRET, 'long');
    expect(reply.stopReason, reply.errorMessage).toBe('stop');
    expect(text(reply)).toBe('pong');
    expect(requests(server.seen)).toEqual(['POST /v1/responses']);
    expect(server.seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(model.inputLimits).toEqual(inputLimits);
    // Pi defaults supportsLongCacheRetention to true; the declared false must reach the body.
    expect(JSON.parse(server.seen[0]!.body).prompt_cache_retention).not.toBe('24h');
  });

  it('runs a keyless (auth_mode none) profile with the fixed non-secret placeholder', async () => {
    const server = await provider(openAiReply);
    vi.stubEnv(PI_PROJECTED_KEY_ENV, SECRET);
    const { reply } = await completeThroughPi({
      adapter: 'openai_compatible', auth_mode: 'none', base_url: `http://127.0.0.1:${server.port}/v1`, model: 'local-model',
    });
    expect(reply.stopReason, reply.errorMessage).toBe('stop');
    expect(text(reply)).toBe('pong');
    expect(requests(server.seen)).toEqual(['POST /v1/chat/completions']);
    expect(server.seen[0]!.headers.authorization).toBe(`Bearer ${PI_AUTH_NONE_API_KEY}`);
    expect(JSON.stringify(server.seen)).not.toContain(SECRET);
  });
});
