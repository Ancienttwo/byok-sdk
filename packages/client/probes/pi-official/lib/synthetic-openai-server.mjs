/**
 * Controlled OpenAI-compatible endpoint for OP1 probes.
 *
 * Every response produced here is SYNTHETIC. No real provider is contacted, no
 * credential is used, and no model generation happens. The server exists so a
 * probe can observe the exact bytes a Pi session would put on the wire and can
 * prove that a refused request never arrives.
 */
import http from 'node:http';

/** Default script: answer a tool call once, then a final text reply. */
export function defaultScript(record, index) {
  const messages = Array.isArray(record.body?.messages) ? record.body.messages : [];
  const hasToolResult = messages.some((message) => message.role === 'tool');
  if (!hasToolResult && index === 0) {
    return { kind: 'tool_call', name: 'probe_echo', args: { text: 'ping' }, id: 'call_probe_1' };
  }
  return { kind: 'text', text: `pong:${index}` };
}

function chunk(delta, finishReason, extra = {}) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'probe-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  })}\n\n`;
}

/**
 * Start the synthetic endpoint on an ephemeral loopback port.
 *
 * @param {{ script?: (record: object, index: number) => object, label?: string }} [options]
 */
export async function startSyntheticOpenAI(options = {}) {
  const script = options.script ?? defaultScript;
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (data) => {
      body += data;
    });
    request.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        bodyText: body,
        body: parsed,
      };
      requests.push(record);

      let plan;
      try {
        plan = script(record, requests.length - 1);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: String(error) } }));
        return;
      }
      if (plan?.kind === 'error') {
        response.writeHead(plan.status ?? 500, { 'content-type': 'application/json' });
        response.end(JSON.stringify(plan.body ?? { error: { message: 'synthetic failure' } }));
        return;
      }
      if (plan?.kind === 'hold') {
        // Never answer: used to observe cancellation without producing bytes.
        return;
      }

      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (plan?.kind === 'tool_call') {
        response.write(chunk(
          {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: plan.id ?? 'call_probe_1',
              type: 'function',
              function: { name: plan.name ?? 'probe_echo', arguments: JSON.stringify(plan.args ?? {}) },
            }],
          },
          null,
        ));
        response.write(chunk({}, 'tool_calls'));
      } else {
        response.write(chunk({ role: 'assistant', content: plan?.text ?? 'pong' }, null));
        response.write(chunk({}, 'stop'));
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    /** Count only requests that actually reached the socket handler. */
    requestCount: () => requests.length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
