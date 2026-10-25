import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModelRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly stream?: boolean;
  readonly model?: string;
}

/**
 * A local OpenAI-compatible endpoint for a real Hermes `custom` provider, so a
 * real turn makes no paid call. Every POST gets a chat completion whose text
 * is `reply` (streamed when the request asks for it), every GET gets a model
 * list. Each request is logged, so a protocol mismatch fails as an assertion
 * on the log, not as a hung turn.
 */
export async function startFakeModelEndpoint(model: string, reply: string) {
  const requests: FakeModelRequest[] = [];
  const body = (request: IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); } catch { resolve({}); }
    });
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const authorization = request.headers.authorization;
    if (request.method !== 'POST') {
      requests.push({ method: request.method ?? 'GET', path, ...(authorization === undefined ? {} : { authorization }) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'byok-test' }] }));
      return;
    }
    const parsed = await body(request);
    const stream = parsed.stream === true;
    requests.push({ method: 'POST', path, stream, ...(authorization === undefined ? {} : { authorization }), ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}) });
    const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
    const base = { id: 'byok-fake', created: 0, model };
    if (!stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
      return;
    }
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const chunk = { ...base, object: 'chat.completion.chunk' };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.end(
      frame({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })
      + frame({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      + frame({ ...chunk, choices: [], usage })
      + 'data: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
